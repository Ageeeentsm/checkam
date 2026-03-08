// Check Am — /api/suggest  (autocomplete, 1-2 queries max)
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
let SERPAPI_KEY="";
function refreshKeys(){ SERPAPI_KEY=cleanKey(process.env.SERPAPI_KEY); }

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

async function serp(query, num=8){
  if(!SERPAPI_KEY) return {organic:[],kg:null};
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=${encodeURIComponent(query)}&num=${num}&engine=google&gl=ng&hl=en`;
    const {s,b}=await get(url,10000);
    if(s!==200||!b) return {organic:[],kg:null};
    const j=JSON.parse(b);
    return {
      organic:(j.organic_results||[]).map(r=>({title:r.title||"",snippet:r.snippet||"",link:r.link||"",source:(r.displayed_link||r.link||"").replace(/^https?:\/\//,"").split("/")[0]})),
      kg:j.knowledge_graph||null,
    };
  }catch(_){return {organic:[],kg:null};}
}

function cleanName(title){
  return title
    .replace(/\s*-\s*\d{3,9}\s*\(?Nigeria\)?.*$/i,"")
    .replace(/\s*-\s*OpenCorporates.*$/i,"")
    .replace(/\s*-\s*CAC.*$/i,"")
    .replace(/\s*-\s*Lagos.*$/i,"").replace(/\s*-\s*Abuja.*$/i,"")
    .replace(/\s*-\s*Contact.*$/i,"").replace(/\s*-\s*Phone.*$/i,"").replace(/\s*-\s*Email.*$/i,"")
    .replace(/\s*[|].*$/,"").replace(/\s+/g," ").trim();
}

function isValidName(name){
  if(!name || name.length<3 || name.length>80) return false;
  if(/^(list of|search|results|top \d|page \d|where is|what is|how to|companies in|businesses in)/i.test(name)) return false;
  if(/^(google|facebook|twitter|linkedin|wikipedia|youtube)/i.test(name)) return false;
  return true;
}

function extractRC(link, text){
  const urlM = link.match(/opencorporates\.com\/companies\/ng\/(\d+)/i);
  if(urlM) return "RC"+urlM[1];
  const textM = text.match(/\bRC\s*(\d{4,8})\b/i);
  if(textM) return "RC"+textM[1];
  return "";
}

module.exports = async function handler(req,res){
  refreshKeys();
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const q = (req.query?.q||"").trim();
  if(!q||q.length<2) return res.status(200).json({suggestions:[]});

  const isRC = /^(RC\s*)?\d{4,8}$/i.test(q);
  const rcNum = isRC ? q.replace(/^RC\s*/i,"") : "";
  const isIndividual = req.query?.type==="individual";

  let query;
  if(isRC){
    query = `"RC${rcNum}" Nigeria company`;
  } else if(isIndividual){
    query = `"${q}" Nigeria director chairman CEO "managing director" company`;
  } else {
    // Company search — target CAC registry sources
    query = `"${q}" Nigeria company CAC registered site:opencorporates.com/companies/ng OR "${q}" Nigeria company RC`;
  }

  const {organic, kg} = await serp(query, 8);
  const results = [];
  const seen = new Set();

  // KG is highest confidence
  if(kg?.title){
    const name = cleanName(kg.title);
    if(isValidName(name) && !seen.has(name.toLowerCase())){
      seen.add(name.toLowerCase());
      results.push({
        label: name,
        sublabel: (kg.description||"").substring(0,80),
        value: name,
        rc: extractRC("", kg.description||""),
        type: isIndividual?"individual":"company",
        source: "CAC",
        score: 100
      });
    }
  }

  for(const r of organic){
    const link = r.link||"";
    const title = r.title||"";
    const snip = r.snippet||"";
    const name = cleanName(title);

    if(!isValidName(name)) continue;
    if(seen.has(name.toLowerCase())) continue;

    // For RC search: verify this result is actually about our RC
    if(isRC){
      const hasRC = (title+snip).includes(rcNum) || link.includes("/"+rcNum);
      if(!hasRC) continue;
    } else {
      // For name search: name must contain query or snippet must
      const qLow = q.toLowerCase();
      const nameLow = name.toLowerCase();
      if(!nameLow.includes(qLow) && !snip.toLowerCase().includes(qLow)) continue;
    }

    // Skip known directory/spam sites
    if(/businesslist\.com\.ng|naijafirms|vconnect|yellow.*pages|cylex/i.test(link)) continue;

    const rc = extractRC(link, title+" "+snip);
    const status = (title+snip).match(/\b(ACTIVE|INACTIVE|STRUCK OFF|DISSOLVED)\b/i)?.[1]||"";

    let score=50, source="Web";
    if(link.includes("opencorporates.com/companies/ng")){score=95;source="CAC";}
    else if(link.includes("companiesng.com")){score=85;source="CAC";}
    else if(link.includes("search.cac.gov.ng")){score=90;source="CAC";}
    else if(link.includes("linkedin.com")){score=70;source="LinkedIn";}

    seen.add(name.toLowerCase());
    results.push({
      label: name,
      sublabel: status ? `${status} • ${r.source}` : r.source,
      value: name,
      rc: rc||"",
      type: isIndividual?"individual":"company",
      source,
      score,
    });

    if(results.length>=6) break;
  }

  results.sort((a,b)=>b.score-a.score);
  return res.status(200).json({suggestions:results.slice(0,6)});
};
