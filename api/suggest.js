// ══════════════════════════════════════════════════════════════════
// Check Am — /api/suggest  (Smart Autocomplete v2)
// 
// Strategy:
//  1. SerpApi → Google search scoped to official sources
//     - CAC: site:search.cac.gov.ng OR site:opencorporates.com/companies/ng
//     - EFCC: site:efccnigeria.org/efcc OR "EFCC watchlist"
//     - Individuals: LinkedIn Nigeria, Wikipedia, news
//  2. OpenCorporates direct API (free, no key)
//  3. Deduplicate + score + rank
//
// Returns rich suggestion objects with source, RC, status, role
// ══════════════════════════════════════════════════════════════════

const https = require('https');

function cleanKey(r){ return String(r||'').replace(/[^\x21-\x7E]/g,'').trim(); }
let SERPAPI_KEY = '';
function refreshKeys(){ SERPAPI_KEY = cleanKey(process.env.SERPAPI_KEY); }

function get(url, hdrs={}, ms=8000){
  return new Promise(resolve=>{
    try{
      const req = https.get(url,{
        headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120','Accept':'application/json,*/*',...hdrs}
      }, res=>{
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location)
          return get(res.headers.location,hdrs,ms).then(resolve);
        let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({s:res.statusCode,b}));
      });
      req.on('error',()=>resolve({s:0,b:''}));
      req.setTimeout(ms,()=>{req.destroy();resolve({s:0,b:''});});
    }catch(_){resolve({s:0,b:''});}
  });
}

// ── SerpApi search helper ─────────────────────────────────────────
async function serp(query, num=8, params='') {
  if(!SERPAPI_KEY) return [];
  try{
    const url = `https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&engine=google&gl=ng&hl=en&num=${num}&q=${encodeURIComponent(query)}${params}`;
    const {s,b} = await get(url);
    if(s!==200) return [];
    const j = JSON.parse(b);
    return {
      organic: j.organic_results||[],
      kg: j.knowledge_graph||null,
      related: j.related_searches||[],
    };
  }catch(_){return {organic:[],kg:null,related:[]};}
}

// ── OpenCorporates free API ───────────────────────────────────────
async function ocSearch(query, isRC) {
  const results = [];
  try{
    const url = isRC
      ? `https://api.opencorporates.com/v0.4/companies/ng/${query.replace(/^RC\s*/i,'')}?sparse=true`
      : `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(query)}&jurisdiction_code=ng&per_page=8&sparse=true`;
    const {s,b} = await get(url);
    if(s!==200||!b) return [];
    const j = JSON.parse(b);
    const list = isRC
      ? (j.results?.company ? [j.results.company] : [])
      : (j.results?.companies||[]).map(c=>c.company);
    list.forEach(co=>{
      if(!co) return;
      const rc = String(co.company_number||'').replace(/^0+/,'');
      results.push({
        label: co.name||'',
        sublabel: `RC${rc}${co.current_status?' · '+co.current_status:''} · ${co.incorporation_date?co.incorporation_date.substring(0,4):'?'}${co.registered_address?.in_full?' · '+co.registered_address.in_full.substring(0,40):''}`,
        value: co.name||'',
        rc: rc ? 'RC'+rc : '',
        status: co.current_status||'Active',
        type: 'company',
        source: 'CAC',
        score: 90,
        ocUrl: co.opencorporates_url||'',
      });
    });
  }catch(_){}
  return results;
}

// ── Extract company suggestions from SerpApi organic results ──────
function extractCompanySuggestions(organic, kg, query) {
  const results = [];
  const seen = new Set();

  // Knowledge graph — most trusted
  if(kg?.title && kg.title.length > 2) {
    const rcM = (kg.description||'').match(/RC[\s\-]?(\d{4,8})/i) || (kg.title||'').match(/(\d{6,8})/);
    const slug = kg.title.toLowerCase();
    if(!seen.has(slug)){
      seen.add(slug);
      results.push({
        label: kg.title,
        sublabel: kg.description ? kg.description.substring(0,90) : 'Knowledge Graph result',
        value: kg.title,
        rc: rcM ? 'RC'+rcM[1] : '',
        type: 'company',
        source: 'CAC',
        score: 100,
      });
    }
  }

  // Organic results — parse CAC / OC / official sources first
  organic.forEach(r=>{
    const link = r.link||'';
    const title = (r.title||'').replace(/ - CAC.*$/i,'').replace(/ \| .*$/,'').replace(/\s*-\s*OpenCorporates.*$/i,'').trim();
    const snippet = r.snippet||'';
    if(title.length < 3) return;
    const slug = title.toLowerCase();
    if(seen.has(slug)) return;

    // RC extraction
    const text = title+' '+snippet;
    const rcM = text.match(/RC[\s\-:]?(\d{4,8})/i) || snippet.match(/(\d{6,8})/);
    const rc = rcM ? 'RC'+rcM[1].replace(/^0+/,'') : '';

    // Status
    const statusM = snippet.match(/\b(ACTIVE|INACTIVE|STRUCK OFF|DISSOLVED)\b/i);
    const status = statusM ? statusM[1] : 'Active';

    // Score by source quality
    let score = 50;
    if(link.includes('search.cac.gov.ng')) score = 95;
    else if(link.includes('opencorporates.com/companies/ng')) score = 88;
    else if(link.includes('companiesng.com')||link.includes('rc-number.com')) score = 70;
    else if(link.includes('businesslist.com.ng')||link.includes('ngcareers.com')) score = 55;

    // Sub-label
    let sublabel = '';
    if(rc) sublabel += rc + ' · ';
    sublabel += status;
    if(snippet && snippet.length > 20) sublabel += ' · ' + snippet.substring(0,70);

    seen.add(slug);
    results.push({ label:title, sublabel, value:title, rc, type:'company', source: score>=88?'CAC':'Web', score });
  });

  return results.sort((a,b)=>b.score-a.score);
}

// ── Extract individual suggestions from SerpApi results ───────────
function extractIndividualSuggestions(organic, kg, query) {
  const results = [];
  const seen = new Set();
  const qLower = query.toLowerCase();

  // Knowledge graph person
  if(kg?.title && (kg.type||'').toLowerCase().includes('person') || kg?.description) {
    const slug = (kg?.title||'').toLowerCase();
    if(kg?.title && !seen.has(slug)){
      seen.add(slug);
      results.push({
        label: kg.title,
        sublabel: [kg.description, kg.type].filter(Boolean).join(' · ').substring(0,90),
        value: kg.title,
        type: 'individual',
        source: 'KG',
        score: 100,
      });
    }
  }

  organic.forEach(r=>{
    const link = r.link||'';
    const title = (r.title||'').trim();
    const snippet = r.snippet||'';
    if(title.length < 4) return;

    // Extract person name — LinkedIn "Name - Title at Company"
    let personName = title;
    let role = '';
    let company = '';

    const liMatch = title.match(/^(.+?)\s*[-–|]\s*(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[-|].*)?$/i);
    const liSimple = title.match(/^(.+?)\s*[-–|]\s*(.+?)(?:\s*[-|].*)?$/i);
    const wikiMatch = title.match(/^(.+?)\s*[-|–]\s*Wikipedia/i);

    if(wikiMatch) {
      personName = wikiMatch[1].trim();
      role = snippet.substring(0,60);
    } else if(liMatch) {
      personName = liMatch[1].trim();
      role = liMatch[2].trim();
      company = liMatch[3].trim();
    } else if(liSimple && link.includes('linkedin')) {
      personName = liSimple[1].trim();
      role = liSimple[2].trim();
    } else if(link.includes('linkedin')||link.includes('wikipedia')||link.includes('bloomberg')) {
      // Use title as-is for trusted sources
    } else {
      // Generic web result — only include if query words match
      const nameParts = qLower.split(' ').filter(p=>p.length>2);
      const nameMatch = nameParts.filter(p=>personName.toLowerCase().includes(p)).length;
      if(nameMatch < Math.min(2, nameParts.length)) return;
    }

    // Only include if name contains query tokens
    const nameParts = qLower.split(' ').filter(p=>p.length>1);
    const matchCount = nameParts.filter(p=>personName.toLowerCase().includes(p)).length;
    if(matchCount < 1) return;

    const slug = personName.toLowerCase();
    if(seen.has(slug)) return;
    seen.add(slug);

    let sublabel = '';
    if(role) sublabel += role;
    if(company) sublabel += (sublabel?' at ':'')+company;
    if(!sublabel && snippet) sublabel = snippet.substring(0,80);

    let score = 50;
    if(link.includes('linkedin.com/in/')) score = 85;
    else if(link.includes('wikipedia.org')) score = 90;
    else if(link.includes('bloomberg.com')||link.includes('businessday.ng')) score = 75;

    results.push({
      label: personName,
      sublabel,
      value: personName,
      type: 'individual',
      source: link.includes('linkedin')?'LinkedIn':link.includes('wikipedia')?'Wikipedia':'Web',
      role, company,
      score,
    });
  });

  return results.sort((a,b)=>b.score-a.score);
}

// ── EFCC / enforcement watchlist suggestions ──────────────────────
async function enforcementSuggest(query) {
  if(!SERPAPI_KEY) return [];
  try{
    const q = `"${query}" (EFCC OR ICPC OR "wanted" OR "arraigned" OR "convicted") Nigeria`;
    const {organic} = await serp(q, 5);
    const results = [];
    const seen = new Set();
    organic.forEach(r=>{
      const title = (r.title||'').replace(/ - .*$/,'').trim();
      const snippet = r.snippet||'';
      const link = r.link||'';
      const isEFCC = link.includes('efcc')||snippet.toLowerCase().includes('efcc');
      const isICPC = link.includes('icpc')||snippet.toLowerCase().includes('icpc');
      if(!title || title.length < 3) return;
      // Extract name if this looks like an enforcement record
      const slug = title.toLowerCase();
      if(seen.has(slug)) return;
      seen.add(slug);
      const agency = isEFCC?'EFCC':isICPC?'ICPC':'Enforcement';
      results.push({
        label: title,
        sublabel: `⚠ ${agency} record · ${snippet.substring(0,70)}`,
        value: title,
        type: 'individual',
        source: agency,
        isEnforcement: true,
        score: 70,
      });
    });
    return results.slice(0,3);
  }catch(_){return [];}
}

// ── News-sourced name suggestions ─────────────────────────────────
async function newsSuggest(query, isCompany) {
  if(!SERPAPI_KEY) return [];
  try{
    const scope = isCompany
      ? `"${query}" Nigeria company business (site:businessday.ng OR site:guardian.ng OR site:nairametrics.com)`
      : `"${query}" Nigeria (site:guardian.ng OR site:businessday.ng OR site:premiumtimesng.com OR site:linkedin.com/in)`;
    const {organic, kg} = await serp(scope, 6);
    if(isCompany) return extractCompanySuggestions(organic, kg, query).slice(0,3);
    return extractIndividualSuggestions(organic, kg, query).slice(0,3);
  }catch(_){return [];}
}

// ══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  refreshKeys();
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const q = (req.query?.q||'').trim();
  const type = req.query?.type||'company';
  if(q.length < 2) return res.status(200).json({suggestions:[]});

  const isRC = /^(RC\s*)?(\d{4,8})$/i.test(q);
  const isCompany = type === 'company';

  try{
    let suggestions = [];

    if(isCompany) {
      // ── COMPANY suggest ──────────────────────────────────────────
      // Run OC + SerpApi in parallel
      const serpQuery = isRC
        ? `RC${q.replace(/^RC\s*/i,'')} Nigeria company CAC`
        : `"${q}" Nigeria company CAC registered`;
      const [ocRes, serpRes, newsRes] = await Promise.all([
        ocSearch(q, isRC),
        serp(serpQuery, 8),
        newsSuggest(q, true),
      ]);

      // OC results first (most structured)
      ocRes.forEach(r=>{ if(!suggestions.find(s=>s.value.toLowerCase()===r.value.toLowerCase())) suggestions.push(r); });

      // SerpApi organic + KG
      const serpSugs = extractCompanySuggestions(serpRes.organic||[], serpRes.kg, q);
      serpSugs.forEach(r=>{ if(!suggestions.find(s=>s.value.toLowerCase()===r.value.toLowerCase())) suggestions.push(r); });

      // News fills gaps
      newsRes.forEach(r=>{ if(!suggestions.find(s=>s.value.toLowerCase()===r.value.toLowerCase())) suggestions.push(r); });

    } else {
      // ── INDIVIDUAL suggest ───────────────────────────────────────
      // 1: Direct LinkedIn/Wikipedia/news search
      const liQuery = `"${q}" Nigeria (site:linkedin.com/in OR site:wikipedia.org OR site:bloomberg.com)`;
      // 2: CAC director via SerpApi
      const cacDirQuery = `"${q}" director Nigeria CAC site:search.cac.gov.ng OR site:opencorporates.com/companies/ng`;
      // 3: EFCC / enforcement
      const [liRes, cacDirRes, enfRes] = await Promise.all([
        serp(liQuery, 6),
        serp(cacDirQuery, 4),
        enforcementSuggest(q),
      ]);

      const liSugs = extractIndividualSuggestions(liRes.organic||[], liRes.kg, q);
      liSugs.forEach(r=>{ if(!suggestions.find(s=>s.value.toLowerCase()===r.value.toLowerCase())) suggestions.push(r); });

      // CAC director records — extract names from OC results
      const cacSugs = extractIndividualSuggestions(cacDirRes.organic||[], null, q);
      cacSugs.forEach(r=>{ r.source='CAC'; r.score+=10; if(!suggestions.find(s=>s.value.toLowerCase()===r.value.toLowerCase())) suggestions.push(r); });

      // EFCC/enforcement hits
      enfRes.forEach(r=>{ if(!suggestions.find(s=>s.value.toLowerCase()===r.value.toLowerCase())) suggestions.push(r); });
    }

    // Final sort + truncate
    suggestions.sort((a,b)=>(b.score||50)-(a.score||50));

    return res.status(200).json({
      suggestions: suggestions.slice(0,8),
      query: q,
      is_rc: isRC,
    });
  }catch(e){
    return res.status(500).json({suggestions:[], error:e.message});
  }
};
