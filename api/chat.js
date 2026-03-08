// Check Am — /api/chat v4.0 — Smart 2-query chat with entity lock-in
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
let ANTHROPIC_KEY="", SERPAPI_KEY="";
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
    return (j.organic_results||[]).map(r=>({title:r.title||"",snippet:r.snippet||"",link:r.link||"",source:(r.displayed_link||r.link||"").replace(/^https?:\/\//,"").split("/")[0],date:r.date||""}));
  }catch(_){return [];}
}

// 2-query quick intel scan for chat
async function quickIntel(entity, type){
  const isCompany = type==="company";
  const [profile, enforcement] = await Promise.all([
    serp(`"${entity}" Nigeria ${isCompany?"RC number directors address":"role company position"} CAC`, 8),
    serp(`"${entity}" Nigeria EFCC ICPC fraud arrested charged court news 2023 2024 2025`, 8),
  ]);

  const allText = [...profile,...enforcement].map(r=>`[${r.source}] ${r.title} — ${r.snippet}`).join("\n");

  return {
    entity, type,
    profile_results: profile,
    enforcement_results: enforcement,
    raw: allText,
  };
}

// Detect if user is asking about a new entity
function detectEntity(message, history){
  const msg = message.trim();
  // Check for RC number
  const rcM = msg.match(/\b(RC\s*\d{4,8})\b/i);
  if(rcM) return {entity: rcM[1].replace(/\s/g,""), type:"company", followUp:false};

  // Common investigation phrases
  const patterns=[
    /(?:search|check|look up|investigate|find|tell me about|who is|what is|run a check on|analyse?|profile)\s+["']?([A-Z][a-zA-Z\s&.,'-]{2,50})["']?/i,
    /^(?:what about|and|also check)\s+["']?([A-Z][a-zA-Z\s&.,'-]{2,50})["']?/i,
    /["']([A-Z][a-zA-Z\s&.,'-]{4,50})["']/,
  ];
  for(const p of patterns){
    const m=msg.match(p);
    if(m){
      const name=m[1].trim().replace(/[.?!,]+$/,"");
      if(name.length>3 && name.length<60){
        const isCompany=/\b(limited|ltd|plc|group|company|bank|nig\.|holdings|enterprises?|industries|services)\b/i.test(name);
        return {entity:name, type:isCompany?"company":"auto", followUp:false};
      }
    }
  }
  // Follow-up question (has history with a locked entity)
  const locked = extractLockedEntity(history);
  if(locked && /\b(he|she|they|it|their|his|her|the company|the person|this)\b/i.test(msg)){
    return {...locked, followUp:true};
  }
  return null;
}

function extractLockedEntity(history){
  for(let i=history.length-1;i>=0;i--){
    const h=history[i];
    if(h.lockedEntity) return h.lockedEntity;
  }
  return null;
}

async function callClaude(messages, system){
  const resp=await postJson("api.anthropic.com","/v1/messages",{
    model:"claude-sonnet-4-20250514",
    max_tokens:800,
    system,
    messages: messages.slice(-10).map(h=>({role:h.role,content:h.content||h.text||""})),
  },{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"});
  if(resp.error) throw new Error(resp.error.message);
  return resp.content?.[0]?.text||"";
}

module.exports = async function handler(req,res){
  refreshKeys();
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  if(!ANTHROPIC_KEY) return res.status(503).json({error:"ANTHROPIC_API_KEY not configured."});

  const {message, history=[]} = req.body||{};
  if(!message) return res.status(400).json({error:"No message"});

  try{
    const detected = detectEntity(message, history);
    let intel = null;
    let lockedEntity = null;

    if(detected && !detected.followUp){
      intel = await quickIntel(detected.entity, detected.type==="auto"?"company":detected.type);
      lockedEntity = {entity:detected.entity, type:detected.type==="auto"?"company":detected.type};
    } else if(detected?.followUp){
      const prev = extractLockedEntity(history);
      if(prev){
        lockedEntity = prev;
        // Try to reuse intel from recent history
        const cachedH = history.slice().reverse().find(h=>h.role==="assistant"&&h._intel);
        intel = cachedH?._intel || await quickIntel(prev.entity, prev.type);
      }
    }

    const systemPrompt = `You are Check Am, Nigeria's premier business intelligence analyst. You speak in a sharp, authoritative, professional tone like a seasoned financial investigator.

${intel ? `LIVE INTELLIGENCE DATA for "${intel.entity}":
${intel.raw}

Based on these search results, provide specific, factual intelligence. Extract real names, dates, amounts, addresses from the snippets above. If enforcement or fraud records are mentioned, highlight them clearly. If nothing concerning is found, confirm that.` : `You are answering a general due diligence or business intelligence question about Nigeria. Be helpful, specific, and professional.`}

RULES:
- Be specific and factual — cite real sources (punchng.com, vanguardngr.com, etc.) when you can
- Use **bold** for key findings, names, amounts
- Never mention AI, Claude, Anthropic, or APIs
- Never say "I don't have information" — work with what's available and be transparent about confidence
- Keep responses concise: 3-6 sentences for follow-ups, up to 10 for new entity scans`;

    const msgs=[
      ...history.slice(-8).map(h=>({role:h.role,content:h.content||h.text||""})),
      {role:"user",content: intel&&!detected?.followUp ? `Run intelligence check on: ${detected.entity}\n\nUser asked: ${message}` : message},
    ];

    const text = await callClaude(msgs, systemPrompt);

    return res.status(200).json({
      text,
      lockedEntity,
      _intel: intel ? {entity:intel.entity,type:intel.type,raw:intel.raw} : null,
      scanning: !!(intel && !detected?.followUp),
    });
  }catch(e){
    console.error("Chat error:",e.message);
    return res.status(500).json({error:e.message});
  }
};
