const https = require("https");
function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}

module.exports = function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin","*");
  response.setHeader("Content-Type","application/json");

  const ANTHROPIC = cleanKey(process.env.ANTHROPIC_API_KEY);
  const SERPAPI   = cleanKey(process.env.SERPAPI_KEY);
  const BING_KEY  = cleanKey(process.env.BING_API_KEY);
  const MAPBOX    = cleanKey(process.env.MAPBOX_TOKEN);

  const env_vars = {
    ANTHROPIC_API_KEY: ANTHROPIC ? `✅ (${ANTHROPIC.length} chars)` : "❌ MISSING",
    SERPAPI_KEY:       SERPAPI   ? `✅ (${SERPAPI.length} chars) — ${SERPAPI.substring(0,8)}...` : "❌ MISSING",
    BING_API_KEY:      BING_KEY  ? `✅ (${BING_KEY.length} chars)`  : "⚠ not set (optional)",
    MAPBOX_TOKEN:      MAPBOX    ? `✅ (${MAPBOX.length} chars)`    : "❌ MISSING",
  };

  if(!SERPAPI){
    response.status(200).end(JSON.stringify({status:"❌ MISSING SERPAPI_KEY",env_vars},null,2));
    return;
  }

  const url=`https://serpapi.com/search.json?api_key=${SERPAPI}&q=dangote+nigeria+business&num=2&engine=google&gl=ng`;
  https.get(url,{headers:{"Accept":"application/json"}},(gres)=>{
    let body="";
    gres.on("data",c=>body+=c);
    gres.on("end",()=>{
      let test="",error="";
      try{
        const j=JSON.parse(body);
        if(j.error)                        { test="❌ SERPAPI ERROR"; error=j.error; }
        else if(j.organic_results?.length)   test=`✅ WORKING — "${j.organic_results[0].title.substring(0,60)}"`;
        else                                 test="✅ API live";
      }catch(e){test="❌ PARSE ERROR";error=body.substring(0,300);}
      response.status(200).end(JSON.stringify({
        status: test.includes("✅") ? "ALL GOOD" : "BROKEN",
        env_vars,
        serpapi_test: test,
        serpapi_error: error||undefined,
        search_engines: [
          SERPAPI  ? "SerpApi ✅ primary"   : "SerpApi ❌ missing",
          BING_KEY ? "Bing ✅ parallel"     : "Bing ⚠ optional — add BING_API_KEY",
        ],
        sources_indexed: 88,
      },null,2));
    });
  }).on("error",e=>{
    response.status(200).end(JSON.stringify({status:"NETWORK ERROR",env_vars,serpapi_test:"❌ "+e.message},null,2));
  });
};
