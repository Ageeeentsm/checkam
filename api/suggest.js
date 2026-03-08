// ══════════════════════════════════════════════════════════════════
// Check Am — /api/suggest  v4  (clean rewrite)
//
// OC direct API is DNS-blocked on Vercel → SerpApi only
// Best company source: site:opencorporates.com/companies/ng QUERY
//   OC page titles = "COMPANY NAME - RC_NUMBER (Nigeria) - OpenCorporates"
//   RC is always in the title/URL → easy extraction
// Individual: LinkedIn + Wikipedia + EFCC wanted subpath
// ══════════════════════════════════════════════════════════════════

const https = require('https');

function cleanKey(r){ return String(r||'').replace(/[^\x21-\x7E]/g,'').trim(); }
let SERPAPI_KEY = '';
function refreshKeys(){ SERPAPI_KEY = cleanKey(process.env.SERPAPI_KEY); }

function get(url, ms=10000){
  return new Promise(resolve=>{
    try{
      const req = https.get(url, {
        headers:{'User-Agent':'Mozilla/5.0 Chrome/124','Accept':'application/json,*/*'}
      }, res=>{
        if([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
          return get(res.headers.location, ms).then(resolve);
        let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({s:res.statusCode,b}));
      });
      req.on('error', ()=>resolve({s:0,b:''}));
      req.setTimeout(ms, ()=>{ req.destroy(); resolve({s:0,b:''}); });
    } catch(_){ resolve({s:0,b:''}); }
  });
}

async function serp(q, num=8){
  if(!SERPAPI_KEY) return [];
  try{
    const url = `https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&engine=google&gl=ng&hl=en&num=${num}&safe=off&q=${encodeURIComponent(q)}`;
    const {s,b} = await get(url, 12000);
    if(s !== 200 || !b) return [];
    const j = JSON.parse(b);
    // Attach kg to first result so callers can access it
    const organic = j.organic_results || [];
    if(j.knowledge_graph) organic._kg = j.knowledge_graph;
    return organic;
  } catch(_){ return []; }
}

// ── Clean OC title → company name ────────────────────────────────
// OC format: "COMPANY NAME - 1234567 (Nigeria) - OpenCorporates"
// CAC format: "COMPANY NAME - CAC - Nigeria"
// Generic:    "COMPANY NAME | Some Site"
function cleanTitle(title){
  return (title||'')
    .replace(/\s*-\s*\d{4,8}\s*\(Nigeria\).*/i, '')   // OC: "Name - 123456 (Nigeria)"
    .replace(/\s*-\s*OpenCorporates.*/i, '')              // OC suffix
    .replace(/\s*-\s*CAC.*/i, '')                         // CAC suffix
    .replace(/\s*-\s*Economic.*Commission.*/i, '')        // EFCC full name
    .replace(/\s*-\s*EFCC.*/i, '')
    .replace(/\s*-\s*ICPC.*/i, '')
    .replace(/\s*\|.*/,'')                                // pipe separators
    .replace(/\s+/g,' ')
    .trim();
}

// Extract RC from OC URL or title/snippet
function extractRC(url, text){
  // OC URL: /companies/ng/1234567
  const urlM = (url||'').match(/\/companies\/ng\/(\d+)/i);
  if(urlM) return 'RC' + urlM[1].replace(/^0+/,'');
  // Text pattern
  const textM = (text||'').match(/\bRC[\s-:]?(\d{4,8})\b/i)
    || (text||'').match(/\bregistration\s+(?:no|number)[:\s]+(\d{4,8})\b/i);
  if(textM) return 'RC' + textM[1];
  return '';
}

// ── COMPANY suggest ───────────────────────────────────────────────
async function companySuggest(q, isRC){
  const rcNum = isRC ? q.replace(/^RC\s*/i,'') : '';

  // Build targeted queries that actually return company names
  let queries;
  if(isRC){
    queries = [
      `RC${rcNum} site:opencorporates.com/companies/ng`,
      `"RC${rcNum}" Nigeria company CAC registered`,
    ];
  } else {
    queries = [
      // Best source: OC indexed pages — titles have company name + RC
      `${q} site:opencorporates.com/companies/ng`,
      // CAC-related pages
      `"${q}" site:search.cac.gov.ng OR "${q}" "RC number" CAC Nigeria`,
      // Business registries
      `"${q}" Nigeria company (site:companiesng.com OR site:rc-number.com OR site:businesslist.com.ng)`,
    ];
  }

  // Run all queries in parallel
  const allResults = (await Promise.all(queries.map(q => serp(q, 8)))).flat();

  // Extract KG if any
  const kg = allResults._kg || null;

  const seen = new Map(); // slug → best item
  const results = [];

  // KG first — most authoritative
  if(kg && kg.title && kg.title.length > 2){
    const name = cleanTitle(kg.title);
    const rc = extractRC('', kg.description||'');
    if(name.length > 2){
      const slug = name.toLowerCase();
      results.push({
        label: name,
        sublabel: (kg.description||'').substring(0,90),
        value: name, rc, type:'company', source:'CAC', score:100
      });
      seen.set(slug, true);
    }
  }

  allResults.forEach(r => {
    if(!r || typeof r !== 'object' || !r.title) return;
    const rawTitle = r.title || '';
    const link = r.link || '';
    const snippet = r.snippet || '';

    const name = cleanTitle(rawTitle);
    if(!name || name.length < 2 || name.length > 90) return;

    // Filter out search/navigation pages
    if(/^(search|results|companies|page|index|home|login)/i.test(name)) return;
    if(/opencorporates|businesslist|companiesng|naijafirms|vconnect|google/i.test(name)) return;

    const slug = name.toLowerCase();
    if(seen.has(slug)) return;

    // Only accept if query tokens appear in name or snippet
    const qTokens = q.toLowerCase().split(/\s+/).filter(t=>t.length>1);
    const matchInName = qTokens.some(t => slug.includes(t));
    const matchInSnippet = qTokens.some(t => snippet.toLowerCase().includes(t));
    if(!matchInName && !matchInSnippet) return;

    seen.set(slug, true);

    const rc = extractRC(link, rawTitle + ' ' + snippet);
    const statusM = (rawTitle+' '+snippet).match(/\b(ACTIVE|INACTIVE|STRUCK OFF|DISSOLVED)\b/i);
    const status = statusM ? statusM[1] : '';

    let score = 40;
    let source = 'Web';
    if(link.includes('opencorporates.com/companies/ng')){ score = 92; source = 'CAC'; }
    else if(link.includes('search.cac.gov.ng')){ score = 90; source = 'CAC'; }
    else if(link.includes('companiesng.com') || link.includes('rc-number.com')){ score = 72; source = 'CAC'; }
    else if(link.includes('businesslist.com.ng')){ score = 60; source = 'Web'; }
    else if(rc){ score = 65; source = 'CAC'; } // has RC = likely registry data

    let sublabel = '';
    if(rc) sublabel += rc + ' · ';
    if(status) sublabel += status + ' · ';
    sublabel += snippet.substring(0, 70);

    results.push({ label:name, sublabel, value:name, rc, status, type:'company', source, score });
  });

  return results
    .sort((a,b) => b.score - a.score)
    .slice(0, 8);
}

// ── INDIVIDUAL suggest ────────────────────────────────────────────
async function individualSuggest(q){
  const tokens = q.trim();
  const toksArr = tokens.toLowerCase().split(/\s+/).filter(t=>t.length>1);

  const [efccRes, liRes, newsRes] = await Promise.all([
    // EFCC wanted list — each page title = person name
    serp(`${tokens} site:efcc.gov.ng/efcc/news-and-information/wanted-persons-1`, 8),
    // LinkedIn profiles
    serp(`"${tokens}" site:linkedin.com/in Nigeria`, 6),
    // Nigerian news + ICPC
    serp(`${tokens} Nigeria EFCC OR ICPC (arraigned OR convicted OR arrested OR charged)`, 6),
  ]);

  const results = [];
  const seen = new Set();

  function addResult(r){ 
    const slug = (r.value||'').toLowerCase().trim();
    if(!slug || slug.length < 2 || seen.has(slug)) return;
    seen.add(slug);
    results.push(r);
  }

  // EFCC wanted — title IS the person name
  efccRes.forEach(r => {
    let name = cleanTitle(r.title||'')
      .replace(/^WANTED[:\s-]*/i,'')
      .replace(/\bEFCC\b/gi,'')
      .replace(/\s+/g,' ').trim();
    // Title-case
    name = name.replace(/\b([A-Za-z]+)\b/g, w => 
      w.toUpperCase() === w ? w.charAt(0) + w.slice(1).toLowerCase() : w
    );
    if(name.length < 3 || name.length > 60) return;
    if(!toksArr.some(t => name.toLowerCase().includes(t))) return;
    addResult({
      label: name,
      sublabel: `⚠ EFCC WANTED · ${(r.snippet||'').substring(0,80)}`,
      value: name, type:'individual', source:'EFCC',
      isEnforcement:true, severity:'HIGH', url:r.link, score:95
    });
  });

  // LinkedIn profiles
  liRes.forEach(r => {
    const title = r.title || '';
    let name = '', role = '', company = '';
    const liM = title.match(/^(.+?)\s*[-–|]\s*(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[-|].*)?$/i);
    const liS = title.match(/^(.+?)\s*[-–|]\s*(.+?)(?:\s*[-|].*)?$/);
    if(liM){ name=liM[1].trim(); role=liM[2].trim(); company=liM[3].trim(); }
    else if(liS){ name=liS[1].trim(); role=liS[2].trim(); }
    else { name = cleanTitle(title); }
    if(!name || name.length < 3 || name.length > 55) return;
    if(!toksArr.some(t => name.toLowerCase().includes(t))) return;
    const sub = role && company ? `${role} at ${company}` : role || (r.snippet||'').substring(0,80);
    addResult({ label:name, sublabel:sub, value:name, type:'individual',
      source:'LinkedIn', role, company, score:82 });
  });

  // News enforcement — extract names from headlines
  const namePatterns = [
    /^([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})\s*(?:arraigned|convicted|arrested|charged|sentenced|jailed)/i,
    /EFCC\s+(?:re-)?(?:arrests?|arraigns?|convicts?|sentences?)\s+([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})/i,
    /ICPC\s+(?:re-)?(?:arrests?|arraigns?|convicts?|sentences?)\s+([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})/i,
    /([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})\s*[-–:]\s*(?:EFCC|ICPC|fraud|corruption)/i,
  ];
  newsRes.forEach(r => {
    const text = (r.title||'') + ' ' + (r.snippet||'');
    for(const pat of namePatterns){
      const m = text.match(pat);
      if(!m || !m[1]) continue;
      const name = m[1].trim();
      if(name.length < 4 || name.length > 55) continue;
      if(!toksArr.some(t => name.toLowerCase().includes(t))) continue;
      const link = r.link||'';
      const isHigh = /convict|sentenc|jail|imprison|guilty/i.test(text);
      const agency = link.includes('efcc')||text.toLowerCase().includes('efcc') ? 'EFCC'
        : link.includes('icpc')||text.toLowerCase().includes('icpc') ? 'ICPC' : 'ENFORCEMENT';
      addResult({ label:name, sublabel:`⚠ ${agency} · ${(r.snippet||'').substring(0,80)}`,
        value:name, type:'individual', source:agency,
        isEnforcement:true, severity:isHigh?'HIGH':'MEDIUM', url:link, score:isHigh?78:62 });
      break;
    }
  });

  // Sort: EFCC wanted first, then LinkedIn, then news enforcement
  return results.sort((a,b) => {
    const rankA = a.source==='EFCC'&&a.severity==='HIGH' ? 0 : a.source==='LinkedIn' ? 1 : a.isEnforcement ? 2 : 3;
    const rankB = b.source==='EFCC'&&b.severity==='HIGH' ? 0 : b.source==='LinkedIn' ? 1 : b.isEnforcement ? 2 : 3;
    if(rankA !== rankB) return rankA - rankB;
    return (b.score||0) - (a.score||0);
  }).slice(0, 8);
}

// ══════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res){
  refreshKeys();
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const q = (req.query?.q || '').trim();
  const type = req.query?.type || 'company';
  if(q.length < 2) return res.status(200).json({suggestions:[]});

  const isRC = /^(RC\s*)?(\d{4,8})$/i.test(q);

  try{
    const suggestions = (type === 'individual')
      ? await individualSuggest(q)
      : await companySuggest(q, isRC);

    return res.status(200).json({ suggestions: suggestions.slice(0,8), query:q, is_rc:isRC });
  } catch(e){
    return res.status(500).json({ suggestions:[], error:e.message });
  }
};
