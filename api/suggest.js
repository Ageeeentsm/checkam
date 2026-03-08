// Check Am — /api/suggest
// Autocomplete: CAC name search + RC number + Google entity resolution
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
let SERPAPI_KEY="";
function refreshKeys(){
  SERPAPI_KEY=cleanKey(process.env.SERPAPI_KEY);
}

function get(url,ms=8000){
  return new Promise(resolve=>{
    try{
      const req=https.get(url,{headers:{"User-Agent":"Mozilla/5.0 Chrome/120","Accept":"application/json,text/html,*/*"}},(res)=>{
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location)
          return get(res.headers.location,ms).then(resolve);
        let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({s:res.statusCode,b}));
      });
      req.on("error",()=>resolve({s:0,b:""}));
      req.setTimeout(ms,()=>{req.destroy();resolve({s:0,b:""});});
    }catch(_){resolve({s:0,b:""});}
  });
}

// Try multiple CAC endpoints
async function cacSearch(query, isRC) {
  const results = [];
  try {
    // CAC public search endpoints
    const endpoints = isRC ? [
      `https://search.cac.gov.ng/home/searchByRC?rc=${encodeURIComponent(query)}`,
      `https://search.cac.gov.ng/home/searchSimilarBusiness?name=${encodeURIComponent(query)}`,
    ] : [
      `https://search.cac.gov.ng/home/searchSimilarBusiness?name=${encodeURIComponent(query)}`,
      `https://search.cac.gov.ng/home/searchNameAvailability?name=${encodeURIComponent(query)}`,
    ];

    for (const url of endpoints) {
      const {s,b} = await get(url);
      if(s !== 200 || !b) continue;
      try {
        const j = JSON.parse(b);
        const records = j.data || j.results || j.nameAvailability || (Array.isArray(j) ? j : []);
        records.slice(0,8).forEach(r => {
          const name = r.company_name || r.CompanyName || r.name || "";
          const rc   = r.rc_number   || r.RcNumber   || r.rc  || "";
          const status = r.status || r.CompanyStatus || "Active";
          if(name && !results.find(x=>x.rc===rc)) {
            results.push({
              name, rc, status,
              type: r.company_type || r.CompanyType || "Company",
              address: r.address || r.RegisteredAddress || "",
              incorporated: r.date_of_incorporation || r.DateOfIncorporation || "",
              source: "CAC"
            });
          }
        });
        if(results.length) break;
      } catch(_){}
    }
  } catch(_){}
  return results;
}

// Google entity resolution — find full name/RC when user is vague
async function googleResolve(query) {
  if(!SERPAPI_KEY) return [];
  try {
    const q = `"${query}" Nigeria company CAC RC number registered`;
    const url = `https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=${encodeURIComponent(q)}&num=5&engine=google&gl=ng`;
    const {s,b} = await get(url);
    if(s !== 200) return [];
    const j = JSON.parse(b);
    const items = j.organic_results || j.items || [];
    return items.map(item => {
      const text = (item.title||"") + " " + (item.snippet||"");
      const rcMatch = text.match(/RC[\s\-:]?(\d{4,8})/i) || text.match(/(\d{6,8})/);
      return {
        name: (item.title||"").replace(/ - CAC.*$/i,"").replace(/ \| .*$/,"").trim(),
        rc: rcMatch ? "RC" + rcMatch[1] : "",
        snippet: item.snippet,
        url: item.link,
        source: "Google"
      };
    }).filter(r => r.name.length > 2);
  } catch(_){ return []; }
}

// Director search
async function cacDirectorSearch(query) {
  const results = [];
  try {
    const url = `https://search.cac.gov.ng/home/searchDirector?name=${encodeURIComponent(query)}`;
    const {s,b} = await get(url);
    if(s === 200 && b) {
      const j = JSON.parse(b);
      const records = j.data || j.results || (Array.isArray(j) ? j : []);
      records.slice(0,6).forEach(r => {
        const name = r.director_name || r.name || r.DirectorName || "";
        const companies = r.companies || [];
        if(name) results.push({
          name,
          companies: companies.map(c=>c.company_name||c.CompanyName||c).filter(Boolean).slice(0,3),
          source: "CAC Director"
        });
      });
    }
  } catch(_){}
  return results;
}

module.exports = async function handler(req, res) {
  refreshKeys();
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const q = (req.query?.q || "").trim();
  const type = req.query?.type || "company"; // company | individual

  if(q.length < 2) return res.status(200).json({suggestions:[]});

  // Detect if it's an RC number query
  const isRC = /^(RC\s*)?(\d{4,8})$/i.test(q);

  try {
    let suggestions = [];

    if(type === "individual") {
      const [dirResults, googleRes] = await Promise.all([
        cacDirectorSearch(q),
        googleResolve(`${q} director Nigeria`),
      ]);
      dirResults.forEach(d => {
        suggestions.push({
          label: d.name,
          sublabel: d.companies.length ? `Director of: ${d.companies.join(", ")}` : "Individual",
          type: "individual",
          source: d.source,
          value: d.name,
        });
      });
      // Add Google suggestions for individuals
      googleRes.slice(0,3).forEach(g => {
        if(!suggestions.find(s=>s.value.toLowerCase()===g.name.toLowerCase())) {
          suggestions.push({
            label: g.name,
            sublabel: g.snippet?.substring(0,80) || "Found via web search",
            type: "individual",
            source: "Web",
            value: g.name,
          });
        }
      });
    } else {
      // Company search
      const [cacResults, googleRes] = await Promise.all([
        cacSearch(q, isRC),
        isRC ? Promise.resolve([]) : googleResolve(q),
      ]);

      cacResults.forEach(r => {
        suggestions.push({
          label: r.name,
          sublabel: `${r.rc ? "RC " + r.rc + " · " : ""}${r.status} · ${r.type}${r.incorporated ? " · Inc. " + r.incorporated.substring(0,4) : ""}`,
          type: "company",
          source: "CAC",
          value: r.name,
          rc: r.rc,
          status: r.status,
          address: r.address,
        });
      });

      // Fill with Google results if CAC returned nothing
      if(suggestions.length < 3) {
        googleRes.slice(0, 5 - suggestions.length).forEach(g => {
          if(!suggestions.find(s=>s.value.toLowerCase()===g.name.toLowerCase())) {
            suggestions.push({
              label: g.name,
              sublabel: g.rc ? `RC ${g.rc} · Found via web search` : g.snippet?.substring(0,80) || "Found via web search",
              type: "company",
              source: "Web",
              value: g.name,
              rc: g.rc || "",
            });
          }
        });
      }
    }

    return res.status(200).json({
      suggestions: suggestions.slice(0,8),
      query: q,
      is_rc: isRC,
    });
  } catch(e) {
    return res.status(500).json({suggestions:[], error: e.message});
  }
};
