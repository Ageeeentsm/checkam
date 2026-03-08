// Check Am v10 — /api/search — SMART 3-QUERY ARCHITECTURE
// Strategy: 3 parallel SerpApi mega-queries → Claude synthesizes everything
// Result: ~3 API calls instead of ~29 per search. Fast, rich, reliable.
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
let ANTHROPIC_KEY="",SERPAPI_KEY="",MAPBOX_TOKEN="";
function refreshKeys(){
  ANTHROPIC_KEY=cleanKey(process.env.ANTHROPIC_API_KEY);
  SERPAPI_KEY  =cleanKey(process.env.SERPAPI_KEY);
  MAPBOX_TOKEN =cleanKey(process.env.MAPBOX_TOKEN);
}

// ── HTTP helpers ───────────────────────────────────────────────────
function get(url,hdrs={},ms=14000){
  return new Promise(resolve=>{
    try{
      const req=https.get(url,{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36","Accept":"text/html,application/json,*/*",...hdrs}},(res)=>{
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location)
          return get(res.headers.location,hdrs,ms).then(resolve);
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

// ── SerpApi — single call, returns {organic, kg, answer} ──────────
async function serp(query, num=10){
  if(!SERPAPI_KEY) return {organic:[], kg:null, answer:null};
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=${encodeURIComponent(query)}&num=${num}&engine=google&gl=ng&hl=en&safe=off`;
    const {s,b}=await get(url,{},15000);
    if(s!==200||!b) return {organic:[], kg:null, answer:null};
    const j=JSON.parse(b);
    const organic=(j.organic_results||[]).slice(0,num).map(r=>({
      title:r.title||"", snippet:r.snippet||"", link:r.link||"",
      source:(r.displayed_link||r.link||"").replace(/^https?:\/\//,"").split("/")[0],
      date:r.date||""
    }));
    return {organic, kg:j.knowledge_graph||null, answer:j.answer_box||null};
  }catch(_){return {organic:[], kg:null, answer:null};}
}

// ── CAC direct portal (DNS often blocked on Vercel but worth trying) ──
async function cacDirect(query){
  const isRC=/^(RC\s*)?(\d{4,8})$/i.test(query.trim());
  const rcNum=isRC?query.trim().replace(/^RC\s*/i,""):"";
  const headers={"User-Agent":"Mozilla/5.0","Referer":"https://search.cac.gov.ng/","Accept":"application/json,text/html,*/*"};
  const endpoints=isRC?[
    `https://search.cac.gov.ng/api/search/public?rcNumber=${rcNum}`,
    `https://search.cac.gov.ng/home/searchResult?rcNumber=${rcNum}`,
  ]:[
    `https://search.cac.gov.ng/api/search/public?name=${encodeURIComponent(query)}&page=0&size=10`,
    `https://search.cac.gov.ng/home/searchSimilarBusiness?name=${encodeURIComponent(query)}`,
  ];
  for(const url of endpoints){
    try{
      const {s,b}=await get(url,headers,8000);
      if(s===200&&b&&b.length>100){
        try{
          const j=JSON.parse(b);
          const list=j?.data||j?.content||j?.results||(Array.isArray(j)?j:[]);
          if(list.length) return {found:true,companies:list.map(mapCACCo)};
        }catch(_){}
        // Try HTML scraping
        const scraped=scrapeCACHTML(b);
        if(scraped.length) return {found:true,companies:scraped};
      }
    }catch(_){}
  }
  return {found:false,companies:[]};
}

function mapCACCo(co){
  const rcRaw=co.rcNumber||co.rc_number||co.rcNo||co.companyId||"";
  const dirs=[];
  (co.affiliates||co.directors||co.officers||[]).forEach(a=>{
    const nm=[a.firstname||"",a.otherName||a.other_name||"",a.surname||""].filter(Boolean).join(" ").trim()||a.name||"";
    if(nm) dirs.push({name:nm,role:a.designation||a.occupation||(a.is_chairman||a.isChairman?"Chairman":"Director"),status:a.status||"ACTIVE",source:"cac_direct"});
  });
  const shrs=[];
  (co.shareholders||co.affiliates||[]).filter(a=>a.numSharesAlloted||a.num_shares_alloted).forEach(s=>{
    const nm=[s.firstname||"",s.surname||""].filter(Boolean).join(" ").trim()||s.name||"";
    if(nm) shrs.push({name:nm,shares:s.numSharesAlloted||s.num_shares_alloted||"—",type:s.typeOfShares||"Ordinary"});
  });
  return {
    name:co.companyName||co.company_name||co.name||co.businessName||"—",
    rc_number:rcRaw?"RC"+String(rcRaw).replace(/^RC/i,"").replace(/^0+/,""):"—",
    status:co.companyStatus||co.company_status||co.status||"ACTIVE",
    type:co.companyType||co.company_type||co.typeOfEntity||co.classification||"—",
    address:co.headOfficeAddress||co.head_office_address||co.branchAddress||co.address||"—",
    email:co.companyEmail||co.email||"—",
    incorporated:co.registrationDate||co.registration_date||"—",
    state:co.state||"—", tin:co.tin||"—", directors:dirs, shareholders:shrs,
  };
}

function scrapeCACHTML(html){
  const results=[];
  const rows=html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)||[];
  rows.forEach(row=>{
    const cells=(row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi)||[])
      .map(c=>c.replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&nbsp;/g," ").trim());
    if(cells.length>=2){
      const rcCell=cells.find(c=>/^\d{4,8}$/.test(c.trim())||/^RC\d+$/i.test(c.trim()));
      const nameCell=cells.find(c=>c.length>3&&!/^\d+$/.test(c)&&!/^(active|inactive|struck off|ltd|plc|private|public|company|business|trustee)$/i.test(c));
      if(nameCell) results.push({name:nameCell,rc_number:rcCell?"RC"+rcCell.replace(/^RC/i,"").replace(/^0+/,""):"—",status:cells.find(c=>/^(active|inactive|struck off)$/i.test(c))||"ACTIVE",type:"—",address:"—",email:"—",incorporated:"—",state:"—",tin:"—",directors:[],shareholders:[]});
    }
  });
  return results;
}

// ── Geocode (Mapbox → area match) ─────────────────────────────────
const AREA_COORDS={
  "victoria island":{lat:6.4281,lng:3.4219},"ikoyi":{lat:6.4549,lng:3.4366},
  "lekki":{lat:6.4655,lng:3.5403},"ikeja":{lat:6.5954,lng:3.3417},
  "surulere":{lat:6.4996,lng:3.3536},"yaba":{lat:6.5059,lng:3.3734},
  "marina":{lat:6.4530,lng:3.3958},"apapa":{lat:6.4474,lng:3.3617},
  "maryland":{lat:6.5706,lng:3.3588},"festac":{lat:6.4671,lng:3.2795},
  "abuja":{lat:9.0765,lng:7.3986},"maitama":{lat:9.0836,lng:7.4931},
  "wuse":{lat:9.0579,lng:7.4802},"garki":{lat:9.0307,lng:7.4876},
  "asokoro":{lat:9.0403,lng:7.5319},"central business":{lat:9.0579,lng:7.4951},
  "port harcourt":{lat:4.8156,lng:7.0498},"kano":{lat:12.002,lng:8.592},
  "ibadan":{lat:7.3775,lng:3.947},"enugu":{lat:6.4162,lng:7.4942},
  "kaduna":{lat:10.5264,lng:7.4382},"benin city":{lat:6.335,lng:5.627},
  "warri":{lat:5.5167,lng:5.75},"jos":{lat:9.8965,lng:8.8583},
  "onitsha":{lat:6.1449,lng:6.7858},"owerri":{lat:5.4836,lng:7.0333},
  "abeokuta":{lat:7.1562,lng:3.3458},"calabar":{lat:4.9518,lng:8.322},
  "uyo":{lat:5.0377,lng:7.9128},"lagos":{lat:6.5244,lng:3.3792},
};
async function geocode(address, entity){
  const combined=(address+" "+entity).toLowerCase();
  for(const[k,v] of Object.entries(AREA_COORDS)) if(combined.includes(k)) return {...v,source:"match"};
  if(MAPBOX_TOKEN){
    try{
      const term=(address&&address!=="—"&&address.length>5)?address:entity;
      const q=encodeURIComponent(term+", Nigeria");
      const {s,b}=await get(`https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json?access_token=${MAPBOX_TOKEN}&country=NG&limit=1`);
      if(s===200&&b){const f=JSON.parse(b).features?.[0]; if(f) return {lng:f.center[0],lat:f.center[1],source:"mapbox"};}
    }catch(_){}
  }
  return {lat:6.5244,lng:3.3792,source:"default"};
}

// ── Network graph builder ──────────────────────────────────────────
function buildNetwork(entity, extracted, isCompany){
  const nodes=[{id:"root",label:entity,type:isCompany?"company":"individual",level:0,risk:false}];
  const edges=[];
  const seen=new Set(["root"]);
  if(isCompany){
    (extracted.directors||[]).slice(0,6).forEach((d,i)=>{
      if(!d.name||seen.has(d.name)) return;
      seen.add(d.name);
      nodes.push({id:"d"+i,label:d.name,type:"individual",level:1,risk:false});
      edges.push({from:"root",to:"d"+i,label:d.role||"Director"});
    });
    (extracted.shareholders||[]).slice(0,4).forEach((s,i)=>{
      if(!s.name||seen.has(s.name)) return;
      seen.add(s.name);
      nodes.push({id:"s"+i,label:s.name,type:"shareholder",level:1,risk:false});
      edges.push({from:"root",to:"s"+i,label:`${s.shares||""}% shareholder`});
    });
  } else {
    (extracted.companies||[]).slice(0,5).forEach((c,i)=>{
      if(!c.name||seen.has(c.name)) return;
      seen.add(c.name);
      nodes.push({id:"c"+i,label:c.name,type:"company",level:1,risk:false});
      edges.push({from:"root",to:"c"+i,label:c.role||"Director"});
    });
  }
  return {nodes,edges};
}

// ── Score risk from Claude's extracted data ───────────────────────
function scoreRisk(extracted){
  let risk=20, flags=[];
  if(extracted.enforcement?.efcc_records?.length) {risk+=35; flags.push("EFCC records");}
  if(extracted.enforcement?.icpc_records?.length) {risk+=25; flags.push("ICPC records");}
  if(extracted.enforcement?.court_records?.length) {risk+=20; flags.push("Court records");}
  if(extracted.enforcement?.cbn_debarred)          {risk+=30; flags.push("CBN debarment");}
  if(extracted.enforcement?.wanted)                 {risk+=40; flags.push("EFCC wanted list");}
  if(extracted.negative_news_count>3)               {risk+=15; flags.push("Negative media coverage");}
  if(extracted.pep)                                  {risk+=10; flags.push("Political exposure");}
  const score=Math.min(risk,95);
  const rating=score>=70?"HIGH RISK":score>=40?"MEDIUM RISK":"LOW RISK";
  return {risk_score:score,legitimacy_score:100-score,rating,flags,pep_linked:!!extracted.pep};
}

// ══════════════════════════════════════════════════════════════════
// CORE INTELLIGENCE ENGINE — 3 queries, Claude extracts everything
// ══════════════════════════════════════════════════════════════════
async function gatherIntelligence(entity, isCompany, isRC, rcNum){

  // Build the 3 smart mega-queries
  const name = entity.trim();
  const bare = name.replace(/\s*(limited|ltd\.?|plc|nigeria|nig\.?|llc|incorporated|inc\.?|group|holdings|international|intl\.?|enterprises?|industries|services?|solutions?)\s*$/gi,"").trim();

  let q1, q2, q3;

  if(isRC){
    // RC lookup: need to find company name first, then everything about it
    q1 = `"RC${rcNum}" Nigeria company`;
    q2 = `RC${rcNum} site:opencorporates.com/companies/ng OR "RC${rcNum}" site:companiesng.com`;
    q3 = `"RC${rcNum}" Nigeria directors officers address registered`;
  } else if(isCompany){
    // Company: profile + leadership + enforcement + news all in 3 calls
    q1 = `"${name}" Nigeria RC number CAC registered directors "managing director" CEO chairman address incorporated`;
    q2 = `"${name}" Nigeria EFCC ICPC CBN SEC courts fraud arrested charged convicted sentenced "money laundering" sanctions`;
    q3 = `"${bare}" Nigeria news 2023 2024 2025 business financial`;
  } else {
    // Individual: role + companies + enforcement + news
    q1 = `"${name}" Nigeria director chairman CEO "managing director" company position role`;
    q2 = `"${name}" Nigeria EFCC ICPC CBN courts fraud arrested charged convicted wanted "money laundering"`;
    q3 = `"${name}" Nigeria news profile biography 2023 2024 2025`;
  }

  // Run 3 queries in parallel (+ optional CAC direct portal)
  const [r1, r2, r3, cacPortal] = await Promise.all([
    serp(q1, 10),
    serp(q2, 10),
    serp(q3, 8),
    isCompany ? cacDirect(entity).catch(()=>({found:false,companies:[]})) : Promise.resolve({found:false,companies:[]}),
  ]);

  // Compile all raw text for Claude to analyze
  const formatResults = (res, label) => {
    if(!res.organic?.length) return "";
    const lines = res.organic.map((r,i)=>`[${label}${i+1}] ${r.source}\nTitle: ${r.title}\nSnippet: ${r.snippet}${r.date?" ("+r.date+")":""}\nURL: ${r.link}`).join("\n\n");
    // Include knowledge graph if present
    const kg = res.kg ? `\nKNOWLEDGE GRAPH: ${JSON.stringify({title:res.kg.title,description:res.kg.description,phone:res.kg.phone,address:res.kg.address,website:res.kg.website,founded:res.kg.founded,headquarters:res.kg.headquarters})}` : "";
    // Include answer box
    const ans = res.answer ? `\nANSWER BOX: ${JSON.stringify(res.answer)}` : "";
    return lines + kg + ans;
  };

  const rawText = [
    formatResults(r1, "PROFILE-"),
    formatResults(r2, "ENFORCEMENT-"),
    formatResults(r3, "NEWS-"),
  ].filter(Boolean).join("\n\n---\n\n");

  // Add CAC portal data if we got it
  let cacPortalText = "";
  if(cacPortal.found && cacPortal.companies.length){
    cacPortalText = "\nCAC PORTAL DATA: " + JSON.stringify(cacPortal.companies[0]);
  }

  return {rawText, cacPortalText, cacPortal, allResults:[...(r1.organic||[]),...(r2.organic||[]),...(r3.organic||[])]};
}

// ── Claude does ALL the intelligence extraction ────────────────────
async function analyzeWithClaude(entity, isCompany, isRC, rcNum, rawText, cacPortalText){
  if(!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

  const entityType = isCompany ? "company" : "individual";
  const today = new Date().toLocaleDateString("en-GB",{year:"numeric",month:"long",day:"numeric"});

  const systemPrompt = `You are Check Am, Nigeria's premier business intelligence platform. 
Analyze search results about a Nigerian ${entityType} and return TWO things:

1. A JSON object with extracted structured data (for the UI)
2. An executive intelligence brief (for display)

CRITICAL RULES:
- Extract REAL data only from the search results provided. Do not invent or hallucinate.
- If something is not in the results, leave it as "—" or empty array.
- For RC numbers, look for patterns like "RC123456" or "RC 123456" in titles and snippets.
- For directors, extract real Nigerian names from titles/snippets.
- For enforcement, only flag if there are ACTUAL results mentioning the entity.
- Be specific and factual. Never say "limited information available" — just report what you found.
- Never mention AI, Claude, Anthropic, or search engines.

RETURN FORMAT (respond with ONLY this JSON, no other text):
{
  "extracted": {
    "name": "Official registered name",
    "rc_number": "RC123456 or —",
    "status": "Active or Inactive or —",
    "type": "Private Limited Company or —",
    "incorporated": "date or —",
    "address": "full address or —",
    "state": "Lagos or —",
    "phone": "phone or —",
    "email": "email or —",
    "website": "website or —",
    "directors": [{"name":"Full Name","role":"Managing Director"}],
    "shareholders": [{"name":"Full Name","shares":"percentage or amount","type":"Ordinary"}],
    "companies": [],
    "enforcement": {
      "efcc_records": [],
      "icpc_records": [],
      "cbn_debarred": false,
      "court_records": [],
      "firs_records": [],
      "sec_records": [],
      "wanted": false,
      "summary": "No enforcement records found OR specific finding"
    },
    "news_articles": [{"title":"headline","source":"punchng.com","date":"2024","url":"","sentiment":"positive/negative/neutral","summary":"one line"}],
    "negative_news_count": 0,
    "pep": false,
    "pep_detail": "",
    "sector": "Banking/Oil & Gas/Telecom/etc or —",
    "employees": "—",
    "turnover": "—"
  },
  "brief": "## CORPORATE IDENTITY\\n\\n[full executive brief in markdown with all findings]"
}`;

  const userPrompt = `Entity: ${entity} (${entityType}${isRC?`, RC number: RC${rcNum}`:""})\nDate: ${today}\n\n${cacPortalText ? "OFFICIAL CAC PORTAL DATA:\n"+cacPortalText+"\n\n" : ""}SEARCH RESULTS:\n${rawText}`;

  const resp = await postJson("api.anthropic.com","/v1/messages",{
    model:"claude-sonnet-4-20250514",
    max_tokens:2000,
    system: systemPrompt,
    messages:[{role:"user",content:userPrompt}]
  },{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"});

  if(resp.error) throw new Error(resp.error.message);
  const text = resp.content?.[0]?.text||"{}";
  // Strip any markdown fences
  const clean = text.replace(/^```json\s*/,"").replace(/^```\s*/,"").replace(/\s*```$/,"").trim();
  try{ return JSON.parse(clean); }
  catch(e){ 
    // Fallback: try to extract JSON from response
    const match = clean.match(/\{[\s\S]+\}/);
    if(match){ try{return JSON.parse(match[0]);}catch(_){} }
    return {extracted:{name:entity,rc_number:"—",status:"—",type:"—",incorporated:"—",address:"—",state:"—",phone:"—",email:"—",website:"—",directors:[],shareholders:[],companies:[],enforcement:{efcc_records:[],icpc_records:[],cbn_debarred:false,court_records:[],firs_records:[],sec_records:[],wanted:false,summary:"Analysis unavailable"},news_articles:[],negative_news_count:0,pep:false,pep_detail:"",sector:"—",employees:"—",turnover:"—"},brief:`**${entity}** — Intelligence analysis complete.`};
  }
}

// ── Main handler ───────────────────────────────────────────────────
module.exports = async function handler(req,res){
  refreshKeys();
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  if(!ANTHROPIC_KEY) return res.status(503).json({error:"ANTHROPIC_API_KEY not configured in Vercel."});

  const {entity, type:entityType="company"} = req.body||{};
  if(!entity) return res.status(400).json({error:"No entity provided"});

  const isRCSearch = /^(RC\s*)?(\d{4,8})$/i.test(entity.trim());
  const rcNum = isRCSearch ? entity.trim().replace(/^RC\s*/i,"") : "";
  const isCompany = isRCSearch ? true : entityType==="company";
  const effectiveType = isRCSearch ? "company" : entityType;

  try{
    // Step 1: Gather raw intelligence (3 SerpApi calls)
    const {rawText, cacPortalText, cacPortal, allResults} = await gatherIntelligence(entity, isCompany, isRCSearch, rcNum);

    // Step 2: Claude analyzes everything and returns structured data + brief
    const {extracted={}, brief=""} = await analyzeWithClaude(entity, isCompany, isRCSearch, rcNum, rawText, cacPortalText);

    // Merge CAC portal data (official source takes priority)
    if(cacPortal.found && cacPortal.companies.length){
      const c = cacPortal.companies[0];
      if(c.name && c.name!=="—") extracted.name = c.name;
      if(c.rc_number && c.rc_number!=="—") extracted.rc_number = c.rc_number;
      if(c.status && c.status!=="—") extracted.status = c.status;
      if(c.type && c.type!=="—") extracted.type = c.type;
      if(c.address && c.address!=="—") extracted.address = c.address;
      if(c.email && c.email!=="—") extracted.email = c.email;
      if(c.incorporated && c.incorporated!=="—") extracted.incorporated = c.incorporated;
      if(c.state && c.state!=="—") extracted.state = c.state;
      if(c.directors?.length) {
        // Merge: portal directors first, then Claude-found ones
        const portalNames = new Set(c.directors.map(d=>d.name.toLowerCase()));
        extracted.directors = [...c.directors, ...(extracted.directors||[]).filter(d=>!portalNames.has(d.name.toLowerCase()))];
      }
      if(c.shareholders?.length) extracted.shareholders = c.shareholders;
    }

    // Step 3: Score risk
    const scores = scoreRisk(extracted);

    // Step 4: Geocode
    const address = extracted.address && extracted.address!=="—" ? extracted.address : entity;
    const geo = await geocode(address, entity);

    // Step 5: Build network graph
    const network = buildNetwork(entity, extracted, isCompany);

    // Build final response
    const enf = extracted.enforcement || {};
    const regData = {
      efcc: {found:!!(enf.efcc_records?.length||enf.wanted), records:enf.efcc_records||[], source:"EFCC"},
      icpc: {found:!!(enf.icpc_records?.length), records:enf.icpc_records||[], source:"ICPC"},
      cbn:  {found:!!(enf.cbn_debarred), records:enf.cbn_debarred?[{type:"CBN_DEBARMENT",severity:"HIGH"}]:[], source:"CBN"},
      courts:{found:!!(enf.court_records?.length), records:enf.court_records||[], source:"Courts"},
      firs: {found:!!(enf.firs_records?.length), records:enf.firs_records||[], source:"FIRS"},
      sec:  {found:!!(enf.sec_records?.length), records:enf.sec_records||[], source:"SEC Nigeria"},
      total_hits:[enf.efcc_records?.length,enf.icpc_records?.length,enf.cbn_debarred,enf.court_records?.length,enf.firs_records?.length,enf.sec_records?.length].filter(Boolean).length,
    };

    const newsData = {
      articles: (extracted.news_articles||[]).map(a=>({...a,title:a.title||"",source:a.source||"",date:a.date||"",url:a.url||"",sentiment:a.sentiment||"neutral"})),
      negative_count: extracted.negative_news_count||0,
      total: extracted.news_articles?.length||0,
    };

    // Build the executive summary text if brief is short
    let summaryText = brief;
    if(!summaryText || summaryText.length < 50){
      summaryText = `**${extracted.name||entity}** — Risk: **${scores.rating}**. RC: ${extracted.rc_number||"—"}, Status: ${extracted.status||"—"}.`;
    }

    return res.status(200).json({
      text: summaryText,
      data:{
        entity, type:effectiveType,
        company: isCompany ? {
          name: extracted.name||entity,
          logo: null,
          rc_number: extracted.rc_number||"—",
          status: extracted.status||"Active",
          type: extracted.type||"—",
          address: extracted.address||"—",
          incorporated: extracted.incorporated||"—",
          email: extracted.email||"—",
          phone: extracted.phone||"—",
          website: extracted.website||"—",
          state: extracted.state||"—",
          sector: extracted.sector||"—",
          directors: extracted.directors||[],
          shareholders: extracted.shareholders||[],
          related_companies: [],
          cac_found: !!(extracted.rc_number && extracted.rc_number!=="—"),
          cac_confidence: cacPortal.found?"high":"medium",
        } : {},
        individual: !isCompany ? {
          name: extracted.name||entity,
          pep_status: scores.pep_linked,
          pep_detail: extracted.pep_detail||"",
          companies: extracted.companies||[],
          cac_found: !!(extracted.companies?.length),
          photo: null,
        } : {},
        regulatory: regData,
        media: newsData,
        network,
        scores: {
          legitimacy_score: scores.legitimacy_score,
          risk_score: scores.risk_score,
          influence_score: Math.max(10, 100 - scores.risk_score - (extracted.news_articles?.length ? 0 : 10)),
          rating: scores.rating,
          confidence: cacPortal.found?"HIGH":"MEDIUM",
          flags: scores.flags,
          pep_linked: scores.pep_linked,
          data_sources: allResults.map(r=>r.source).filter((v,i,a)=>a.indexOf(v)===i).slice(0,8),
        },
        geo:{
          address: extracted.address||"—",
          lat: geo.lat, lng: geo.lng,
          mapbox_token: MAPBOX_TOKEN||"",
          source: geo.source,
        },
        foot_traffic: null,
      }
    });

  }catch(e){
    console.error("Check Am error:",e.message,e.stack);
    return res.status(500).json({error:e.message});
  }
};
