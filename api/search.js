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
// ── CAC DIRECT — hits search.cac.gov.ng public portal ────────────
async function cacDirect(query) {
  const isRC = /^(RC\s*)?(\d{4,8})$/i.test(query.trim());
  const rcNum = isRC ? query.trim().replace(/^RC\s*/i,'') : '';
  const headers = {
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Referer':'https://search.cac.gov.ng/',
    'Accept':'application/json,text/html,*/*',
  };
  const endpoints = isRC ? [
    `https://search.cac.gov.ng/home/searchResult?rcNumber=${rcNum}`,
    `https://search.cac.gov.ng/api/search/public?rcNumber=${rcNum}`,
  ] : [
    `https://search.cac.gov.ng/home/searchSimilarBusiness?name=${encodeURIComponent(query)}`,
    `https://search.cac.gov.ng/api/search/public?name=${encodeURIComponent(query)}&page=0&size=10`,
  ];
  for(const url of endpoints){
    try{
      const {s:rs,b:rb}=await get(url, headers);
      if(rs===200 && rb && rb.length>200){
        try{
          const j=JSON.parse(rb);
          const list=j?.data||j?.content||j?.results||(Array.isArray(j)?j:[]);
          if(list.length) return {found:true,source:'cac_direct',companies:list.map(mapCACCo)};
        }catch(_){}
        const scraped=scrapeCACHTML(rb);
        if(scraped.length) return {found:true,source:'cac_html',companies:scraped};
      }
    }catch(_){}
  }
  return {found:false,source:'none',companies:[]};
}

function mapCACCo(co){
  const rcRaw=co.rcNumber||co.rc_number||co.rcNo||co.companyId||'';
  const dirs=[];
  (co.affiliates||co.directors||co.officers||[]).forEach(a=>{
    const nm=[a.firstname||'',a.otherName||a.other_name||'',a.surname||''].filter(Boolean).join(' ').trim()||a.name||'';
    if(nm) dirs.push({name:nm,role:a.designation||a.occupation||(a.is_chairman||a.isChairman?'Chairman':'Director'),status:a.status||'ACTIVE',source:'cac_direct'});
  });
  const shrs=[];
  (co.shareholders||co.affiliates||[]).filter(a=>a.numSharesAlloted||a.num_shares_alloted).forEach(s=>{
    const nm=[s.firstname||'',s.surname||''].filter(Boolean).join(' ').trim()||s.name||'';
    if(nm) shrs.push({name:nm,shares:s.numSharesAlloted||s.num_shares_alloted||'—',type:s.typeOfShares||'Ordinary'});
  });
  return {
    name:co.companyName||co.company_name||co.name||co.businessName||'—',
    rc_number:rcRaw?'RC'+String(rcRaw).replace(/^RC/i,'').replace(/^0+/,''):'—',
    status:co.companyStatus||co.company_status||co.status||'ACTIVE',
    type:co.companyType||co.company_type||co.typeOfEntity||co.classification||'—',
    address:co.headOfficeAddress||co.head_office_address||co.branchAddress||co.address||'—',
    email:co.companyEmail||co.email||'—',
    incorporated:co.registrationDate||co.registration_date||'—',
    state:co.state||'—', tin:co.tin||'—', directors:dirs, shareholders:shrs,
  };
}

function scrapeCACHTML(html){
  const results=[];
  const rows=html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)||[];
  rows.forEach(row=>{
    const cells=(row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi)||[])
      .map(c=>c.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim());
    if(cells.length>=2){
      const rcCell=cells.find(c=>/^\d{4,8}$/.test(c.trim())||/^RC\d+$/i.test(c.trim()));
      const nameCell=cells.find(c=>c.length>3&&!/^\d+$/.test(c)&&!/^(active|inactive|struck off|ltd|plc|private|public|company|business|trustee)$/i.test(c));
      if(nameCell) results.push({name:nameCell,rc_number:rcCell?'RC'+rcCell.replace(/^RC/i,'').replace(/^0+/,''):'—',status:cells.find(c=>/^(active|inactive|struck off)$/i.test(c))||'ACTIVE',type:cells.find(c=>/limited|private|public|trustee|business name/i.test(c))||'—',address:'—',email:'—',incorporated:'—',state:'—',tin:'—',directors:[],shareholders:[]});
    }
  });
  // Also try JSON embedded in script tags (Angular initial state)
  const jsonM=html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});/m)||html.match(/"content"\s*:\s*(\[[\s\S]+?\])/m);
  if(jsonM){try{const d=JSON.parse(jsonM[1]);(Array.isArray(d)?d:(d.companies||d.results||[])).forEach(co=>results.push(mapCACCo(co)));}catch(_){}}
  return results;
}


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
// gSearch = SerpApi only (no Bing) - used for enforcement scans
async function gSearch(query, num=8){ return sSearch(query, num); }

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
  const out={source:"CAC Nigeria",found:false,data:{},raw_records:[],confidence:"low",foot_traffic:null};
  if(!SERPAPI_KEY) return out;

  const trimmed = entity.trim();
  const isRC = /^(RC\s*)?(\d{4,8})$/i.test(trimmed);
  const rcNum = isRC ? trimmed.replace(/^RC\s*/i,"") : "";

  // Strip legal suffixes for broader matching
  const bare = trimmed
    .replace(/\s*(limited|ltd\.?|plc|nigeria|nig\.?|llc|incorporated|inc\.?|group|holdings|international|intl\.?|enterprises?|industries|services?|solutions?)\s*$/gi,"")
    .trim();

  // ── STEP 1: RC SEARCH — resolve to company name first ──────────
  let resolvedName = "";
  if(isRC){
    // Run 3 parallel resolution strategies
    const [ocRes, serpRes1, serpRes2] = await Promise.all([
      // Strategy A: OC direct API (may be DNS blocked on Vercel but try)
      get(`https://api.opencorporates.com/v0.4/companies/ng/${rcNum}`).catch(()=>({s:0,b:""})),
      // Strategy B: OC indexed page via SerpApi
      serpFull(`RC${rcNum} site:opencorporates.com/companies/ng`, 5),
      // Strategy C: Broad RC search — companiesng, CAC, news all mention RC in text
      serpFull(`"RC${rcNum}" Nigeria company registered`, 8),
    ]);

    // A: OC direct
    try{
      if(ocRes.s===200 && ocRes.b){
        const oc = JSON.parse(ocRes.b)?.results?.company;
        if(oc?.name) resolvedName = oc.name;
      }
    }catch(_){}

    // B: OC via SerpApi — title = "Company Name - RCNUM (Nigeria) - OpenCorporates"
    if(!resolvedName){
      for(const r of (serpRes1.organic||[])){
        const link = r.link||"";
        const title = r.title||"";
        // OC URL contains the RC number
        const ocUrlM = link.match(/opencorporates\.com\/companies\/ng\/(\d+)/i);
        if(ocUrlM){
          const clean = title
            .replace(/\s*-\s*\d{3,8}\s*\(?Nigeria\)?.*$/i,"")
            .replace(/\s*-\s*OpenCorporates.*$/i,"")
            .replace(/\s*[|].*$/,"").trim();
          if(clean && clean.length > 2){ resolvedName = clean; break; }
        }
      }
    }

    // C: Broad search — look for company name near RC mention
    if(!resolvedName){
      const kg = serpRes2.kg;
      if(kg?.title && !/^(search|result|list|page|company|companies)/i.test(kg.title)){
        resolvedName = kg.title;
      }
      if(!resolvedName){
        for(const r of (serpRes2.organic||[])){
          const title = (r.title||"").trim();
          const link  = r.link||"";
          const snip  = r.snippet||"";
          // Skip directory pages
          if(/businesslist|naijafirms|vconnect|yellow.*pages|zoominfo/i.test(link)) continue;
          // Skip generic titles
          if(/^(list of|search|results|page \d|companies in)/i.test(title)) continue;
          const clean = title
            .replace(/\s*-\s*\d{3,8}\s*\(?Nigeria\)?.*$/i,"")
            .replace(/\s*-\s*OpenCorporates.*$/i,"")
            .replace(/\s*-\s*CAC.*$/i,"")
            .replace(/\s*-\s*Lagos.*$/i,"").replace(/\s*-\s*Abuja.*$/i,"")
            .replace(/\s*-\s*Contact.*$/i,"").replace(/\s*-\s*Phone.*$/i,"")
            .replace(/\s*[|].*$/,"").replace(/\s+/g," ").trim();
          // Must be plausible company name: 3-80 chars, not a question
          if(clean.length > 3 && clean.length < 80 && !/^(where|what|how|who|why)/i.test(clean)){
            // Verify RC appears in text
            if((snip+title).match(new RegExp(`RC\\s*${rcNum}|\\b${rcNum}\\b`))){
              resolvedName = clean; break;
            }
            // Or OC/CAC source
            if(/opencorporates|companiesng|search\.cac/i.test(link)){
              resolvedName = clean; break;
            }
          }
        }
      }
    }
  }

  // Use resolved name for all downstream queries
  const searchName = resolvedName || trimmed;
  const searchBare = resolvedName
    ? resolvedName.replace(/\s*(limited|ltd\.?|plc|nigeria|nig\.?|llc|incorporated|inc\.?|group|holdings|international|intl\.?|enterprises?|industries|services?|solutions?)\s*$/gi,"").trim()
    : bare;

  // ── STEP 2: PARALLEL QUERY BURST ───────────────────────────────
  const queries = isRC ? [
    // Lead with the resolved name if we have it
    `"${searchName}" directors chairman CEO "managing director" board Nigeria`,
    `"${searchName}" Nigeria address phone website "contact us"`,
    `"${searchName}" Nigeria appointed officers "annual report" shareholders`,
    `"RC${rcNum}" site:opencorporates.com/companies/ng OR site:search.cac.gov.ng`,
  ] : [
    // 1. OpenCorporates — structured RC + directors
    `"${trimmed}" site:opencorporates.com/companies/ng OR "${bare}" opencorporates Nigeria`,
    // 2. CAC cache
    `"${trimmed}" site:search.cac.gov.ng OR "${bare}" "RC number" CAC Nigeria incorporated`,
    // 3. LinkedIn leadership
    `"${trimmed}" site:linkedin.com/company OR "${trimmed}" "managing director" OR "CEO" OR "chairman" Nigeria`,
    // 4. Official website / about page
    `"${trimmed}" "our team" OR "about us" OR "board of directors" OR "leadership" Nigeria -zoom -facebook -linkedin`,
    // 5. Contact info — also mines Apollo/ZoomInfo/LinkedIn as DATA sources (not website)
    `"${trimmed}" Nigeria (site:apollo.io OR site:zoominfo.com OR site:linkedin.com/company) address phone directors`,
    `"${trimmed}" Nigeria headquarters address phone "contact us" email`,
    // 6. News appointments
    `"${trimmed}" Nigeria (appointed OR "new MD" OR "new CEO" OR directors officers) 2022 OR 2023 OR 2024`,
    // 7. Annual reports / NGX
    `"${trimmed}" (site:ngxgroup.com OR "annual report" OR shareholders OR "board composition") Nigeria`,
  ];

  // Foot traffic query fires in parallel
  const ftQuery = `"${searchName}" Nigeria "opening hours" OR "visiting hours" OR "busy" OR "peak hours"`;

  const [results, ftResult] = await Promise.all([
    Promise.all(queries.map(q => serpFull(q, 8))),
    serpFull(ftQuery, 4).catch(()=>({organic:[]})),
  ]);

  // Extract foot traffic
  let footTraffic = null;
  const ftText = (ftResult.organic||[]).map(r=>`${r.title} ${r.snippet}`).join(" ");
  const peakM = ftText.match(/(?:peak|busiest|most.*busy)[^.]{0,60}(?:morning|afternoon|evening|monday|tuesday|\d+am|\d+pm)[^.]{0,40}/gi);
  const hoursM = ftText.match(/(?:open(?:ing)?\s*hours?|operating\s*hours?)[:\s]+([^.\n]{10,60})/gi);
  if(peakM||hoursM) footTraffic={source:"text",peak_mentions:(peakM||[]).slice(0,3),hours:(hoursM||[]).slice(0,2)};

  // ── STEP 3: AGGREGATE ALL SIGNALS ──────────────────────────────
  const allSnippets = results.flatMap(r => r.organic||[]);
  const kgs = results.map(r => r.kg).filter(Boolean);
  const allText = allSnippets.map(r=>`${r.title||""} ${r.snippet||""} ${r.link||""}`).join("\n");

  let rcNumber="", status="Active", companyType="", address="", incDate="",
      email="", phone="", website="", state="";
  let directors=[], shareholders=[], relatedCos=[];
  let confidence = isRC ? "high" : "low";

  // If RC search, seed the RC number
  if(isRC) rcNumber = `RC${rcNum}`;

  // ── Knowledge Graph (most structured) ──────────────────────────
  for(const kg of kgs){
    if(!kg.title) continue;
    if(confidence==="low") confidence="medium";
    const kgText = [kg.description||"",kg.title||"",...Object.values(kg).filter(v=>typeof v==="string")].join(" ");
    if(!rcNumber){ const m=kgText.match(/RC[\s:–-]?(\d{4,8})/i); if(m){rcNumber="RC"+m[1];confidence="high";}}
    if(!address) address = kg.address||kg.headquarters||"";
    if(!phone) phone = kg.phone||"";
    if(!website) website = kg.website||kg.official_website||"";
    if(!incDate) incDate = kg.founded||kg.incorporated||"";
    if(!companyType) companyType = kg.type||"";

    (kg.people_also_search_for||[]).forEach(p=>{
      const name = typeof p==="string"?p:(p.name||p.title||"");
      if(!name||name.length<4) return;
      const pText = (p.extensions||[]).join(" ")+(p.subtitle||"");
      const role = /chairman/i.test(pText)?"Chairman"
        :/managing.?director|MD/i.test(pText)?"Managing Director"
        :/chief.?executive|CEO/i.test(pText)?"CEO"
        :/founder/i.test(pText)?"Founder"
        :"Director";
      if(!directors.find(d=>d.name===name)) directors.push({name,role,source:"knowledge_graph"});
    });
    (kg.see_results_about||[]).slice(0,4).forEach(r=>{
      if(r.name && r.name!==trimmed && !relatedCos.find(c=>c.name===r.name))
        relatedCos.push({name:r.name,rc:"—",status:"—",type:"—"});
    });
  }

  // ── OpenCorporates snippets ─────────────────────────────────────
  allSnippets.filter(r=>(r.link||"").includes("opencorporates")).forEach(r=>{
    const t=(r.title||"")+" "+(r.snippet||"");
    // RC from OC URL: opencorporates.com/companies/ng/12345
    const urlRC = (r.link||"").match(/\/companies\/ng\/(\d+)/i);
    if(urlRC && !rcNumber){rcNumber="RC"+urlRC[1].replace(/^0+/,"");confidence="high";}
    const textRC = t.match(/\bRC(\d{4,8})\b/i);
    if(textRC && !rcNumber){rcNumber="RC"+textRC[1];confidence="high";}
    // Directors from OC: "John Smith (Director)"
    [...t.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*\((Director|Secretary|Chairman|CEO|MD|President|Treasurer)\)/g)]
      .forEach(m=>{ if(!directors.find(d=>d.name===m[1])) directors.push({name:m[1],role:m[2],source:"opencorporates"});});
    // OC snippet sometimes: "officers: Name (role), Name (role)"
    [...t.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}),?\s*(director|chairman|secretary|ceo|md|president)/gi)]
      .forEach(m=>{ if(!directors.find(d=>d.name===m[1])) directors.push({name:m[1],role:m[2],source:"opencorporates"});});
  });

  // ── LinkedIn snippets ───────────────────────────────────────────
  allSnippets.filter(r=>(r.link||"").includes("linkedin")).forEach(r=>{
    const t = r.snippet||"";
    [...t.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[·\-–]\s*((?:Managing\s+)?Director|Chairman|CEO|MD|CFO|Founder|President)(?:\s+at)?/g)]
      .forEach(m=>{ if(!directors.find(d=>d.name===m[1])) directors.push({name:m[1],role:m[2],source:"linkedin"});});
  });

  // ── Apollo / ZoomInfo / Lusha snippets — mine for contact data ──
  allSnippets.filter(r=>/apollo\.io|zoominfo\.com|lusha\.com|rocketreach|dnb\.com|crunchbase/i.test(r.link||"")).forEach(r=>{
    const t=(r.title||"")+" "+(r.snippet||"");
    // Phone
    if(!phone){ const m=t.match(/(?:\+?234|0)[789]\d{9}/); if(m) phone=m[0].replace(/\s/g,""); }
    // Email
    if(!email){ const em=t.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/); if(em&&!/example|@apollo|@zoom|@linked/i.test(em[0])) email=em[0]; }
    // Address from snippet
    if(!address){
      const am=t.match(/\d{1,4}[,\s]+[A-Z][a-zA-Z\s]{3,45}(?:Street|Road|Avenue|Close|Way|Drive|Lane|Plaza)[^.]{0,100}/);
      if(am) address=am[0].trim().substring(0,150);
    }
    // Directors from ZoomInfo/Apollo — format: "Name - Title"
    const dirM=[...t.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[-–]\s*((?:Managing\s+)?Director|Chairman|CEO|MD|CFO|COO|CTO|President|Founder)/g)];
    dirM.forEach(m=>{ if(!directors.find(d=>d.name===m[1])) directors.push({name:m[1].trim(),role:m[2].trim(),source:"data_aggregator"}); });
    // Number of employees often in ZoomInfo
    if(!companyType && /employees/i.test(t)){
      const m=t.match(/(\d[\d,]+)\s*employees/i);
      if(m) companyType=companyType||"";  // Just note it exists
    }
  });

  // ── Real website discovery — verify domain by fetching it ──────
  // We already scored candidate domains above. Now try to CONFIRM the best candidate
  // by fetching it and checking if the company name appears in the page title/meta
  if(!website || website.includes("opencorporates") || website.includes("businesslist")){
    // Re-run scoring to get best candidate
    const bare2=searchBare.toLowerCase().replace(/[^a-z]/g,"");
    const SKIPRE=/zoom|facebook|instagram|twitter|linkedin|apollo|zoominfo|opencorporates|businesslist|naijafirms|vconnect|google|wikipedia|nairametrics|businessday|punch|vanguard|guardian|efcc|icpc|cac\.gov|ngxgroup/i;
    const verified = allSnippets
      .map(r=>({d:(r.displayLink||"").toLowerCase().replace(/^www\./,""), title:r.title||"", snippet:r.snippet||""}))
      .filter(({d})=>d && d.includes(".") && !SKIPRE.test(d))
      .map(({d,title,snippet})=>{
        let sc=1;
        if(d.endsWith(".ng")||d.endsWith(".com.ng")) sc+=5;
        else if(d.endsWith(".org.ng")) sc+=4;
        else if(d.endsWith(".org")||d.endsWith(".co")) sc+=2;
        const dc=d.replace(/[^a-z]/g,"");
        if(bare2.length>=4 && (dc.includes(bare2.slice(0,6))||bare2.slice(0,6).includes(dc.slice(0,5)))) sc+=4;
        if(/official\s*(?:website|site)|contact\s*us|our\s*website|home\s*page/i.test(title+snippet)) sc+=3;
        if(/directory|listing|find.*business|business.*profile|about\.me|bio\.link/i.test(title)) sc-=4;
        return {d,sc};
      })
      .sort((a,b)=>b.sc-a.sc);
    if(verified.length && verified[0].sc >= 2){
      website = "https://"+verified[0].d;
    }
  }

  // ── RC number from snippets ─────────────────────────────────────
  if(!rcNumber || !rcNumber.match(/RC\d{4}/)){
    const pats = [/\bRC[\s:–-]?(\d{4,8})\b/gi,/\bregistration\s+(?:no\.?|number)[:\s]+(\d{4,8})\b/gi,/\bReg(?:istration)?\s+No\.?[:\s]+(\d{4,8})\b/gi];
    for(const pat of pats){
      const m=allText.match(pat);
      if(m){rcNumber="RC"+(m[0].match(/\d{4,8}/)||[""])[0];confidence="high";break;}
    }
    // Also from URLs
    if(!rcNumber) allSnippets.forEach(r=>{
      if(rcNumber) return;
      const u=(r.link||"").match(/[/=]RC?(\d{5,8})/i)||(r.title||"").match(/^RC(\d{5,8})/i);
      if(u){rcNumber="RC"+u[1];confidence="high";}
    });
  }

  // ── Address ─────────────────────────────────────────────────────
  if(!address){
    const addrPats=[
      /(?:located at|headquartered at|registered (?:office|address)[:\s]+|address[:\s]+)([^\n.•]{15,140}(?:Street|Road|Avenue|Close|Way|Drive|Lane|Plaza|House|Estate|Crescent|Boulevard|Ring Road)[^\n.•]{0,80})/i,
      /(\d{1,4}[,\s]+[A-Z][a-zA-Z\s]{3,45}(?:Street|Road|Avenue|Close|Way|Drive|Lane|Plaza|Crescent|Boulevard)[^\n.•]{0,100})/,
      /((?:\d+[,\s]+)?(?:Plot|Block|Suite|Floor|Flat|No\.?\s*)?\s*\d*[,\s]*(?:Victoria Island|V\.?I\.?|Ikoyi|Lekki|Ajah|Ikeja|GRA|Surulere|Yaba|Marina|Apapa|Festac|Magodo|Ojota|Oregun|Agege)[^\n.•]{0,100})/i,
      /((?:\d+[,\s]+)?(?:Plot|Block|Suite|Floor|No\.?\s*)?\s*\d*[,\s]*(?:Maitama|Wuse|Garki|Asokoro|Gwarinpa|Abuja Municipal)[^\n.•]{0,100})/i,
      /((?:\d+[,\s]+)?(?:Plot|Block|No\.?\s*)?\s*\d*[,\s]*(?:Trans Amadi|Old GRA|New GRA|Rumuola|Elekahia|Port Harcourt|Diobu)[^\n.•]{0,100})/i,
      /((?:\d+[,\s]+)?[A-Z][a-zA-Z\s]{5,50}(?:Lagos|Abuja|Port Harcourt|Kano|Ibadan|Enugu|Kaduna|Benin City|Owerri|Uyo)[^\n.•]{0,60})/,
    ];
    for(const p of addrPats){const m=allText.match(p);if(m){address=m[0].replace(/^[\s,:]+/,"").replace(/^(?:located at|headquartered at|registered (?:office|address)[:\s]+|address[:\s]+)/i,"").trim().substring(0,150);break;}}
  }

  // ── Phone ───────────────────────────────────────────────────────
  if(!phone){
    // Nigerian phone: +234XXXXXXXXXX, 0XXXXXXXXXX (07x, 08x, 09x), also landlines
    const pm = allText.match(/(?:\+?234[-\s]?|0)(?:7[01]\d|8[01]\d|9[01]\d|[789]\d)\d{7,8}/)
             || allText.match(/0[789]\d{9}/);
    if(pm) phone=pm[0].replace(/[-\s]/g,"");
  }

  // ── Email ───────────────────────────────────────────────────────
  if(!email){
    const m=allText.match(/\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/);
    if(m && !/example|@google|@face|@twitter|@linked/i.test(m[0])) email=m[0];
  }

  // ── Website — scored, never junk ───────────────────────────────
  const SKIPDOMAINS=[
    "zoom.us","zoominfo.com","meet.google","teams.microsoft","webex","skype","gotomeeting","whereby","lusha.com","apollo.io","rocketreach",
    "facebook","instagram","twitter","x.com","tiktok","youtube","linkedin","snapchat",
    "businesslist","companiesng","naijafirms","vconnect","hotfrog","yellowpages","cylex",
    "ngcareers","jobberman","nairalist","nairametrics","businessday",
    "vanguard","punch","guardian","premiumtimes","dailytrust","thecable","channels",
    "thisdaylive","informationng","naijaloaded","legit.ng","pulse.ng","sunnewsonline",
    "efcc.gov","icpc.gov","cac.gov.ng","sec.gov","cbn.gov","firs.gov","ngxgroup",
    "google","wikipedia","amazon","microsoft","apple","wordpress.com","blogspot",
    "wix.com","weebly","squarespace","godaddy","namecheap","hostgator",
    "tripadvisor","yelp","foursquare","maps.google","openstreetmap",
    "opencorporates","dnb.com","crunchbase","zoominfo","apollo.io",
  ];
  if(!website){
    const bare2=searchBare.toLowerCase().replace(/[^a-z]/g,"");
    const candidates = allSnippets
      .map(r=>{const d=(r.displayLink||"").toLowerCase().replace(/^www\./,""); return {d,title:r.title||"",snippet:r.snippet||""};})
      .filter(({d})=> d && d.includes(".") && !SKIPDOMAINS.some(sk=>d.includes(sk)));
    const scored = candidates.map(({d,title,snippet})=>{
      let sc=1;
      if(d.endsWith(".ng")||d.endsWith(".com.ng")) sc+=4;
      if(d.endsWith(".org.ng")) sc+=3;
      if(d.endsWith(".org")||d.endsWith(".co")) sc+=2;
      // Domain contains company name words
      const dClean=d.replace(/[^a-z]/g,"");
      if(bare2.length>=4 && dClean.includes(bare2.slice(0,6))) sc+=3;
      // Snippet mentions "official website" or "contact us"
      if(/official\s*website|contact\s*us|our\s*website/i.test(title+snippet)) sc+=2;
      // Penalise aggregators that slipped through
      if(/directory|listing|find.*business|business.*find/i.test(title)) sc-=3;
      return {d,sc};
    }).sort((a,b)=>b.sc-a.sc);
    if(scored.length && scored[0].sc>=1) website="https://"+scored[0].d;
  }

  // ── OpenCorporates API (direct, most reliable for RC) ──────────
  if(!rcNumber || confidence!=="high"){
    try{
      const searchQ = encodeURIComponent(isRC ? (resolvedName||searchName||trimmed) : trimmed);
      const {s:ocS,b:ocB}=await get(`https://api.opencorporates.com/v0.4/companies/search?q=${searchQ}&jurisdiction_code=ng&per_page=5`);
      if(ocS===200 && ocB){
        const cos=(JSON.parse(ocB)?.results?.companies||[]);
        const bareLow=searchBare.toLowerCase();
        const match=cos.find(c=>{
          const n=(c.company?.name||"").toLowerCase();
          return n.includes(bareLow.slice(0,8))||bareLow.includes(n.slice(0,8));
        })||cos[0];
        if(match?.company){
          const oc=match.company;
          const ocNum=(oc.company_number||"").replace(/^0+/,"");
          if(!rcNumber||(confidence!=="high")){
            if(ocNum){rcNumber="RC"+ocNum;confidence="high";}
          }
          if(!incDate&&oc.incorporation_date) incDate=oc.incorporation_date;
          if(!status&&oc.current_status) status=oc.current_status;
          if(!companyType&&oc.company_type) companyType=oc.company_type;
          if(!resolvedName&&oc.name) resolvedName=oc.name;
          if(!address&&oc.registered_address?.street_address){
            address=[oc.registered_address.street_address,oc.registered_address.locality,oc.registered_address.region].filter(Boolean).join(", ");
          }
          // Seed from search result officers
          (oc.officers||[]).forEach(o=>{
            const nm=o.officer?.name||"";
            if(nm&&!directors.find(d=>d.name===nm))
              directors.push({name:nm,role:o.officer?.position||"Director",source:"opencorporates"});
          });
          // FETCH FULL COMPANY DETAIL (has officers list) — only if we have the company number
          if(ocNum && directors.length === 0){
            try{
              const {s:ocDS,b:ocDB}=await get(`https://api.opencorporates.com/v0.4/companies/gb/${ocNum}?jurisdiction_code=ng`).catch(()=>({s:0,b:""}));
              // OC full company: /companies/ng/{number}
              const {s:ocNS,b:ocNB}=await get(`https://api.opencorporates.com/v0.4/companies/ng/${ocNum}`);
              if(ocNS===200&&ocNB){
                const fullCo=JSON.parse(ocNB)?.results?.company;
                if(fullCo){
                  if(!incDate&&fullCo.incorporation_date) incDate=fullCo.incorporation_date;
                  if(!status&&fullCo.current_status) status=fullCo.current_status;
                  if(!address&&fullCo.registered_address?.street_address){
                    address=[fullCo.registered_address.street_address,fullCo.registered_address.locality,fullCo.registered_address.region].filter(Boolean).join(", ");
                  }
                  (fullCo.officers||[]).forEach(o=>{
                    const nm=o.officer?.name||"";
                    const pos=o.officer?.position||"Director";
                    if(nm&&!directors.find(d=>d.name===nm))
                      directors.push({name:nm,role:pos,source:"opencorporates"});
                  });
                }
              }
            }catch(_){}
          }
        }
      }
    }catch(_){}
  }

  // ── Incorporation date ──────────────────────────────────────────
  if(!incDate){const m=allText.match(/incorporat\w+\s+(?:on\s+)?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{1,2}\s+\w+\s+\d{4}|\d{4})/i);if(m)incDate=m[1];}

  // ── Company type ────────────────────────────────────────────────
  if(!companyType){const m=allText.match(/\b(Private Limited Company|Public Limited Company|PLC|Company Limited by Guarantee|Unlimited Company|Incorporated Trustee|Business Name)\b/i);if(m)companyType=m[1];}

  // ── Status ──────────────────────────────────────────────────────
  if(/struck off/i.test(allText)) status="Struck Off";
  else if(/dissolved/i.test(allText)) status="Dissolved";
  else if(/inactive/i.test(allText)) status="Inactive";

  // ── Deep director extraction from all text ──────────────────────
  const dirPat1=/\b([A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]\.)){1,4})\s*[,–\-]\s*((?:Group\s+)?(?:Executive\s+)?(?:Managing\s+)?(?:Non[-\s]?Executive\s+)?(?:Director|Chairman|Chief\s+\w+\s+Officer|CEO|MD|CFO|COO|CTO|President|Founder|Co[-\s]Founder|Vice\s+Chairman|Deputy\s+Chairman))/g;
  const dirPat2=/(Managing\s+Director|Group\s+Managing\s+Director|Executive\s+Chairman|Non[-\s]?Executive\s+(?:Director|Chairman)|Chief\s+Executive(?:\s+Officer)?|CEO|Chairman|Founder|Co[-\s]Founder|President|Director\s+General)[:\s,]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g;
  const dirPat3=/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:was\s+)?(?:appointed|serves?|named)\s+(?:as\s+)?(?:the\s+)?(?:new\s+)?((?:Managing\s+)?Director|Chairman|CEO|MD|Chief\s+\w+)/g;
  for(const pat of [dirPat1,dirPat2,dirPat3]){
    for(const m of allText.matchAll(pat)){
      let name,role;
      if(pat===dirPat2){role=m[1].trim();name=m[2].trim();}
      else{name=m[1].trim();role=m[2].trim();}
      name=name.replace(/^(Mr\.?|Mrs\.?|Dr\.?|Prof\.?|Alhaji|Chief|Sir|Engr\.?)\s+/i,"").trim();
      if(name.length>4 && name.length<55 && !directors.find(d=>d.name===name))
        directors.push({name,role,source:"organic"});
    }
  }

  // ── Shareholders ────────────────────────────────────────────────
  const shrPat=/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[–\-(:,]\s*(\d+(?:\.\d+)?)\s*(?:%|percent|per\s+cent)/g;
  for(const m of allText.matchAll(shrPat)){
    if(!shareholders.find(s=>s.name===m[1])) shareholders.push({name:m[1].trim(),percentage:m[2]+"%",type:"Ordinary"});
  }

  // ── State from address ──────────────────────────────────────────
  const addrLow=(address||"").toLowerCase();
  const STATES={lagos:"Lagos",abuja:"FCT","f.c.t":"FCT",rivers:"Rivers",kano:"Kano",oyo:"Oyo",anambra:"Anambra",delta:"Delta",enugu:"Enugu",kaduna:"Kaduna",ogun:"Ogun",ondo:"Ondo",edo:"Edo","cross river":"Cross River","akwa ibom":"Akwa Ibom",imo:"Imo",abia:"Abia"};
  for(const[k,v] of Object.entries(STATES)){if(addrLow.includes(k)){state=v;break;}}
  if(!state){
    if(/victoria island|ikoyi|lekki|ikeja|surulere|yaba|marina|apapa/i.test(addrLow)) state="Lagos";
    else if(/maitama|wuse|garki|asokoro|gwarinpa/i.test(addrLow)) state="FCT";
    else if(/gra|trans amadi|rumuola|port harcourt/i.test(addrLow)) state="Rivers";
  }

  // ── Deduplicate + rank directors ───────────────────────────────
  const RANK={"Chairman":1,"Executive Chairman":1,"Non-Executive Chairman":2,"Managing Director":2,"Group Managing Director":2,"CEO":2,"Chief Executive Officer":2,"Founder":3,"Co-Founder":3,"CFO":4,"COO":4,"CTO":4,"Director":5};
  directors=[...new Map(directors.filter(d=>d.name&&d.name.length>3).map(d=>[d.name.toLowerCase(),d])).values()];
  directors.sort((a,b)=>(RANK[a.role]||6)-(RANK[b.role]||6));
  directors=directors.slice(0,15);

  // ── INDIVIDUAL PATH ─────────────────────────────────────────────
  if(!isCompany){
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
    if(companies.length||directors.length){out.found=true;out.confidence="medium";}
    out.data={name:trimmed,pep_status:false,companies:[...new Map(companies.map(c=>[c.company,c])).values()].slice(0,10),address:address||"—",phone:phone||"—",email:email||"—",website:website||"—",cac_found:out.found,confidence:out.confidence,_source:"serp_v8"};
    out.foot_traffic=footTraffic;
    out.raw_records=[out.data];
    return out;
  }

  // ── COMPANY PATH ────────────────────────────────────────────────
  if(rcNumber||directors.length||(address&&address!=="—")||website||phone){
    out.found=true;
    out.confidence=rcNumber?"high":directors.length>2?"medium":"low";
  }

  // Best display name
  const bestName = resolvedName
    ||(isRC&&allSnippets.find(r=>r.title&&!/opencorporates|businesslist|companiesng|naijafirms|google/i.test(r.title))?.title?.split(/[-|]/)[0]?.trim())
    ||trimmed;

  out.data={
    name:bestName,
    rc_number:rcNumber||(isRC?`RC${rcNum}`:"—"),
    status,type:companyType||"—",
    address:address||"—",incorporated:incDate||"—",
    email:email||"—",phone:phone||"—",website:website||"—",
    state:state||"—",share_capital:"—",
    directors,shareholders:shareholders.slice(0,8),
    related_companies:relatedCos.slice(0,6),
    confidence:out.confidence,_source:"serp_v8",
    _query_count:queries.length,
  };
  out.foot_traffic=footTraffic;
  out.raw_records=[out.data];
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


// ══════════════════════════════════════════════════════════════════
// ENFORCEMENT SCAN HELPERS
// Uses broad token-level matching (not exact quoted search)
// so partial names, first-name-only, aliases all work
// ══════════════════════════════════════════════════════════════════

// Build smart query: no exact quotes, just tokens — finds partial name matches
function enfQuery(name, site='') {
  const tokens = name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
  return site ? `${tokens} ${site}` : tokens;
}

// Check if a result's text contains enough name tokens to be a real match
function nameMatch(text, name) {
  const tl = text.toLowerCase();
  const tokens = name.toLowerCase().split(/\s+/).filter(t=>t.length>1);
  if(!tokens.length) return false;
  // For single names/tokens: direct include
  if(tokens.length === 1) return tl.includes(tokens[0]);
  // For multi-token: need at least 50% of tokens to appear
  const matched = tokens.filter(t=>tl.includes(t)).length;
  return matched >= Math.ceil(tokens.length * 0.5);
}

function enfSeverity(text) {
  const t = text.toLowerCase();
  if(/convicted|sentenced|guilty|imprisonment|jailed|years?.prison/.test(t)) return 'HIGH';
  if(/arraigned|charged|prosecuted|indicted|trial/.test(t)) return 'MEDIUM';
  return 'LOW';
}

// ── 2. EFCC ───────────────────────────────────────────────────────
// KEY: EFCC wanted list = individual pages per person.
// URL: efcc.gov.ng/efcc/news-and-information/wanted-persons-1/ID-NAME
// Title = the person's full name. Query without quotes finds partial matches.
async function scanEFCC(name){
  const out={source:"EFCC",found:false,records:[]};
  try{
    const tokens = name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
    const [wantedPageRes, siteRes, newsRes, broadRes] = await Promise.all([
      // 1. Wanted persons sub-section — names ARE the page titles
      gSearch(`${tokens} site:efcc.gov.ng/efcc/news-and-information/wanted-persons-1`, 8),
      // 2. Full EFCC site — press releases, arraignment notices, convictions
      gSearch(`${tokens} site:efcc.gov.ng`, 8),
      // 3. Top Nigerian news + legal sites covering EFCC cases
      gSearch(`${tokens} EFCC (arraigned OR convicted OR arrested OR sentenced OR "on trial") site:punchng.com OR site:vanguardngr.com OR site:premiumtimesng.com OR site:thenigerialawyer.com`, 8),
      // 4. Broad Nigeria enforcement coverage
      gSearch(`${tokens} Nigeria EFCC (arraigned OR convicted OR arrested OR charged OR "money laundering" OR fraud)`, 6),
    ]);

    const allResults=[
      ...(wantedPageRes||[]).map(r=>({...r,_wantedPage:true})),
      ...(siteRes||[]),
      ...(newsRes||[]),
      ...(broadRes||[]),
    ];

    allResults.forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(!nameMatch(t, name)) return;
      if(out.records.find(x=>x.url===r.link)) return;
      out.found=true;
      const sev = r._wantedPage ? "HIGH" : enfSeverity(t);
      const isOfficial = (r.link||"").includes("efcc.gov.ng");
      out.records.push({
        type: r._wantedPage ? "EFCC_WANTED" : isOfficial ? "EFCC_OFFICIAL" : "EFCC_COVERAGE",
        title: r.title, snippet: r.snippet,
        url: r.link, source: r.displayLink||"efcc.gov.ng",
        severity: sev, date: r.date||"",
      });
    });

    const sevOrd={HIGH:0,MEDIUM:1,LOW:2};
    out.records.sort((a,b)=>(sevOrd[a.severity]||2)-(sevOrd[b.severity]||2));
    out.records=out.records.slice(0,10);
  }catch(e){out.error=e.message;}
  return out;
}

// ── 3. ICPC ───────────────────────────────────────────────────────
async function scanICPC(name){
  const out={source:"ICPC",found:false,records:[]};
  try{
    const tokens = name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
    const [siteRes, newsRes] = await Promise.all([
      gSearch(`${tokens} site:icpc.gov.ng`, 6),
      gSearch(`${tokens} ICPC (arraigned OR convicted OR arrested OR "on trial" OR charged) Nigeria`, 6),
    ]);
    [...(siteRes||[]),...(newsRes||[])].forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(!nameMatch(t, name)) return;
      if(out.records.find(x=>x.url===r.link)) return;
      out.found=true;
      out.records.push({type:"ICPC_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:r.displayLink||"icpc.gov.ng",severity:enfSeverity(t),date:r.date||""});
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 4. CBN ────────────────────────────────────────────────────────
async function scanCBN(name){
  const out={source:"CBN",found:false,records:[]};
  try{
    const tokens = name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
    const [debarRes, googleRes] = await Promise.all([
      get("https://www.cbn.gov.ng/Supervision/Inst-DBar.asp"),
      gSearch(`${tokens} site:cbn.gov.ng`, 5),
    ]);
    if(debarRes.s===200 && debarRes.b && nameMatch(debarRes.b, name)){
      out.found=true;
      out.records.push({type:"CBN_DEBARMENT",title:`${name} — CBN Debarred List`,detail:`Name found in CBN debarred institutions/persons list`,severity:"HIGH",source:"cbn.gov.ng",url:"https://www.cbn.gov.ng/Supervision/Inst-DBar.asp"});
    }
    (googleRes||[]).forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(!nameMatch(t,name)) return;
      if(out.records.find(x=>x.url===r.link)) return;
      out.found=true;
      out.records.push({type:"CBN_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:"cbn.gov.ng",severity:"MEDIUM",date:r.date||""});
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 5. SEC ────────────────────────────────────────────────────────
async function scanSEC(name){
  const out={source:"SEC Nigeria",found:false,records:[]};
  try{
    const tokens = name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
    const res = await gSearch(`${tokens} site:sec.gov.ng`, 5);
    (res||[]).forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(!nameMatch(t,name)) return;
      if(out.records.find(x=>x.url===r.link)) return;
      out.found=true;
      const isSanction=/deregister|suspend|sanction|enforcement|revok/i.test(t);
      out.records.push({type:isSanction?"SEC_SANCTION":"SEC_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:"sec.gov.ng",severity:isSanction?"HIGH":"LOW",date:r.date||""});
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 6. Courts ─────────────────────────────────────────────────────
async function scanCourts(name){
  const out={source:"Court Records",found:false,records:[]};
  try{
    const tokens = name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
    const [courtRes, legalRes] = await Promise.all([
      gSearch(`${tokens} (site:nicn.gov.ng OR site:courtofappeal.gov.ng OR site:supremecourt.gov.ng) judgment`, 6),
      gSearch(`${tokens} Nigeria court judgment (site:legalnaija.com OR site:lawpavilion.com OR site:legalpedia.com OR site:thenigerialawyer.com)`, 6),
    ]);
    [...(courtRes||[]),...(legalRes||[])].forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(!nameMatch(t,name)) return;
      if(out.records.find(x=>x.url===r.link)) return;
      out.found=true;
      out.records.push({type:"COURT_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:r.displayLink||"court",severity:enfSeverity(t),date:r.date||""});
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 7. FIRS ───────────────────────────────────────────────────────
async function scanFIRS(name){
  const out={source:"FIRS",found:false,records:[]};
  try{
    const tokens = name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
    const [siteRes, newsRes] = await Promise.all([
      gSearch(`${tokens} site:firs.gov.ng`, 4),
      gSearch(`${tokens} FIRS "tax" Nigeria (evade OR default OR prosecution OR liability)`, 4),
    ]);
    [...(siteRes||[]),...(newsRes||[])].forEach(r=>{
      const t=(r.title||"")+" "+(r.snippet||"");
      if(!nameMatch(t,name)) return;
      if(out.records.find(x=>x.url===r.link)) return;
      out.found=true;
      out.records.push({type:"FIRS_NOTICE",title:r.title,snippet:r.snippet,url:r.link,source:r.displayLink||"firs.gov.ng",severity:"MEDIUM",date:r.date||""});
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

// ── ENTITY PHOTO LOOKUP ─────────────────────────────────────────
// ── COMPANY LOGO — Clearbit + Google Favicon fallback ────────────
async function getCompanyLogo(website, companyName){
  if(!website || website==="—") return null;
  try{
    // Strip protocol/www
    const domain = website.replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0];
    if(!domain || domain.length < 4) return null;
    // Clearbit Logo API — free, no key, returns 128px PNG
    const clearbitUrl = `https://logo.clearbit.com/${domain}`;
    const {s} = await get(clearbitUrl);
    if(s===200) return { url: clearbitUrl, source:"clearbit", domain };
    // Fallback: Google S2 favicon (higher quality than favicon.ico)
    const googleFav = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    return { url: googleFav, source:"favicon", domain };
  }catch(_){ return null; }
}

// ── INDIVIDUAL PHOTO — LinkedIn via SerpApi image search + Wikipedia ──
async function getEntityPhoto(name){
  if(!name||name.length<4) return null;
  const nameParts=name.toLowerCase().split(" ").filter(p=>p.length>2);
  if(nameParts.length<2) return null;

  // 1. Wikipedia — highest trust
  try{
    const slug=name.trim().replace(/\s+/g,"_");
    const {s:ws,b:wb}=await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`);
    if(ws===200&&wb){
      const w=JSON.parse(wb);
      const tl=(w.title||"").toLowerCase();
      if(nameParts.filter(p=>tl.includes(p)).length>=Math.min(2,nameParts.length)&&w.thumbnail?.source){
        return {url:w.thumbnail.source.replace(/\/\d+px-/,"/240px-"),source:"wikipedia",verified:true,caption:w.description||"",wikiUrl:w.content_urls?.desktop?.page||"",socialVerified:false};
      }
    }
  }catch(_){}

  if(!SERPAPI_KEY) return null;

  // 2. Knowledge Graph — verified by name match in title
  try{
    const kg=await serpFull(`"${name}" Nigeria`, 3);
    if(kg.kg?.image){
      const kgT=(kg.kg.title||"").toLowerCase();
      if(nameParts.filter(p=>kgT.includes(p)).length>=Math.min(2,nameParts.length)){
        return {url:kg.kg.image,source:"knowledge_graph",verified:true,caption:kg.kg.description||"",socialVerified:false};
      }
    }
  }catch(_){}

  // 3. LinkedIn — only when URL slug actually contains name parts (anti-hallucination)
  try{
    const liRes=await serpFull(`"${name}" site:linkedin.com/in Nigeria`,4);
    const slugParts=nameParts;
    const liHit=(liRes.organic||[]).find(r=>{
      const link=(r.link||"").toLowerCase();
      if(!link.includes("linkedin.com/in/")||!r.thumbnail) return false;
      const title=(r.title||"").toLowerCase();
      const snip=(r.snippet||"").toLowerCase();
      // Must match at least 2 name parts across link+title+snippet
      return slugParts.filter(p=>link.includes(p)||title.includes(p)||snip.includes(p)).length>=2;
    });
    if(liHit?.thumbnail){
      return {url:liHit.thumbnail,source:"linkedin",verified:true,caption:liHit.snippet||"",profileUrl:liHit.link||"",socialVerified:true};
    }
  }catch(_){}

  return null; // Never show unverified photo
}

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
      // Use real address if we have it, otherwise geocode by company/person name
      const hasRealAddr = address && address !== "—" && address.length > 5;
      const geoTerm = hasRealAddr ? address : entity;
      const q=encodeURIComponent(`${geoTerm}, Nigeria`);
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
    entity: cac.data?.name||entity, type:isCompany?"Company":"Individual",
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
  // RC number searches always treated as company searches
  const isRCSearch = /^(RC\s*)?(\d{4,8})$/i.test(entity.trim());
  const isCompany = isRCSearch ? true : entityType==="company";
  const effectiveType = isRCSearch ? "company" : entityType;

  try{
    const[cac,efcc,icpc,cbn,sec,courts,firs,news,cacPortal]=await Promise.all([
      scanCAC(entity,isCompany),
      scanEFCC(entity),scanICPC(entity),scanCBN(entity),scanSEC(entity),scanCourts(entity),scanFIRS(entity),
      scanNews(entity),
      isCompany ? cacDirect(entity).catch(()=>({found:false,source:'error',companies:[]})) : Promise.resolve({found:false,companies:[]}),
    ]);

    // ── Merge CAC portal results into main cac object ─────────────
    if(cacPortal.found && cacPortal.companies.length) {
      const best = cacPortal.companies[0]; // best match first
      // Upgrade fields if portal has better data
      if(!cac.found || cac.confidence !== 'high') {
        cac.found = true;
        cac.confidence = 'high';
        cac.data = cac.data || {};
        if(!cac.data.name || cac.data.name === entity) cac.data.name = best.name;
        if(!cac.data.rc_number || cac.data.rc_number === '—') cac.data.rc_number = best.rc_number;
        if(!cac.data.status || cac.data.status === 'Active') cac.data.status = best.status;
        if(!cac.data.type || cac.data.type === '—') cac.data.type = best.type;
        if(!cac.data.address || cac.data.address === '—') cac.data.address = best.address;
        if(!cac.data.email || cac.data.email === '—') cac.data.email = best.email;
        if(!cac.data.incorporated || cac.data.incorporated === '—') cac.data.incorporated = best.incorporated;
        if(!cac.data.state || cac.data.state === '—') cac.data.state = best.state;
        // Merge directors — portal directors take priority (official source)
        const existingDirNames = new Set((cac.data.directors||[]).map(d=>d.name.toLowerCase()));
        const portalDirs = best.directors.filter(d => !existingDirNames.has(d.name.toLowerCase()));
        cac.data.directors = [...best.directors, ...(cac.data.directors||[]).filter(d=>!best.directors.find(p=>p.name.toLowerCase()===d.name.toLowerCase()))];
        // Merge shareholders
        if(best.shareholders.length) {
          const existingShr = new Set((cac.data.shareholders||[]).map(s=>s.name.toLowerCase()));
          cac.data.shareholders = [...best.shareholders, ...(cac.data.shareholders||[]).filter(s=>!best.shareholders.find(p=>p.name.toLowerCase()===s.name.toLowerCase()))];
        }
        cac.data._portal_source = cacPortal.source;
        cac.data._portal_matches = cacPortal.companies.length;
      }
    }

    const reg={efcc,icpc,cbn,sec,courts,firs};
    const scores=scoreRisk(cac,reg,news);
    const address=cac.data?.address||"Lagos, Nigeria";
    const[geo,network,photo,logo]=await Promise.all([
      geocode(address,entity),
      Promise.resolve(buildNetwork(entity,cac,isCompany,efcc,icpc,news)),
      !isCompany ? getEntityPhoto(entity).catch(()=>null) : Promise.resolve(null),
      isCompany ? getCompanyLogo(cac.data?.website, entity).catch(()=>null) : Promise.resolve(null),
    ]);

    const intel={cac,efcc,icpc,cbn,sec,courts,firs,news,scores};
    let summary="";
    try{summary=await synthesize(entity,isCompany,intel);}
    catch(e){summary=`**${entity}** — Risk: **${scores.rating}**. ${cac.found?`CAC: RC ${cac.data?.rc_number||"—"}, ${cac.data?.status||"Active"}.`:"Not found in CAC registry."} ${efcc.found?"⚠ EFCC records found.":""} ${courts.found?"⚠ Court records found.":""} ${news.articles?.length?`${news.articles.length} media articles found.`:""}`;}

    return res.status(200).json({
      text:summary,
      data:{
        entity,type:effectiveType||entityType,
        company:isCompany?{
          name:cac.data?.name||entity,
          logo: logo||null,
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
          photo: photo || null,
        }:{},
        regulatory:{efcc,icpc,cbn,sec,courts,firs,total_hits:[efcc,icpc,cbn,sec,courts,firs].filter(x=>x.found).length},
        media:news,network,scores,
        geo:{address,lat:geo.lat,lng:geo.lng,mapbox_token:MAPBOX_TOKEN||"",source:geo.source},
      foot_traffic: cac.foot_traffic||null,
      }
    });
  }catch(e){
    console.error("Check Am error:",e.message,e.stack);
    return res.status(500).json({error:e.message});
  }
};
