// Check Am — /api/chat v4.1
// 2 short queries per entity scan, smart lock-in, Claude answers everything
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
let ANTHROPIC_KEY="",SERPAPI_KEY="";
function refreshKeys(){
  ANTHROPIC_KEY=cleanKey(process.env.ANTHROPIC_API_KEY);
  SERPAPI_KEY  =cleanKey(process.env.SERPAPI_KEY);
}

function get(url,ms=12000){
  return new Promise(resolve=>{
    try{
      const req=https.get(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"text/html,application/json,*/*"}},(res)=>{
        let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({s:res.statusCode,b}));
      });
      req.on("error",()=>resolve({s:0,b:""}));
      req.setTimeout(ms,()=>{req.destroy();resolve({s:0,b:""});});
    }catch(_){resolve({s:0,b:""});}
  });
}

function postJson(hostname,path,body,hdrs={}){
  return new Promise((resolve,reject)=>{
    const buf=Buffer.from(JSON.stringify(body));
    const req=https.request({hostname,path,method:"POST",headers:{"Content-Type":"application/json","Content-Length":buf.length,...hdrs}},(res)=>{
      let raw="";res.on("data",c=>raw+=c);res.on("end",()=>{try{resolve(JSON.parse(raw));}catch{resolve({});}});
    });
    req.on("error",reject);req.setTimeout(35000,()=>{req.destroy();reject(new Error("timeout"));});
    req.write(buf);req.end();
  });
}

async function serp(query,num=8){
  if(!SERPAPI_KEY) return [];
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=${encodeURIComponent(query)}&num=${num}&engine=google&gl=ng&hl=en`;
    const {s,b}=await get(url,12000);
    if(s!==200||!b) return [];
    const j=JSON.parse(b);
    const kg=j.knowledge_graph;
    const kgText=kg?`[KG] ${kg.title||""} — ${kg.description||""} | phone:${kg.phone||""} | address:${kg.address||""} | website:${kg.website||""} | founded:${kg.founded||""}`:"";
    const organic=(j.organic_results||[]).map(r=>`[${(r.displayed_link||r.link||"").replace(/^https?:\/\//,"").split("/")[0]}] ${r.title} — ${r.snippet}`);
    return [kgText,...organic].filter(Boolean);
  }catch(_){return [];}
}

// Smart entity detection
function detectEntity(msg,history){
  const m=msg.trim();
  // RC number
  const rcM=m.match(/\b(RC\s*\d{4,8})\b/i);
  if(rcM) return {entity:rcM[1].replace(/\s+/g,"").toUpperCase(),type:"company",followUp:false};
  // Explicit investigation phrases
  const invPat=/(?:search|check|look up|investigate|find out about|tell me about|who is|what is|run.*check.*on|analyse?|give me.*on|profile)\s+["']?([A-Z][a-zA-Z &.,'-]{2,55})["']?/i;
  const inv=m.match(invPat);
  if(inv){
    const name=inv[1].trim().replace(/[.?!,]+$/,"");
    if(name.length>2&&name.length<60){
      const isComp=/\b(limited|ltd|plc|group|company|bank|holdings|enterprises?|industries|services|nigeria)\b/i.test(name);
      return {entity:name,type:isComp?"company":"auto",followUp:false};
    }
  }
  // Quoted entity
  const qPat=/["'"]([A-Z][a-zA-Z &.,'-]{3,55})["'"]/;
  const qm=m.match(qPat);
  if(qm){
    const name=qm[1].trim();
    const isComp=/\b(limited|ltd|plc|group|company|bank|holdings)\b/i.test(name);
    return {entity:name,type:isComp?"company":"auto",followUp:false};
  }
  // Follow-up on locked entity
  const locked=history.slice().reverse().find(h=>h.lockedEntity)?.lockedEntity;
  if(locked&&/\b(he|she|they|it|their|his|her|the company|this|further|also|and)\b/i.test(m)){
    return {...locked,followUp:true};
  }
  return null;
}

async function quickIntel(entity,type){
  const isComp=type!=="individual";
  const bare=entity.replace(/\s*(limited|ltd\.?|plc)\s*$/i,"").trim();
  const [profile,enforcement]=await Promise.all([
    serp(`"${entity}" nigeria`,10),
    serp(`"${bare}" EFCC OR ICPC OR fraud OR arrested OR court nigeria`,8),
  ]);
  return {
    entity,type,
    raw:[...profile,...enforcement].join("\n"),
  };
}

async function callClaude(messages,system){
  const resp=await postJson("api.anthropic.com","/v1/messages",{
    model:"claude-sonnet-4-20250514",max_tokens:800,system,
    messages:messages.slice(-10).map(h=>({role:h.role,content:String(h.content||h.text||"")})),
  },{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"});
  if(resp.error) throw new Error(resp.error.message);
  return resp.content?.[0]?.text||"";
}

module.exports=async function handler(req,res){
  refreshKeys();
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  if(!ANTHROPIC_KEY) return res.status(503).json({error:"ANTHROPIC_API_KEY not configured."});

  const {message,history=[]}=req.body||{};
  if(!message) return res.status(400).json({error:"No message"});

  try{
    const detected=detectEntity(message,history);
    let intel=null,lockedEntity=null;

    if(detected&&!detected.followUp){
      intel=await quickIntel(detected.entity,detected.type==="auto"?"company":detected.type);
      lockedEntity={entity:detected.entity,type:detected.type==="auto"?"company":detected.type};
    } else if(detected?.followUp){
      lockedEntity=detected;
      const prev=history.slice().reverse().find(h=>h._intel)?._intel;
      intel=prev||await quickIntel(detected.entity,detected.type);
    }

    const sys=`You are Check Am, Nigeria's premier business intelligence analyst. Sharp, authoritative, professional — like a seasoned financial investigator briefing a client.

${intel?`LIVE INTELLIGENCE for "${intel.entity}":
${intel.raw}

Extract and present specific facts from the above data. Mention real names, RC numbers, addresses, dates, amounts. If EFCC/ICPC/court records appear in the snippets, highlight them prominently. If nothing concerning found, confirm that clearly.`:"Answer the user's due diligence or business intelligence question about Nigeria."}

STYLE: Use **bold** for key findings. Be direct and specific. Max 8 sentences for new entity briefings, 3-4 for follow-ups. Never say "I cannot confirm" or "limited information" — report what's in the data and note confidence level. Never mention AI, Claude, or APIs.`;

    const msgs=[
      ...history.slice(-8).map(h=>({role:h.role,content:String(h.content||h.text||"")})),
      {role:"user",content:intel&&!detected?.followUp?`Brief me on: ${detected.entity}\n\nUser: ${message}`:message},
    ];

    const text=await callClaude(msgs,sys);
    return res.status(200).json({text,lockedEntity,_intel:intel?{entity:intel.entity,type:intel.type,raw:intel.raw}:null,scanning:!!(intel&&!detected?.followUp)});
  }catch(e){
    console.error("Chat error:",e.message);
    return res.status(500).json({error:e.message});
  }
};
