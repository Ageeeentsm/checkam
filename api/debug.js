// Check Am — /api/debug
const https = require("https");
function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}

function get(url,ms=10000){
  return new Promise(resolve=>{
    try{
      const req=https.get(url,{headers:{"User-Agent":"Mozilla/5.0"}},(res)=>{
        let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({s:res.statusCode,b}));
      });
      req.on("error",()=>resolve({s:0,b:""}));
      req.setTimeout(ms,()=>{req.destroy();resolve({s:0,b:""});});
    }catch(_){resolve({s:0,b:""});}
  });
}

module.exports = async function handler(req,res){
  const SERPAPI_KEY=cleanKey(process.env.SERPAPI_KEY);
  const ANTHROPIC_KEY=cleanKey(process.env.ANTHROPIC_API_KEY);
  const MAPBOX_TOKEN=cleanKey(process.env.MAPBOX_TOKEN);

  const env={
    ANTHROPIC_API_KEY: ANTHROPIC_KEY?`✅ (${ANTHROPIC_KEY.length} chars)`:"❌ NOT SET",
    SERPAPI_KEY: SERPAPI_KEY?`✅ (${SERPAPI_KEY.length} chars) — ${SERPAPI_KEY.substring(0,8)}...`:"❌ NOT SET",
    MAPBOX_TOKEN: MAPBOX_TOKEN?`✅ (${MAPBOX_TOKEN.length} chars)`:"⚠ not set (optional)",
  };

  let serpTest="⏳ not tested", serpError="";
  if(SERPAPI_KEY){
    try{
      const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=Dangote+Nigeria&num=3&engine=google&gl=ng`;
      const {s,b}=await get(url,10000);
      if(s===200&&b){
        const j=JSON.parse(b);
        if(j.organic_results?.length) serpTest=`✅ WORKING — ${j.organic_results[0].title.substring(0,40)}`;
        else if(j.error) {serpTest="❌ SERPAPI ERROR";serpError=j.error;}
        else serpTest="⚠ No results";
      } else serpTest=`❌ HTTP ${s}`;
    }catch(e){serpTest="❌ Exception";serpError=e.message;}
  }

  const status = SERPAPI_KEY && serpTest.startsWith("✅") ? "ALL GOOD" : "BROKEN";
  res.status(200).json({
    status, env_vars:env,
    serpapi_test:serpTest, serpapi_error:serpError||undefined,
    architecture:"v10 — 3 queries per search (was 29). Smart Claude synthesis.",
    search_engines:["SerpApi ✅ primary"],
  });
};
