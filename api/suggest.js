// Check Am — /api/suggest v7  
// Key insight: Simple short queries → better Google results + KG hits
// Two parallel queries, merge and dedupe, smart name extraction
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
let SERPAPI_KEY="";
function refreshKeys(){ SERPAPI_KEY=cleanKey(process.env.SERPAPI_KEY); }

function get(url,ms=10000){
  return new Promise(resolve=>{
    try{
      const req=https.get(url,{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}},(res)=>{
        let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({s:res.statusCode,b}));
      });
      req.on("error",()=>resolve({s:0,b:""}));
      req.setTimeout(ms,()=>{req.destroy();resolve({s:0,b:""});});
    }catch(_){resolve({s:0,b:""});}
  });
}

async function serpSearch(query, num=8){
  if(!SERPAPI_KEY) return {organic:[],kg:null};
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=${encodeURIComponent(query)}&num=${num}&engine=google&gl=ng&hl=en`;
    const {s,b}=await get(url);
    if(s!==200||!b) return {organic:[],kg:null};
    const j=JSON.parse(b);
    return {
      organic:(j.organic_results||[]).map(r=>({
        title:r.title||"",
        snippet:r.snippet||"",
        link:r.link||"",
        source:(r.displayed_link||r.link||"").replace(/^https?:\/\//,"").split("/")[0],
      })),
      kg:j.knowledge_graph||null,
    };
  }catch(_){return {organic:[],kg:null};}
}

// Extract clean company name from various source title formats
function extractName(title, link){
  let name = title;
  // OpenCorporates: "COMPANY NAME - 123456 (Nigeria) - OpenCorporates"
  if(link.includes("opencorporates.com")){
    name = title.replace(/\s*[-–]\s*\d{3,9}\s*\(?\w*\)?.*$/,"").replace(/\s*[-–]\s*OpenCorporates.*$/,"").trim();
  }
  // companiesng: "COMPANY NAME - RC123456 | companiesng.com" or "COMPANY NAME RC123456"
  else if(link.includes("companiesng.com")){
    name = title.replace(/\s*[-–|]\s*(RC\d+|rc-\d+).*$/i,"").replace(/\s*[|].*$/,"").trim();
  }
  // rc-number.com: "RC123456 - COMPANY NAME" 
  else if(link.includes("rc-number.com")){
    name = title.replace(/^RC\d+\s*[-–]\s*/i,"").replace(/\s*[-–]\s*Nigeria.*$/i,"").trim();
  }
  // General cleanup
  name = name
    .replace(/\s*[-–]\s*(Lagos|Abuja|Nigeria|Kano|Port Harcourt|Ibadan|Enugu).*$/i,"")
    .replace(/\s*[-–]\s*(Contact|Phone|Email|Address|Registration).*$/i,"")
    .replace(/\s*[|].*$/,"")
    .replace(/\s*\|\s*.*$/,"")
    .trim();
  return name;
}

function isPlausibleName(name){
  if(!name || name.length < 3 || name.length > 90) return false;
  // Reject generic/spam titles
  if(/^(list of|search results?|page \d|companies in|businesses in|find|home|about|contact|services|welcome)/i.test(name)) return false;
  if(/^(google|facebook|twitter|linkedin|instagram|youtube|wikipedia)/i.test(name)) return false;
  if(/^(www\.|http)/i.test(name)) return false;
  // Must have at least one letter
  if(!/[a-zA-Z]{2,}/.test(name)) return false;
  return true;
}

function extractRC(link, title, snippet){
  // From OC URL: opencorporates.com/companies/ng/177064
  const urlM = (link||"").match(/opencorporates\.com\/companies\/ng\/(\d+)/i);
  if(urlM) return "RC"+urlM[1];
  // From companiesng URL: /company/rc-1957147
  const cngM = (link||"").match(/\/company\/rc[-]?(\d+)/i);
  if(cngM) return "RC"+cngM[1];
  // From text
  const textM = (title+" "+snippet).match(/\bRC[\s-]?(\d{4,8})\b/i);
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
  if(!q || q.length<2) return res.status(200).json({suggestions:[]});
  if(!SERPAPI_KEY) return res.status(200).json({suggestions:[]});

  const isRC = /^(RC\s*)?\d{4,8}$/i.test(q);
  const rcNum = isRC ? q.replace(/^RC\s*/i,"") : "";
  const isIndividual = req.query?.type==="individual";
  const qLow = q.toLowerCase();

  let qA, qB;

  if(isRC){
    // For RC numbers: two targeted queries
    qA = `RC${rcNum} site:opencorporates.com/companies/ng`;
    qB = `RC${rcNum} nigeria company registered`;
  } else if(isIndividual){
    qA = `"${q}" nigeria`;
    qB = `"${q}" nigeria director company`;
  } else {
    // Company name: OC registry first (most accurate), then general Nigeria
    qA = `${q} site:opencorporates.com/companies/ng`;
    qB = `${q} nigeria company`;
  }

  // Run both queries in parallel
  const [resA, resB] = await Promise.all([
    serpSearch(qA, 8),
    serpSearch(qB, 6),
  ]);

  const suggestions = [];
  const seen = new Set();

  function addSuggestion(name, rc, source, score, sublabel, type, value){
    const key = name.toLowerCase().replace(/\s+/g,"");
    if(seen.has(key)) return;
    if(!isPlausibleName(name)) return;
    seen.add(key);
    suggestions.push({
      label: name,
      sublabel: sublabel||"",
      value: value||name,
      rc: rc||"",
      type: type||(isIndividual?"individual":"company"),
      source,
      score,
    });
  }

  // 1. Knowledge Graph — highest confidence (Google's structured entity data)
  const kg = resA.kg || resB.kg;
  if(kg?.title){
    const name = extractName(kg.title, "");
    if(isPlausibleName(name)){
      const rc = extractRC("", kg.title||"", kg.description||"");
      const sub = kg.description ? kg.description.substring(0,70) : (kg.type||"");
      addSuggestion(name, rc, "Verified", 100, sub, isIndividual?"individual":"company");
    }
  }

  // 2. OpenCorporates results (from qA) — very reliable, title = company name
  for(const r of (resA.organic||[])){
    const link = r.link||"";
    const isOC = link.includes("opencorporates.com/companies/ng");
    const isCNG = link.includes("companiesng.com");
    
    if(!isOC && !isCNG && !isRC) continue; // For name searches, only use registry sources from qA
    
    const name = extractName(r.title, link);
    if(!isPlausibleName(name)) continue;

    // For RC search: verify this result is about our specific RC
    if(isRC){
      const resultRC = extractRC(link, r.title, r.snippet);
      const hasNum = (r.title+" "+r.snippet+" "+link).includes(rcNum);
      if(!hasNum && resultRC !== "RC"+rcNum) continue;
    } else {
      // For name search: name must contain query text
      if(!name.toLowerCase().includes(qLow) && !r.snippet.toLowerCase().includes(qLow)) continue;
    }

    const rc = extractRC(link, r.title, r.snippet);
    const statusM = (r.title+" "+r.snippet).match(/\b(Active|Inactive|Struck Off|Dissolved)\b/i);
    const status = statusM ? statusM[1] : "";
    const score = isOC ? 92 : isCNG ? 85 : 75;
    const sub = [status, rc].filter(Boolean).join(" · ");
    addSuggestion(name, rc, isOC?"CAC/OpenCorporates":"CAC Registry", score, sub);
    if(suggestions.length >= 4) break;
  }

  // 3. General Nigeria results (from qB) — for well-known companies + individuals
  for(const r of (resB.organic||[])){
    if(suggestions.length >= 6) break;
    const link = r.link||"";
    // Skip spam/directory sites
    if(/businesslist\.com\.ng|naijafirms\.com|vconnect\.com|yellowpages|cylex|yelp/i.test(link)) continue;
    // Skip social media
    if(/facebook\.com|instagram\.com|twitter\.com|tiktok\.com/i.test(link)) continue;
    
    const name = extractName(r.title, link);
    if(!isPlausibleName(name)) continue;
    
    const nameLow = name.toLowerCase();
    if(!nameLow.includes(qLow) && !r.snippet.toLowerCase().includes(qLow)) continue;

    const rc = extractRC(link, r.title, r.snippet);
    const isOfficialSite = /\.gov\.ng|cac\.gov|sec\.gov|cbn\.gov|ngxgroup/i.test(link);
    const isLegitBiz = /businessday\.ng|nairametrics|proshareng|ngxgroup|businessamlive/i.test(link);
    const isLinkedIn = link.includes("linkedin.com");
    
    let score = 55;
    if(isOfficialSite) score = 88;
    else if(isLegitBiz) score = 70;
    else if(isLinkedIn) score = 65;
    
    const sub = rc ? rc : r.source;
    addSuggestion(name, rc, isOfficialSite?"Official":"Web", score, sub);
  }

  suggestions.sort((a,b) => b.score - a.score);
  return res.status(200).json({suggestions: suggestions.slice(0,6)});
};
