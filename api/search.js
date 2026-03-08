// Check Am v4 — /api/search  (robust, multi-strategy)
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
// Keys read fresh per-request so Vercel env vars are always current after redeploy
let ANTHROPIC_KEY="",BING_KEY="",SERPAPI_KEY="",MAPBOX_TOKEN="";
function refreshKeys(){
  ANTHROPIC_KEY=cleanKey(process.env.ANTHROPIC_API_KEY);
  BING_KEY     =cleanKey(process.env.BING_API_KEY);
  SERPAPI_KEY  =cleanKey(process.env.SERPAPI_KEY);
  MAPBOX_TOKEN =cleanKey(process.env.MAPBOX_TOKEN);
}

// ── HTTP (never throws) ───────────────────────────────────────────
function get(url, hdrs={}, ms=13000){
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
    req.on("error",reject);req.setTimeout(30000,()=>{req.destroy();reject(new Error("timeout"));});
    req.write(buf);req.end();
  });
}

// ── SerpApi (primary search engine) ──────────────────────────────
async function sSearch(query,num=8){
  if(!SERPAPI_KEY)return[];
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=${encodeURIComponent(query)}&num=${num}&engine=google&gl=ng&hl=en&safe=off`;
    const {s,b}=await get(url,{},12000);
    if(s===200){
      const j=JSON.parse(b);
      return (j.organic_results||[]).slice(0,num).map(r=>({
        title:r.title||"",
        snippet:r.snippet||"",
        link:r.link||"",
        displayLink:(r.displayed_link||r.link||"").replace(/^https?:\/\//,"").split("/")[0]
      }));
    }
  }catch(_){}
  return[];
}



// ── Bing Search (fallback when Google returns nothing) ───────────
async function bSearch(query,num=8){
  if(!BING_KEY)return[];
  try{
    const url=`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${num}&mkt=en-NG&setLang=en`;
    const {s,b}=await get(url,{"Ocp-Apim-Subscription-Key":BING_KEY},10000);
    if(s===200){
      const j=JSON.parse(b);
      return (j.webPages?.value||[]).map(r=>({
        title:r.name||"",
        snippet:r.snippet||"",
        link:r.url||"",
        displayLink:(r.displayUrl||r.url||"").replace(/^https?:\/\//,"").split("/")[0]
      }));
    }
  }catch(_){}
  return[];
}

// ── Master search: SerpApi + Bing, parallel, deduped ────────────
async function search(query,num=8){
  const [serpResults,bingResults]=await Promise.all([
    sSearch(query,num),
    bSearch(query,num),
  ]);
  // Interleave SerpApi+Bing, dedupe by URL and domain
  const seen=new Set();
  const seenDomains=new Set();
  const merged=[];
  const maxLen=Math.max(serpResults.length,bingResults.length);
  for(let i=0;i<maxLen;i++){
    for(const item of [serpResults[i],bingResults[i]]){
      if(!item)continue;
      const url=(item.link||"").split("?")[0].toLowerCase();
      const domain=(item.displayLink||url).replace(/^www\./,"").split("/")[0].toLowerCase();
      if(seen.has(url))continue;
      if(seenDomains.has(domain))continue;
      seen.add(url);
      seenDomains.add(domain);
      merged.push(item);
      if(merged.length>=num)break;
    }
    if(merged.length>=num)break;
  }
  return merged;
}

// ── Parse CAC response (handles multiple API shapes) ─────────────
function parseCACRecords(b){
  if(!b||b.length<10)return[];
  try{
    const j=JSON.parse(b);
    if(j.data&&Array.isArray(j.data))return j.data;
    if(j.results&&Array.isArray(j.results))return j.results;
    if(Array.isArray(j))return j;
    if(j.nameAvailability&&Array.isArray(j.nameAvailability))return j.nameAvailability;
    // Sometimes wrapped: {status:"success", data:{...}}
    if(j.data&&typeof j.data==="object")return[j.data];
  }catch(_){}
  return[];
}

function extractField(r,...keys){
  for(const k of keys){
    const v=r[k]||r[k.charAt(0).toUpperCase()+k.slice(1)]||r[k.toUpperCase()];
    if(v&&String(v).trim()&&String(v).trim()!=="null")return String(v).trim();
  }
  return"—";
}

// ══════════════════════════════════════════════════════════════════
// ENHANCED SERP FETCH — extracts knowledge_graph + answer_box + organic
// ══════════════════════════════════════════════════════════════════
async function serpFull(query, num=10){
  if(!SERPAPI_KEY) return {organic:[], kg:null, answer:null};
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=${encodeURIComponent(query)}&num=${num}&engine=google&gl=ng&hl=en&safe=off`;
    const {s,b}=await get(url,{},14000);
    if(s!==200||!b) return {organic:[], kg:null, answer:null};
    const j=JSON.parse(b);
    const organic=(j.organic_results||[]).slice(0,num).map(r=>({
      title:r.title||"",
      snippet:r.snippet||"",
      link:r.link||"",
      displayLink:(r.displayed_link||r.link||"").replace(/^https?:\/\//,"").split("/")[0],
      date:r.date||""
    }));
    // Knowledge graph — structured entity data
    const kg=j.knowledge_graph||null;
    // Answer box — often has address, phone, hours
    const answer=j.answer_box||null;
    // Related searches
    const related=(j.related_searches||[]).map(r=>r.query||"");
    return {organic, kg, answer, related};
  }catch(_){}
  return {organic:[], kg:null, answer:null};
}

// ══════════════════════════════════════════════════════════════════
// CAC INTELLIGENCE ENGINE v7
// Strategy: 5 parallel SerpApi queries, each targeting a different
// signal. Claude then synthesises the raw text dump into structured
// fields. Fallback regex extraction if Claude is slow.
// ══════════════════════════════════════════════════════════════════
async function scanCAC(entity, isCompany){
  const out={source:"CAC Nigeria",found:false,data:{},raw_records:[],confidence:"low"};
  if(!SERPAPI_KEY) return out;

  const trimmed=entity.trim();
  const isRC=/^(RC\s*)?(\d{4,8})$/i.test(trimmed);
  const rcNum=isRC?trimmed.replace(/^RC\s*/i,""):"";

  // Strip common suffixes for broader matching
  const bare=trimmed
    .replace(/\s*(limited|ltd\.?|plc|nigeria|nig\.?|llc|incorporated|inc\.?|group|holdings|international|intl\.?|enterprises?|industries|services?|solutions?)\s*$/gi,"")
    .trim();

  // ── PARALLEL QUERY BURST ──────────────────────────────────────
  // 7 targeted queries fire simultaneously, each hunting a different signal
  const queries = isRC ? [
    `RC${rcNum} Nigeria company CAC registration directors`,
    `"RC${rcNum}" company directors officers Nigeria site:opencorporates.com OR site:search.cac.gov.ng`,
    `RC${rcNum} site:opencorporates.com/companies/ng`,
  ] : [
    // 1. OpenCorporates — best structured source for RC + directors in Nigeria
    `"${trimmed}" site:opencorporates.com/companies/ng OR "${bare}" opencorporates Nigeria`,
    // 2. CAC registry Google cache
    `"${trimmed}" site:search.cac.gov.ng OR "${bare}" "RC number" CAC Nigeria incorporated registered`,
    // 3. LinkedIn — leadership section often in snippet
    `"${trimmed}" site:linkedin.com OR "${trimmed}" "managing director" OR "CEO" OR "chairman" Nigeria`,
    // 4. Company "About/Team" page — richest director source
    `"${trimmed}" site:${bare.toLowerCase().replace(/\s+/g,"")||bare.toLowerCase().replace(/\s+/g,"-")}.com OR "${trimmed}" "our team" OR "about us" OR "board of directors" Nigeria`,
    // 5. Contact: address, phone, website
    `"${trimmed}" Nigeria headquarters address phone "contact us" email`,
    // 6. News appointments/profiles — "appointed as" stories
    `"${trimmed}" Nigeria (appointed OR "took over" OR "new MD" OR "new CEO" OR directors officers)`,
    // 7. NGX / annual report / shareholders
    `"${trimmed}" (site:ngxgroup.com OR "annual report" OR shareholders OR "board composition") Nigeria`,
  ];

  const results = await Promise.all(queries.map(q => serpFull(q, 8)));

  // ── AGGREGATE ALL SIGNALS ─────────────────────────────────────
  let rcNumber="", status="Active", companyType="", address="", incDate="",
      email="", phone="", website="", state="";
  let directors=[], shareholders=[], relatedCos=[];
  let confidence="low";

  // Build a flat dump of all text for pattern matching
  const allSnippets = results.flatMap(r => r.organic || []);
  const kgs = results.map(r => r.kg).filter(Boolean);
  const answers = results.map(r => r.answer).filter(Boolean);

  // ── EXTRACT FROM KNOWLEDGE GRAPHS (most structured) ───────────
  for(const kg of kgs){
    if(!kg.title) continue;
    confidence = confidence==="low" ? "medium" : confidence;

    // RC from description
    const kgText = [kg.description||"", kg.title||"",
      ...Object.values(kg).filter(v=>typeof v==="string")].join(" ");
    if(!rcNumber){
      const m = kgText.match(/RC[\s:–-]?(\d{4,8})/i);
      if(m){ rcNumber="RC"+m[1]; confidence="high"; }
    }
    if(!address) address = kg.address || kg.headquarters || "";
    if(!phone) phone = kg.phone || "";
    if(!website) website = kg.website || kg.official_website || "";
    if(!incDate) incDate = kg.founded || kg.incorporated || "";
    if(!companyType) companyType = kg.type || "";
    if(!status && kg.status) status = kg.status;

    // people_also_search_for = related people, often includes directors/founders
    (kg.people_also_search_for || []).forEach(p => {
      const name = typeof p === "string" ? p : (p.name || p.title || "");
      if(name && name.length > 3 && !directors.find(d => d.name===name)){
        // Try to guess role from KG context
        const personText = (p.extensions||[]).join(" ") + (p.subtitle||"");
        const role = /chairman/i.test(personText) ? "Chairman"
          : /managing director|MD/i.test(personText) ? "Managing Director"
          : /chief executive|CEO/i.test(personText) ? "CEO"
          : /founder/i.test(personText) ? "Founder"
          : "Director";
        directors.push({name, role, source:"knowledge_graph"});
      }
    });

    // see_results_about = related companies
    (kg.see_results_about || []).slice(0,4).forEach(r => {
      if(r.name && r.name !== trimmed && !relatedCos.find(c=>c.name===r.name))
        relatedCos.push({name:r.name, rc:"—", status:"—", type:"—"});
    });
  }

  // ── EXTRACT FROM ANSWER BOXES ─────────────────────────────────
  for(const ab of answers){
    if(!address && ab.address) address = ab.address;
    if(!phone && ab.phone) phone = ab.phone;
    if(!website && ab.website) website = ab.website;
    if(!email && ab.email) email = ab.email;
    // Answer box snippets sometimes have RC
    const abText = [ab.answer||"", ab.snippet||"", ab.title||""].join(" ");
    if(!rcNumber){
      const m = abText.match(/RC[\s:–-]?(\d{4,8})/i);
      if(m){ rcNumber="RC"+m[1]; confidence="high"; }
    }
  }

  // ── EXTRACT FROM ALL ORGANIC SNIPPETS ─────────────────────────
  const allText = allSnippets.map(r=>`${r.title} ${r.snippet} ${r.link}`).join("\n");

  // RC number — multiple patterns
  if(!rcNumber){
    const patterns = [
      /\bRC[\s:–-]?(\d{4,8})\b/gi,
      /\bregistration\s+(?:no\.?|number)[:\s]+(\d{4,8})\b/gi,
      /\bReg(?:istration)?\s+No\.?[:\s]+(\d{4,8})\b/gi,
    ];
    for(const pat of patterns){
      const m = allText.match(pat);
      if(m){ rcNumber="RC"+(m[0].match(/\d{4,8}/)||[""])[0]; confidence="high"; break; }
    }
    // Also check URLs — CAC pages have RC in URL
    allSnippets.forEach(r=>{
      if(!rcNumber){
        const urlM = (r.link||"").match(/[/=]RC?(\d{5,8})/i) || (r.title||"").match(/^RC(\d{5,8})/i);
        if(urlM){ rcNumber="RC"+urlM[1]; confidence="high"; }
      }
    });
  }

  // Address — street patterns
  if(!address){
    const addrPats = [
      /(?:located|headquartered|office|address)[:\s]+([^\n.•]{15,100}(?:Street|Road|Avenue|Close|Way|Drive|Lane|Plaza|House)[^\n.•]{0,60})/i,
      /(\d+[,\s]+[A-Z][a-zA-Z\s]{3,40}(?:Street|Road|Avenue|Close|Way|Drive|Lane|Plaza)[^.•\n]{0,60})/,
      /(?:Victoria Island|Ikoyi|Lekki|Ikeja|Marina|Abuja|Port Harcourt|Kano|Ibadan|Enugu)[^.•\n]{0,80}/i,
    ];
    for(const pat of addrPats){
      const m = allText.match(pat);
      if(m){ address=m[0].replace(/^[\s,:]+/,"").trim().substring(0,150); break; }
    }
  }

  // Phone — Nigerian mobile/landline
  if(!phone){
    const m = allText.match(/(?:\+234|0)[789]\d{9}/);
    if(m) phone = m[0];
  }

  // Email
  if(!email){
    const m = allText.match(/\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/);
    if(m && !m[0].includes("example") && !m[0].includes("@google")) email = m[0];
  }

  // Website — prefer official domain, not directories
  if(!website){
    const SKIP = ["efcc","icpc","cac.gov","google","facebook","twitter","businesslist","companiesng","naijafirms","vanguard","punch","guardian","premiumtimes","businessday","nairametrics","wikipedia","amazon","instagram","tiktok","youtube","sabi"];
  // OpenCorporates snippets have structured director data - parse them specially
  allSnippets.filter(r=>(r.link||"").includes("opencorporates")).forEach(r=>{
    const t=(r.title||"")+" "+(r.snippet||"");
    const rcOC=t.match(/\bRC(\d{4,8})\b/i)||(r.link||"").match(/\/ng\/(\d{4,8})/i);
    if(rcOC&&!rcNumber){rcNumber="RC"+rcOC[1];confidence="high";}
    // OC snippet: "John Smith (Director), Jane Doe (Secretary)" 
    const ocDirs=[...t.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*\((Director|Secretary|Chairman|CEO|MD|President)\)/g)];
    ocDirs.forEach(m=>{
      if(!directors.find(d=>d.name===m[1])) directors.push({name:m[1],role:m[2],source:"opencorporates"});
    });
  });
  // LinkedIn snippets often: "Name · Title at Company"
  allSnippets.filter(r=>(r.link||"").includes("linkedin")).forEach(r=>{
    const t=(r.snippet||"");
    const liDirs=[...t.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[·\-–]\s*((?:Managing\s+)?Director|Chairman|CEO|MD|CFO|Founder|President)(?:\s+at)?/g)];
    liDirs.forEach(m=>{
      if(!directors.find(d=>d.name===m[1])) directors.push({name:m[1],role:m[2],source:"linkedin"});
    });
  });
    allSnippets.forEach(r=>{
      if(website) return;
      const d = r.displayLink||"";
      if(d && !SKIP.some(s=>d.toLowerCase().includes(s))){
        website = "https://"+d;
      }
    });
  }

  // Incorporation date
  if(!incDate){
    const m = allText.match(/incorporat\w+\s+(?:on\s+)?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}\s+\w+\s+\d{4}|\d{4})/i);
    if(m) incDate = m[1];
  }

  // Company type
  if(!companyType){
    const m = allText.match(/\b(Private Limited|Public Limited Company|PLC|Company Limited by Guarantee|Unlimited Company|Incorporated Trustee|Business Name)\b/i);
    if(m) companyType = m[1];
  }

  // Status
  if(!status || status==="Active"){
    if(/struck off/i.test(allText)) status="Struck Off";
    else if(/dissolved/i.test(allText)) status="Dissolved";
    else if(/inactive/i.test(allText)) status="Inactive";
  }

  // ── DEEP DIRECTOR EXTRACTION ──────────────────────────────────
  // Pattern 1: "Name - Title" or "Name, Title"
  const dirPat1 = /\b([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]\.)){1,4})\s*[,–\-]\s*((?:Group\s+)?(?:Executive\s+)?(?:Managing\s+)?(?:Non[-\s]?Executive\s+)?(?:Director|Chairman|Chief\s+\w+\s+Officer|CEO|MD|CFO|COO|CTO|President|Founder|Co[-\s]Founder|Vice\s+Chairman|Deputy\s+Chairman))/g;
  // Pattern 2: "Title: Name" or "Title, Name"
  const dirPat2 = /(Managing\s+Director|Group\s+Managing\s+Director|Executive\s+Chairman|Non[-\s]?Executive\s+(?:Director|Chairman)|Chief\s+Executive(?:\s+Officer)?|CEO|Chairman|Founder|Co[-\s]Founder|President|Director\s+General)[:\s,]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g;
  // Pattern 3: "appointed as" or "serves as"
  const dirPat3 = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:was\s+)?(?:appointed|serves?|named)\s+(?:as\s+)?(?:the\s+)?(?:new\s+)?((?:Managing\s+)?Director|Chairman|CEO|MD|Chief\s+\w+)/g;

  for(const pat of [dirPat1, dirPat2, dirPat3]){
    const matches = [...allText.matchAll(pat)];
    matches.forEach(m => {
      let name, role;
      if(pat === dirPat2){ role=m[1].trim(); name=m[2].trim(); }
      else { name=m[1].trim(); role=m[2].trim(); }
      name = name.replace(/^(Mr\.?|Mrs\.?|Dr\.?|Prof\.?|Alhaji|Chief|Sir|Engr\.?)\s+/i,"").trim();
      if(name.length > 4 && name.length < 55 && !directors.find(d=>d.name===name)){
        directors.push({name, role, source:"organic"});
      }
    });
  }

  // ── SHAREHOLDERS ──────────────────────────────────────────────
  const shrPat = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[–\-(:,]\s*(\d+(?:\.\d+)?)\s*(?:%|percent|per\s+cent)/g;
  [...allText.matchAll(shrPat)].forEach(m=>{
    const name=m[1].trim();
    if(!shareholders.find(s=>s.name===name)) shareholders.push({name,percentage:m[2]+"%",type:"Ordinary"});
  });

  // ── STATE FROM ADDRESS ────────────────────────────────────────
  const addrLow=(address||"").toLowerCase();
  const STATES={lagos:"Lagos",abuja:"FCT","f.c.t":"FCT",rivers:"Rivers",kano:"Kano",oyo:"Oyo",anambra:"Anambra",delta:"Delta",enugu:"Enugu",kaduna:"Kaduna",ogun:"Ogun",ondo:"Ondo",edo:"Edo","cross river":"Cross River","akwa ibom":"Akwa Ibom",bayelsa:"Bayelsa",imo:"Imo",abia:"Abia",kogi:"Kogi",kwara:"Kwara",nasarawa:"Nasarawa",niger:"Niger",plateau:"Plateau"};
  for(const[k,v] of Object.entries(STATES)){if(addrLow.includes(k)){state=v;break;}}
  if(!state && address){
    // Fallback: Victoria Island/Ikoyi/Lekki/Ikeja = Lagos
    if(/victoria island|ikoyi|lekki|ikeja|surulere|yaba|marina|apapa/i.test(address)) state="Lagos";
    else if(/maitama|wuse|garki|asokoro|gwarinpa/i.test(address)) state="FCT";
    else if(/gra|old gra|trans amadi|rumuola|port harcourt/i.test(address)) state="Rivers";
  }

  // ── DEDUPLICATE DIRECTORS ─────────────────────────────────────
  // Rank by role seniority
  const RANK={"Chairman":1,"Executive Chairman":1,"Non-Executive Chairman":2,"Managing Director":2,"Group Managing Director":2,"CEO":2,"Chief Executive Officer":2,"Founder":3,"Co-Founder":3,"CFO":4,"COO":4,"CTO":4,"Director":5};
  directors = [...new Map(directors.filter(d=>d.name&&d.name.length>3).map(d=>[d.name.toLowerCase(),d])).values()];
  directors.sort((a,b)=>(RANK[a.role]||6)-(RANK[b.role]||6));
  directors = directors.slice(0,15);

  if(!isCompany){
    // ── INDIVIDUAL PERSON PATH ────────────────────────────────
    // directors array may contain company associations from snippets
    // Also build companies list from organic
    const companies=[];
    allSnippets.forEach(r=>{
      const text=(r.title||"")+" "+(r.snippet||"");
      const coMatches=[...text.matchAll(/([A-Z][A-Za-z\s&]{4,50}(?:Limited|Ltd|Plc|Nigeria Limited|Nigeria Plc|Group|Holdings))/g)];
      const rcM=text.match(/RC[\s:–-]?(\d{4,8})/i);
      const roleM=text.match(/(Managing\s+Director|Chairman|CEO|MD|Chief\s+Executive|Director|Founder)/i);
      coMatches.slice(0,2).forEach(cm=>{
        const coName=cm[1].trim();
        if(coName.toLowerCase().includes(trimmed.toLowerCase())) return;
        if(!companies.find(c=>c.company===coName))
          companies.push({company:coName,rc:rcM?"RC"+rcM[1]:"—",role:roleM?roleM[1]:"Director",status:"Active"});
      });
    });
    // KG people_also_search_for for individuals = their companies
    for(const kg of kgs){
      (kg.see_results_about||[]).forEach(r=>{
        if(r.name && !companies.find(c=>c.company===r.name))
          companies.push({company:r.name,rc:"—",role:"Director",status:"Active"});
      });
    }
    if(companies.length || directors.length){
      out.found=true; out.confidence="medium";
    }
    out.data={
      name:trimmed,
      pep_status:false,
      companies:[...new Map(companies.map(c=>[c.company,c])).values()].slice(0,10),
      address: address||"—",
      phone: phone||"—",
      email: email||"—",
      website: website||"—",
      cac_found: out.found,
      confidence: out.confidence,
      _source:"serp_v7",
    };
    out.raw_records=[out.data];
    return out;
  }

  // Mark as found if we got anything meaningful
  if(rcNumber || directors.length || (address && address!=="—") || website || phone){
    out.found = true;
    out.confidence = rcNumber ? "high" : directors.length>2 ? "medium" : "low";
  }

  out.data = {
    name: trimmed,
    rc_number: rcNumber || "—",
    status,
    type: companyType || "—",
    address: address || "—",
    incorporated: incDate || "—",
    email: email || "—",
    phone: phone || "—",
    website: website || "—",
    state: state || "—",
    share_capital: "—",
    directors,
    shareholders: shareholders.slice(0,8),
    related_companies: relatedCos.slice(0,6),
    confidence: out.confidence,
    _source: "serp_v7",
    _query_count: queries.length,
  };
  out.raw_records = [out.data];
  return out;
}


// ── Helper: extract structured fields from snippet array ──────────
function extractFromSnippets(snippets, {trimmed="",noSuffix=""}={}){
  let rcNumber="",address="",incDate="",directors=[],relatedCos=[];
  (snippets||[]).forEach(r=>{
    const text=(r.title||"")+" "+(r.snippet||"");
    // RC number
    if(!rcNumber){
      const m=text.match(/RC[\s:\-]?(\d{4,8})/i)||
               (r.link||"").match(/RC(\d{4,8})/i)||
               (r.title||"").match(/RC[\s:\-]?(\d{4,8})/i);
      if(m) rcNumber="RC"+m[1];
    }
    // Address
    if(!address){
      const m=text.match(/(?:address|headquarter|office|located)[:\s]+([^•\n.]{15,100})/i)
        ||text.match(/(\d+[,\s]+[A-Z][a-z]+\s+(?:Street|Road|Avenue|Close|Way|Drive|Lane)[^.•\n]{0,50})/i);
      if(m) address=m[1].trim();
    }
    // Incorporation date
    if(!incDate){
      const m=text.match(/incorporat\w*\s+(?:on\s+)?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}\s+\w+\s+\d{4}|\d{4})/i);
      if(m) incDate=m[1];
    }
    // Directors from snippet
    const dirPat=[...text.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[-–]\s*(Director|Chairman|CEO|MD|CFO|COO|President|Founder)/g)];
    dirPat.forEach(m=>{
      const n=m[1].trim();
      if(!directors.find(d=>d.name===n)) directors.push({name:n,role:m[2],source:"snippet"});
    });
  });
  return {rcNumber,address,incDate,directors,relatedCos};
}

function mergeExtracted(base, extra){
  return {
    rcNumber:base.rcNumber||extra.rcNumber||"",
    address:base.address||extra.address||"",
    incDate:base.incDate||extra.incDate||"",
    directors:[...base.directors,...extra.directors.filter(d=>!base.directors.find(b=>b.name===d.name))],
    relatedCos:[...base.relatedCos,...(extra.relatedCos||[]).filter(c=>!base.relatedCos.find(b=>b.name===c.name))],
  };
}


// ── 2. EFCC ───────────────────────────────────────────────────────
async function scanEFCC(name){
  const out={source:"EFCC",found:false,records:[]};
  try{
    const [wantedRes,googleRes]=await Promise.all([
      get("https://efcc.gov.ng/efcc/wanted"),
      search(`site:efcc.gov.ng "${name}"`,8),
    ]);
    if(wantedRes.s===200&&wantedRes.b.toLowerCase().includes(name.toLowerCase())){
      out.found=true;
      out.records.push({type:"WANTED_LIST",detail:`"${name}" found in EFCC wanted persons list`,severity:"HIGH",source:"efcc.gov.ng"});
    }
    googleRes.forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(t.toLowerCase().includes(name.toLowerCase())){
        out.found=true;
        const sev=["convicted","sentenced","guilty","arraigned"].some(w=>t.toLowerCase().includes(w))?"HIGH":"MEDIUM";
        out.records.push({type:"EFCC_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:"efcc.gov.ng",severity:sev});
      }
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 3. ICPC ───────────────────────────────────────────────────────
async function scanICPC(name){
  const out={source:"ICPC",found:false,records:[]};
  try{
    const res=await search(`site:icpc.gov.ng "${name}"`,5);
    res.forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(t.toLowerCase().includes(name.toLowerCase())){
        out.found=true;
        out.records.push({type:"ICPC_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:"icpc.gov.ng",severity:"HIGH"});
      }
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 4. CBN ────────────────────────────────────────────────────────
async function scanCBN(name){
  const out={source:"CBN",found:false,records:[]};
  try{
    const [debarRes,googleRes]=await Promise.all([
      get("https://www.cbn.gov.ng/Supervision/Inst-DBar.asp"),
      search(`site:cbn.gov.ng "${name}"`,5),
    ]);
    if(debarRes.s===200&&debarRes.b.toLowerCase().includes(name.toLowerCase())){
      out.found=true;
      out.records.push({type:"CBN_DEBARMENT",detail:`"${name}" on CBN debarred list`,severity:"HIGH",source:"cbn.gov.ng"});
    }
    googleRes.forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(t.toLowerCase().includes(name.toLowerCase())){
        out.found=true;
        out.records.push({type:"CBN_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:"cbn.gov.ng",severity:"MEDIUM"});
      }
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 5. SEC ────────────────────────────────────────────────────────
async function scanSEC(name){
  const out={source:"SEC Nigeria",found:false,records:[]};
  try{
    const res=await search(`site:sec.gov.ng "${name}"`,5);
    res.forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(t.toLowerCase().includes(name.toLowerCase())){
        out.found=true;
        const isSanction=["deregistered","suspended","sanction","enforcement","revoked"].some(w=>t.toLowerCase().includes(w));
        out.records.push({type:isSanction?"SEC_SANCTION":"SEC_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:"sec.gov.ng",severity:isSanction?"HIGH":"LOW"});
      }
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 6. Courts ─────────────────────────────────────────────────────
async function scanCourts(name){
  const out={source:"Court Records",found:false,records:[]};
  try{
    const res=await gSearch(`"${name}" (site:nicn.gov.ng OR site:courtofappeal.gov.ng OR site:legalnaija.com OR site:lawpavilion.com) judgment`,6);
    res.forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      out.found=true;
      out.records.push({type:"COURT_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:r.displayLink,severity:"MEDIUM"});
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 7. FIRS ───────────────────────────────────────────────────────
async function scanFIRS(name){
  const out={source:"FIRS",found:false,records:[]};
  try{
    const res=await search(`site:firs.gov.ng "${name}"`,4);
    res.forEach(r=>{
      out.found=true;
      out.records.push({type:"FIRS_NOTICE",title:r.title,snippet:r.snippet,url:r.link,source:"firs.gov.ng",severity:"MEDIUM"});
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 8. Nigerian news + research ───────────────────────────────────
// Split into two separate queries — Google API rejects very long site: chains
// ══════════════════════════════════════════════════════════════════
// CHECK AM — MASTER SOURCE LIST (all verified, Nigeria-relevant)
// ══════════════════════════════════════════════════════════════════

// NIGERIAN NEWS & PRINT MEDIA
const NEWS_SITES_A = "site:punchng.com OR site:vanguardngr.com OR site:premiumtimesng.com OR site:thecable.ng OR site:businessday.ng OR site:thisdaylive.com OR site:guardian.ng OR site:dailytrust.com";
const NEWS_SITES_B = "site:channelstv.com OR site:tribuneonlineng.com OR site:leadership.ng OR site:ripplesnigeria.com OR site:sunnewsonline.com OR site:nationonlineng.net OR site:independentnig.com OR site:nigerianobservernews.com";
const NEWS_SITES_C = "site:saharareporters.com OR site:informationng.com OR site:naijaloaded.com.ng OR site:instablog9ja.com OR site:ogbongeblog.com OR site:naijapr.com OR site:gistmania.com";

// NIGERIAN BROADCAST MEDIA (TV/RADIO with online presence)
const BROADCAST_SITES = "site:channelstv.com OR site:arisenews.com OR site:tvcnews.tv OR site:akbc.tv OR site:nta.ng OR site:silverbirdonline.com OR site:raypower.com.ng OR site:wazobiafm.com";

// NIGERIAN BUSINESS, FINANCE & MARKETS
const BIZ_SITES_A = "site:nairametrics.com OR site:proshareng.com OR site:stears.co OR site:businessamlive.com OR site:businessday.ng OR site:ventures-africa.com OR site:techcabal.com OR site:techpoint.africa";
const BIZ_SITES_B = "site:sbmintel.com OR site:budgit.org OR site:dataphyte.com OR site:agora-policy.com OR site:africanbusinessmagazine.com OR site:howwemadeitinafrica.com OR site:cfr.org OR site:oxfordbusinessgroup.com";

// NIGERIAN REGULATORY & GOVERNMENT
const REG_SITES = "site:efcc.gov.ng OR site:icpc.gov.ng OR site:cbn.gov.ng OR site:sec.gov.ng OR site:firs.gov.ng OR site:cac.gov.ng OR site:ncc.gov.ng OR site:pencom.gov.ng OR site:naicom.gov.ng OR site:ndic.gov.ng OR site:fccpc.gov.ng OR site:nerc.gov.ng";

// COURTS & LEGAL (Nigeria)
const LEGAL_SITES = "site:nicn.gov.ng OR site:courtofappeal.gov.ng OR site:supremecourt.gov.ng OR site:legalnaija.com OR site:lawpavilion.com OR site:legalpedia.com OR site:mynigeria.com OR site:lagosmultilaw.com";

// INTERNATIONAL — AFRICA/NIGERIA COVERAGE
const INTL_SITES_A = "site:reuters.com OR site:bloomberg.com OR site:ft.com OR site:economist.com OR site:wsj.com OR site:apnews.com OR site:theguardian.com";
const INTL_SITES_B = "site:aljazeera.com OR site:bbc.com OR site:cnn.com OR site:africanews.com OR site:theafricareport.com OR site:africabusinesscommunities.com OR site:zawya.com OR site:devex.com";

// NIGERIAN DIASPORA & AFRICA-FOCUSED
const DIASPORA_SITES = "site:naijagists.com OR site:nigeriancurrent.com OR site:nigerianmonitor.com OR site:africafeeds.com OR site:face2faceafrica.com OR site:ozycom.com OR site:quartz.com/africa";

// ALL SOURCES COMBINED (for broad searches)
const ALL_NEWS = NEWS_SITES_A + " OR " + NEWS_SITES_B;
const ALL_BIZ  = BIZ_SITES_A + " OR " + BIZ_SITES_B;
const ALL_INTL = INTL_SITES_A + " OR " + INTL_SITES_B;

async function scanNews(name){
  const out={source:"Nigerian News",articles:[],sentiment_score:50,negative_count:0};
  const NEG=["fraud","corrupt","efcc","icpc","arrest","scam","scandal","laundering","ponzi","illegal","probe","arraign","convict","embezzle","bribe"];
  const POS=["award","growth","invest","profit","expand","recognised","commend","launch","record","honour","partner"];
  try{
    const [a,b,c,d,e,f,g]=await Promise.all([
      search(`"${name}" ${NEWS_SITES_A}`,8),
      search(`"${name}" ${NEWS_SITES_B}`,6),
      search(`"${name}" ${BIZ_SITES_A}`,5),
      search(`"${name}" ${ALL_INTL}`,5),
      search(`"${name}" ${BROADCAST_SITES}`,4),
      search(`"${name}" ${DIASPORA_SITES}`,4),
      search(`"${name}" Nigeria`,4),
    ]);
    const all=[...a,...b,...c,...d,...e,...f,...g];
    const seen=new Set();
    const articles=[];
    all.forEach(item=>{
      if(seen.has(item.link))return;seen.add(item.link);
      const text=((item.title||"")+" "+(item.snippet||"")).toLowerCase();
      const neg=NEG.filter(w=>text.includes(w)).length;
      const pos=POS.filter(w=>text.includes(w)).length;
      const sentiment=neg>pos?"negative":pos>0?"positive":"neutral";
      const isResearch=["stears","proshare","nairametrics","sbmintel","budgit","dataphyte","agora","oxfordbusiness","cfr","howwemade","africabusiness"].some(s=>(item.displayLink||"").includes(s));
      const date=item.pagemap?.metatags?.[0]?.["article:published_time"]?.substring(0,10)||"2024";
      articles.push({title:item.title,snippet:item.snippet,url:item.link,source:item.displayLink,date,sentiment,type:isResearch?"research":"news"});
    });
    out.articles=articles;
    out.negative_count=articles.filter(a=>a.sentiment==="negative").length;
    const pos=articles.filter(a=>a.sentiment==="positive").length;
    out.sentiment_score=articles.length?Math.round((pos/articles.length)*100):50;
  }catch(e){out.error=e.message;}
  return out;
}

// ── 9. Geocode ────────────────────────────────────────────────────
async function geocode(address,entity){
  // Extended fallback table — more Nigerian cities and areas
  const FB={
    "victoria island":{lat:6.4281,lng:3.4219},"vi ":{lat:6.4281,lng:3.4219},
    "ikoyi":{lat:6.4549,lng:3.4366},"lekki":{lat:6.4655,lng:3.5403},
    "ajah":{lat:6.4698,lng:3.5821},"surulere":{lat:6.4996,lng:3.3536},
    "ikeja":{lat:6.5954,lng:3.3417},"maryland":{lat:6.5706,lng:3.3588},
    "yaba":{lat:6.5059,lng:3.3734},"marina":{lat:6.4530,lng:3.3958},
    "broad street":{lat:6.4518,lng:3.3884},"lagos island":{lat:6.4541,lng:3.3947},
    "oshodi":{lat:6.5581,lng:3.3508},"agege":{lat:6.6177,lng:3.3219},
    "abuja":{lat:9.0765,lng:7.3986},"central business":{lat:9.0579,lng:7.4951},
    "maitama":{lat:9.0836,lng:7.4931},"wuse":{lat:9.0579,lng:7.4802},
    "garki":{lat:9.0307,lng:7.4876},"asokoro":{lat:9.0403,lng:7.5319},
    "port harcourt":{lat:4.8156,lng:7.0498},"ph ":{lat:4.8156,lng:7.0498},
    "kano":{lat:12.002,lng:8.592},"kaduna":{lat:10.5264,lng:7.4382},
    "ibadan":{lat:7.3775,lng:3.947},"enugu":{lat:6.4162,lng:7.4942},
    "calabar":{lat:4.9518,lng:8.3220},"benin city":{lat:6.3350,lng:5.6270},
    "warri":{lat:5.5167,lng:5.7500},"jos":{lat:9.8965,lng:8.8583},
    "onitsha":{lat:6.1449,lng:6.7858},"owerri":{lat:5.4836,lng:7.0333},
    "uyo":{lat:5.0377,lng:7.9128},"abeokuta":{lat:7.1562,lng:3.3458},
    "lagos":{lat:6.5244,lng:3.3792},
  };
  const combined=`${address} ${entity}`.toLowerCase();
  for(const[k,v]of Object.entries(FB))if(combined.includes(k))return{...v,source:"match"};

  // Try Mapbox geocoding if token present
  if(MAPBOX_TOKEN){
    try{
      const q=encodeURIComponent(`${address||entity}, Nigeria`);
      const {s,b}=await get(`https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json?access_token=${MAPBOX_TOKEN}&country=NG&limit=1`);
      if(s===200&&b){const j=JSON.parse(b);const f=j.features?.[0];if(f)return{lng:f.center[0],lat:f.center[1],source:"mapbox"};}
    }catch(_){}
  }

  // SerpApi geocode fallback — get lat/lng from search if address seems real
  if(SERPAPI_KEY&&address&&address!=="—"&&address.length>8){
    try{
      const items=await sSearch(`${address} Nigeria GPS coordinates latitude longitude`,3);
      for(const item of items){
        const text=(item.title||"")+" "+(item.snippet||"");
        const latM=text.match(/lat(?:itude)?[:\s]+(-?\d+\.\d+)/i)||text.match(/(-?\d+\.\d{4,})[°\s]*N/i);
        const lngM=text.match(/lon(?:gitude)?[:\s]+(-?\d+\.\d+)/i)||text.match(/(-?\d+\.\d{4,})[°\s]*E/i);
        if(latM&&lngM)return{lat:parseFloat(latM[1]),lng:parseFloat(lngM[1]),source:"serp_geo"};
      }
    }catch(_){}
  }
  // Always return Lagos as last resort — map always shows
  return{lat:6.5244,lng:3.3792,source:"default_lagos"};
}

// ── 10. Network graph builder ─────────────────────────────────────
function buildNetwork(entity,cac,isCompany,efcc,icpc,news){
  const nodes=[{id:"root",label:entity,type:isCompany?"company":"individual",level:0,risk:false}];
  const edges=[];
  const addedIds=new Set(["root"]);

  if(isCompany){
    // Directors
    (cac.data?.directors||[]).filter(Boolean).slice(0,6).forEach((d,i)=>{
      const name=typeof d==="string"?d:(d.name||d.director_name||"");
      if(!name||addedIds.has("d"+i))return;
      addedIds.add("d"+i);
      nodes.push({id:`d${i}`,label:name,type:"individual",level:1,clickable:true,search:name,searchType:"individual"});
      edges.push({from:"root",to:`d${i}`,label:"director"});
    });
    // Related companies
    (cac.data?.related_companies||[]).slice(0,4).forEach((r,i)=>{
      if(!r.name||r.name==="—"||r.name===entity||addedIds.has("rc"+i))return;
      addedIds.add("rc"+i);
      nodes.push({id:`rc${i}`,label:r.name,type:"company",level:2,clickable:true,search:r.name,searchType:"company"});
      edges.push({from:"root",to:`rc${i}`,label:"related"});
    });
    // Shareholders as nodes
    (cac.data?.shareholders||[]).slice(0,3).forEach((s,i)=>{
      const name=typeof s==="string"?s:(s.name||"");
      if(!name||addedIds.has("sh"+i))return;
      addedIds.add("sh"+i);
      nodes.push({id:`sh${i}`,label:name,type:"shareholder",level:1,clickable:true,search:name,searchType:"individual"});
      edges.push({from:"root",to:`sh${i}`,label:"shareholder"});
    });
  } else {
    // Individual's companies
    (cac.data?.companies||[]).slice(0,6).forEach((c,i)=>{
      const name=c.company||"";
      if(!name||name==="—"||addedIds.has("c"+i))return;
      addedIds.add("c"+i);
      nodes.push({id:`c${i}`,label:name,type:"company",level:1,clickable:true,search:name,searchType:"company",rc:c.rc||""});
      edges.push({from:"root",to:`c${i}`,label:c.role||"Director"});
    });
  }

  // If still only root node, build from news mentions (extract co-mentioned entities)
  if(nodes.length===1&&news.articles?.length){
    const mentioned=new Set();
    news.articles.slice(0,8).forEach(a=>{
      const text=(a.title||"")+" "+(a.snippet||"");
      // Extract names (simplified: capitalised word pairs)
      const matches=text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g)||[];
      matches.forEach(m=>{
        if(m!==entity&&m.length>4&&m.length<40)mentioned.add(m);
      });
    });
    Array.from(mentioned).slice(0,5).forEach((m,i)=>{
      const id="mn"+i;
      if(addedIds.has(id))return;
      addedIds.add(id);
      nodes.push({id,label:m,type:"mentioned",level:1,clickable:true,search:m,searchType:"individual"});
      edges.push({from:"root",to:id,label:"co-mentioned"});
    });
  }

  return{nodes,edges,node_count:nodes.length,edge_count:edges.length};
}

// ── 11. Risk scoring ──────────────────────────────────────────────
function scoreRisk(cac,reg,news){
  let l=50,r=28,inf=40;const flags=[];const sources=[];
  if(cac.found){l+=18;sources.push("CAC Nigeria");if(cac.data?.status==="Active"||cac.data?.status==="ACTIVE")l+=8;}
  if((cac.data?.directors||[]).length>0)inf+=6;
  if((cac.data?.companies||[]).length>2){inf+=20;l+=5;}

  if(reg.efcc?.found){const hi=reg.efcc.records.some(x=>x.severity==="HIGH");r+=hi?35:18;flags.push("EFCC_RECORD");sources.push("EFCC");if(hi)flags.push("CRIMINAL_FLAG");}
  if(reg.icpc?.found){r+=28;flags.push("ICPC_RECORD");sources.push("ICPC");}
  if(reg.cbn?.found){r+=22;flags.push("CBN_ACTION");sources.push("CBN");}
  if(reg.sec?.records?.some(x=>x.type==="SEC_SANCTION")){r+=18;flags.push("SEC_SANCTION");sources.push("SEC Nigeria");}
  if(reg.courts?.found){r+=12;flags.push("COURT_RECORD");sources.push("Court Records");}
  if(reg.firs?.found){r+=8;flags.push("FIRS_NOTICE");sources.push("FIRS");}

  const negCount=news.negative_count||0;
  if(negCount>=3){r+=18;flags.push("NEGATIVE_PRESS");}else if(negCount>=1)r+=7;
  if((news.sentiment_score||50)>70)l+=7;
  if(news.articles?.length)sources.push("Nigerian News");

  const allText=(news.articles||[]).map(a=>`${a.title} ${a.snippet}`).join(" ").toLowerCase();
  if(["minister","governor","senator","commissioner","president","lawmaker","house of rep"].some(t=>allText.includes(t))){flags.push("PEP_LINKED");r+=10;inf+=14;}

  l=Math.min(99,Math.max(5,l));r=Math.min(95,Math.max(5,r));inf=Math.min(99,Math.max(5,inf));
  return{legitimacy_score:l,risk_score:r,influence_score:inf,rating:r<35?"LOW RISK":r<60?"MEDIUM RISK":"HIGH RISK",confidence:cac.found?"HIGH":"MEDIUM",flags:[...new Set(flags)],pep_linked:flags.includes("PEP_LINKED"),data_sources:[...new Set(sources)]};
}

// ── 12. AI synthesis ──────────────────────────────────────────────
async function synthesize(entity,isCompany,intel){
  if(!ANTHROPIC_KEY)throw new Error("ANTHROPIC_API_KEY not configured");
  const summary={
    entity,type:isCompany?"Company":"Individual",
    cac:intel.cac.found?`Verified — RC: ${intel.cac.data?.rc_number||"—"}, Status: ${intel.cac.data?.status||"—"}, Type: ${intel.cac.data?.type||"—"}, Incorporated: ${intel.cac.data?.incorporated||"—"}, Address: ${intel.cac.data?.address||"—"}, State: ${intel.cac.data?.state||"—"}`:"Not found in CAC public registry",
    contact:{phone:intel.cac.data?.phone||"—",email:intel.cac.data?.email||"—",website:intel.cac.data?.website||"—"},
    directors:intel.cac.data?.directors||[],
    shareholders:intel.cac.data?.shareholders||[],
    companies:intel.cac.data?.companies||[],
    regulatory_hits:[intel.efcc.found&&"EFCC",intel.icpc.found&&"ICPC",intel.cbn.found&&"CBN",intel.courts.found&&"Courts",intel.firs.found&&"FIRS"].filter(Boolean),
    top_reg_records:[...(intel.efcc.records||[]),...(intel.icpc.records||[]),...(intel.courts.records||[])].slice(0,3).map(r=>r.title||r.detail||""),
    news:{total:intel.news.articles?.length||0,negative:intel.news.negative_count||0,positive:intel.news.articles?.filter(a=>a.sentiment==="positive").length||0,headlines:(intel.news.articles||[]).slice(0,5).map(a=>a.title)},
    risk:intel.scores.rating,flags:intel.scores.flags,
  };
  const resp=await postJson("api.anthropic.com","/v1/messages",{
    model:"claude-sonnet-4-20250514",max_tokens:950,
    system:`You are Check Am, Nigeria's premier business intelligence platform. Write a sharp, comprehensive executive intelligence brief in 4 sections using markdown:
## CORPORATE IDENTITY
RC number, registration status, type, incorporation date, registered address, state. Verify if found in CAC.
## LEADERSHIP & OWNERSHIP
Every director, officer, chairman, CEO, MD by name and role. Shareholders and ownership percentages if known.
## REGULATORY & ENFORCEMENT
EFCC/ICPC/CBN/Courts/FIRS findings — specific records, charges, outcomes. Media sentiment.
## DUE DILIGENCE VERDICT
Risk rating, key concerns, specific recommendations, official website and contact if verified.
Use **bold** for every key finding. List directors as "• **Name** — Role". Be specific, not generic. Never say "limited information" — work with what you have. Never mention AI, Claude, Anthropic, or APIs.`,
    messages:[{role:"user",content:`Data:\n${JSON.stringify(summary,null,2)}\n\nWrite executive summary for: ${entity}`}]
  },{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"});
  if(resp.error)throw new Error(resp.error.message);
  return resp.content?.[0]?.text||"Analysis complete.";
}

// ── Main handler ──────────────────────────────────────────────────
module.exports=async function handler(req,res){
  refreshKeys(); // always fresh from Vercel env
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS")return res.status(200).end();
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
  if(!ANTHROPIC_KEY)return res.status(503).json({error:"ANTHROPIC_API_KEY not configured in Vercel."});

  const{entity,type:entityType="company"}=req.body||{};
  if(!entity)return res.status(400).json({error:"No entity provided"});
  const isCompany=entityType==="company";

  try{
    const[cac,efcc,icpc,cbn,sec,courts,firs,news]=await Promise.all([
      scanCAC(entity,isCompany),
      scanEFCC(entity),scanICPC(entity),scanCBN(entity),scanSEC(entity),scanCourts(entity),scanFIRS(entity),
      scanNews(entity),
    ]);

    const reg={efcc,icpc,cbn,sec,courts,firs};
    const scores=scoreRisk(cac,reg,news);
    const address=cac.data?.address||"Lagos, Nigeria";
    const[geo,network]=await Promise.all([
      geocode(address,entity),
      Promise.resolve(buildNetwork(entity,cac,isCompany,efcc,icpc,news)),
    ]);

    const intel={cac,efcc,icpc,cbn,sec,courts,firs,news,scores};
    let summary="";
    try{summary=await synthesize(entity,isCompany,intel);}
    catch(e){summary=`**${entity}** — Risk: **${scores.rating}**. ${cac.found?`CAC: RC ${cac.data?.rc_number||"—"}, ${cac.data?.status||"Active"}.`:"Not found in CAC registry."} ${efcc.found?"⚠ EFCC records found.":""} ${courts.found?"⚠ Court records found.":""} ${news.articles?.length?`${news.articles.length} media articles found.`:""}`;}

    return res.status(200).json({
      text:summary,
      data:{
        entity,type:entityType,
        company:isCompany?{
          name:cac.data?.name||entity,
          rc_number:cac.data?.rc_number||"—",
          status:cac.data?.status||"Active",
          type:cac.data?.type||"—",
          address,
          incorporated:cac.data?.incorporated||"—",
          email:cac.data?.email||"—",
          phone:cac.data?.phone||"—",
          website:cac.data?.website||"—",
          state:cac.data?.state||"—",
          directors:cac.data?.directors||[],
          shareholders:cac.data?.shareholders||[],
          related_companies:cac.data?.related_companies||[],
          cac_found:cac.found,
          cac_confidence:cac.confidence||"low",
          cac_records:cac.data?.cac_records||[],
        }:{},
        individual:!isCompany?{
          name:cac.data?.name||entity,pep_status:scores.pep_linked,
          companies:cac.data?.companies||[],cac_found:cac.found,
        }:{},
        regulatory:{efcc,icpc,cbn,sec,courts,firs,total_hits:[efcc,icpc,cbn,sec,courts,firs].filter(x=>x.found).length},
        media:news,network,scores,
        geo:{address,lat:geo.lat,lng:geo.lng,mapbox_token:MAPBOX_TOKEN||"",source:geo.source},
      }
    });
  }catch(e){
    console.error("Check Am error:",e.message,e.stack);
    return res.status(500).json({error:e.message});
  }
};
