// Check Am — /api/suggest  v5
// Autocomplete: CAC/OC via SerpApi + EFCC wanted + LinkedIn
// NOTE: OC direct API is DNS-blocked on Vercel → SerpApi only

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

// Returns {organic:[], kg:null} always — safe to destructure
async function serp(q, num=8){
  if(!SERPAPI_KEY) return {organic:[], kg:null};
  try{
    const url = `https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&engine=google&gl=ng&hl=en&num=${num}&safe=off&q=${encodeURIComponent(q)}`;
    const {s,b} = await get(url, 12000);
    if(s !== 200 || !b) return {organic:[], kg:null};
    const j = JSON.parse(b);
    return {organic: j.organic_results||[], kg: j.knowledge_graph||null};
  } catch(_){ return {organic:[], kg:null}; }
}

// Clean page title to company/person name
function cleanTitle(t){
  return (t||'')
    .replace(/\s*-\s*\d{4,8}\s*\(?Nigeria\)?.*$/i,'')  // "Name - 123456 (Nigeria) - OC"
    .replace(/\s*-\s*OpenCorporates.*/i,'')
    .replace(/\s*-\s*CAC.*/i,'')
    .replace(/\s*-\s*Economic and Financial.*/i,'')
    .replace(/\s*-\s*EFCC.*/i,'')
    .replace(/\s*-\s*ICPC.*/i,'')
    .replace(/\s*\|.*/,'')
    .replace(/\s+/g,' ').trim();
}

// Extract RC from OC URL or text
function extractRC(url, text){
  const u = (url||'').match(/\/companies\/ng\/(\d+)/i);
  if(u) return 'RC' + u[1].replace(/^0+/,'');
  const t = (text||'').match(/\bRC[\s-:]?(\d{4,8})\b/i);
  if(t) return 'RC' + t[1];
  return '';
}

// ── COMPANY suggest ───────────────────────────────────────────────
async function companySuggest(q, isRC){
  const rcNum = q.replace(/^RC\s*/i,'');

  const queries = isRC ? [
    `RC${rcNum} site:opencorporates.com/companies/ng`,
    `"RC${rcNum}" Nigeria CAC company registered`,
  ] : [
    // OC indexed pages: titles = "Company Name - RC (Nigeria) - OpenCorporates"
    `${q} site:opencorporates.com/companies/ng`,
    // CAC direct
    `"${q}" site:search.cac.gov.ng OR "${q}" "RC number" CAC Nigeria`,
    // Business registries
    `"${q}" Nigeria (site:companiesng.com OR site:businesslist.com.ng OR site:rc-number.com)`,
  ];

  // Run all in parallel — serp() always returns {organic, kg}
  const serpResults = await Promise.all(queries.map(q => serp(q, 8)));

  // Collect KG from first result that has one
  const kg = serpResults.find(r => r.kg)?.kg || null;
  const allOrganic = serpResults.flatMap(r => r.organic);

  const results = [];
  const seen = new Set();

  // KG first — most authoritative
  if(kg && kg.title){
    const name = cleanTitle(kg.title);
    const rc = extractRC('', kg.description||'');
    if(name.length > 1 && !seen.has(name.toLowerCase())){
      seen.add(name.toLowerCase());
      results.push({label:name, sublabel:(kg.description||'').substring(0,85),
        value:name, rc, type:'company', source:'CAC', score:100});
    }
  }

  const qLow = q.toLowerCase();
  allOrganic.forEach(r => {
    const link  = r.link || '';
    const title = r.title || '';
    const snip  = r.snippet || '';
    const name  = cleanTitle(title);

    if(!name || name.length < 2 || name.length > 90) return;
    if(/^(search|results|home|page|index|login|sign)/i.test(name)) return;
    if(/opencorporates\b|businesslist\b|naijafirms\b|vconnect\b|companiesng\b/i.test(name)) return;

    const slug = name.toLowerCase();
    if(seen.has(slug)) return;

    // Must relate to query
    if(!slug.includes(qLow) && !(snip.toLowerCase().includes(qLow))) return;
    seen.add(slug);

    const rc     = extractRC(link, title+' '+snip);
    const statM  = (title+' '+snip).match(/\b(ACTIVE|INACTIVE|STRUCK OFF|DISSOLVED)\b/i);
    const status = statM ? statM[1] : '';

    let score = 40, source = 'Web';
    if(link.includes('opencorporates.com/companies/ng')){ score=92; source='CAC'; }
    else if(link.includes('search.cac.gov.ng'))          { score=90; source='CAC'; }
    else if(link.includes('companiesng.com') || link.includes('rc-number.com')){ score=72; source='CAC'; }
    else if(link.includes('businesslist.com.ng'))         { score=58; source='Web'; }
    else if(rc)                                           { score=65; source='CAC'; }

    let sub = '';
    if(rc)     sub += rc + ' · ';
    if(status) sub += status + ' · ';
    sub += snip.substring(0, 65);

    results.push({label:name, sublabel:sub, value:name, rc, status, type:'company', source, score});
  });

  return results.sort((a,b)=>b.score-a.score).slice(0,8);
}

// ── INDIVIDUAL suggest ────────────────────────────────────────────
async function individualSuggest(q){
  const toks = q.toLowerCase().split(/\s+/).filter(t=>t.length>1);

  const [efccR, liR, newsR] = await Promise.all([
    serp(`${q} site:efcc.gov.ng/efcc/news-and-information/wanted-persons-1`, 8),
    serp(`"${q}" site:linkedin.com/in Nigeria`, 6),
    serp(`${q} Nigeria EFCC OR ICPC (arraigned OR convicted OR arrested OR charged)`, 6),
  ]);

  const results = [];
  const seen = new Set();

  function add(r){
    const slug = (r.value||'').toLowerCase().trim();
    if(!slug || slug.length < 2 || seen.has(slug)) return;
    seen.add(slug); results.push(r);
  }

  // EFCC wanted — title IS the person name
  efccR.organic.forEach(r => {
    let name = cleanTitle(r.title||'')
      .replace(/^WANTED[:\s-]*/i,'').replace(/\bEFCC\b/gi,'').trim();
    // Title-case ALL-CAPS names
    if(name === name.toUpperCase())
      name = name.replace(/\b\w+/g, w=>w[0]+w.slice(1).toLowerCase());
    if(name.length < 3 || name.length > 60) return;
    if(!toks.some(t=>name.toLowerCase().includes(t))) return;
    add({label:name, sublabel:`⚠ EFCC WANTED · ${(r.snippet||'').substring(0,80)}`,
      value:name, type:'individual', source:'EFCC', isEnforcement:true, severity:'HIGH', score:95});
  });

  // LinkedIn
  liR.organic.forEach(r => {
    const t = r.title||'';
    let name='', role='', company='';
    const m3 = t.match(/^(.+?)\s*[-–|]\s*(.+?)\s+at\s+(.+?)(?:\s*[-|].*)?$/i);
    const m2 = t.match(/^(.+?)\s*[-–|]\s*(.+?)(?:\s*[-|].*)?$/);
    if(m3){ name=m3[1].trim(); role=m3[2].trim(); company=m3[3].trim(); }
    else if(m2){ name=m2[1].trim(); role=m2[2].trim(); }
    else name = cleanTitle(t);
    if(!name||name.length<3||name.length>55) return;
    if(!toks.some(t=>name.toLowerCase().includes(t))) return;
    const sub = role&&company ? `${role} at ${company}` : role||(r.snippet||'').substring(0,80);
    add({label:name, sublabel:sub, value:name, type:'individual', source:'LinkedIn', role, company, score:82});
  });

  // Enforcement news — extract names from headlines
  const pats = [
    /^([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})\s*(?:arraigned|convicted|arrested|charged|sentenced)/i,
    /EFCC\s+(?:arrests?|arraigns?|convicts?|sentences?)\s+([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})/i,
    /ICPC\s+(?:arrests?|arraigns?|convicts?|sentences?)\s+([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})/i,
    /([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})\s*[-–:]\s*(?:EFCC|ICPC|fraud|corruption)/i,
  ];
  newsR.organic.forEach(r => {
    const text = (r.title||'')+' '+(r.snippet||'');
    for(const pat of pats){
      const m = text.match(pat);
      if(!m||!m[1]) continue;
      const name = m[1].trim();
      if(name.length<4||name.length>55) continue;
      if(!toks.some(t=>name.toLowerCase().includes(t))) continue;
      const isHigh = /convict|sentenc|jail/i.test(text);
      const agency = (r.link||'').includes('efcc')||text.toLowerCase().includes('efcc') ? 'EFCC':'ICPC';
      add({label:name, sublabel:`⚠ ${agency} · ${(r.snippet||'').substring(0,80)}`,
        value:name, type:'individual', source:agency, isEnforcement:true,
        severity:isHigh?'HIGH':'MEDIUM', score:isHigh?78:62});
      break;
    }
  });

  // EFCC first, then by score
  return results.sort((a,b)=>{
    const ra = a.source==='EFCC'&&a.severity==='HIGH' ? 0 : a.source==='LinkedIn'?1:a.isEnforcement?2:3;
    const rb = b.source==='EFCC'&&b.severity==='HIGH' ? 0 : b.source==='LinkedIn'?1:b.isEnforcement?2:3;
    return ra!==rb ? ra-rb : (b.score||0)-(a.score||0);
  }).slice(0,8);
}

// ── HANDLER ───────────────────────────────────────────────────────
module.exports = async function handler(req, res){
  refreshKeys();
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const q    = (req.query?.q||'').trim();
  const type = req.query?.type || 'company';
  if(q.length < 2) return res.status(200).json({suggestions:[]});

  const isRC = /^(RC\s*)?(\d{4,8})$/i.test(q);

  try{
    const suggestions = type==='individual'
      ? await individualSuggest(q)
      : await companySuggest(q, isRC);

    return res.status(200).json({suggestions: suggestions.slice(0,8), query:q, is_rc:isRC});
  } catch(e){
    return res.status(500).json({suggestions:[], error:e.message});
  }
};
