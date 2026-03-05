// Check Am — /api/chat
const https=require("https");

function sanitizeKey(raw){
  if(!raw)return"";
  return Buffer.from(raw,"utf8").toString("utf8").replace(/[^a-zA-Z0-9\-_]/g,"").trim();
}
const API_KEY=sanitizeKey(process.env.ANTHROPIC_API_KEY||"");

function callAnthropic(messages){
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({
      model:"claude-sonnet-4-20250514",
      max_tokens:900,
      system:`You are Check Am, Nigeria's premier business intelligence and due diligence platform.
You help users investigate Nigerian companies and individuals before doing business with them.
You have access to CAC corporate registry, regulatory records (EFCC, CBN, SEC, FIRS), media archives, and network analysis.
Be direct, professional, and intelligence-focused. Use **bold** for key findings and structure your response clearly.
Never mention AI, Claude, Anthropic, or any technical systems. Present all findings as Check Am proprietary intelligence.`,
      messages,
    });
    const req=https.request({
      hostname:"api.anthropic.com",
      path:"/v1/messages",
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key":API_KEY,
        "anthropic-version":"2023-06-01",
        "Content-Length":Buffer.byteLength(body),
      },
    },(res)=>{
      let raw="";
      res.on("data",c=>raw+=c);
      res.on("end",()=>{
        try{
          const p=JSON.parse(raw);
          if(p.error)return reject(new Error(p.error.message));
          resolve(p.content?.[0]?.text||"Analysis complete.");
        }catch(e){reject(e);}
      });
    });
    req.on("error",reject);
    req.setTimeout(28000,()=>{req.destroy();reject(new Error("timeout"));});
    req.write(body);req.end();
  });
}

module.exports=async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS")return res.status(200).end();
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
  if(!API_KEY)return res.status(503).json({error:"ANTHROPIC_API_KEY not set in Vercel Environment Variables."});

  const{message,history=[]}=req.body||{};
  if(!message)return res.status(400).json({error:"No message"});

  const messages=[
    ...history.slice(-8).map(h=>({role:h.role,content:h.content})),
    {role:"user",content:message},
  ];

  try{
    const text=await callAnthropic(messages);
    return res.status(200).json({text});
  }catch(e){
    return res.status(500).json({error:e.message});
  }
};
