// ══════════════════════════════════════════════════════════════════
// Check Am — /api/suggest  v3
// Smart autocomplete: SerpApi-driven, sources-first, broad matching
//
// KEY INSIGHT: EFCC wanted list = individual pages per person.
// URL pattern: efcc.gov.ng/efcc/news-and-information/wanted-persons-1/ID-FULL-NAME
// Title pattern: "FIRSTNAME MIDDLENAME LASTNAME" or "WANTED - NAME"
// So: site:efcc.gov.ng/efcc/news-and-information/wanted-persons-1 + tokens
// returns persons directly by name in title.
// Same for ICPC: site:icpc.gov.ng
// ══════════════════════════════════════════════════════════════════

const https = require('https');

function cleanKey(r){ return String(r||'').replace(/[^\x21-\x7E]/g,'').trim(); }
let SERPAPI_KEY = '';
function refreshKeys(){ SERPAPI_KEY = cleanKey(process.env.SERPAPI_KEY); }

function get(url, ms=9000){
  return new Promise(resolve=>{
    try{
      const req = https.get(url,{
        headers:{'User-Agent':'Mozilla/5.0 Chrome/120','Accept':'application/json,text/html,*/*'}
      }, res=>{
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location)
          return get(res.headers.location,ms).then(resolve);
        let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({s:res.statusCode,b}));
      });
      req.on('error',()=>resolve({s:0,b:''}));
      req.setTimeout(ms,()=>{req.destroy();resolve({s:0,b:''});});
    }catch(_){resolve({s:0,b:''});}
  });
}

// Core SerpApi call
async function serp(q, num=8){
  if(!SERPAPI_KEY) return {organic:[], kg:null};
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&engine=google&gl=ng&hl=en&num=${num}&safe=off&q=${encodeURIComponent(q)}`;
    const {s,b}=await get(url,12000);
    if(s!==200||!b) return {organic:[],kg:null};
    const j=JSON.parse(b);
    return {organic:j.organic_results||[], kg:j.knowledge_graph||null};
  }catch(_){return {organic:[],kg:null};}
}

// ── OpenCorporates free API ───────────────────────────────────────
async function ocSearch(q, isRC){
  try{
    const url = isRC
      ? `https://api.opencorporates.com/v0.4/companies/ng/${q.replace(/^RC\s*/i,'')}?sparse=true`
      : `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(q)}&jurisdiction_code=ng&per_page=8&sparse=true`;
    const {s,b}=await get(url);
    if(s!==200||!b) return [];
    const j=JSON.parse(b);
    const list = isRC
      ? (j.results?.company?[j.results.company]:[])
      : (j.results?.companies||[]).map(c=>c.company);
    return list.filter(Boolean).map(co=>{
      const rc=String(co.company_number||'').replace(/^0+/,'');
      return {
        label:co.name||'',
        sublabel:`RC${rc}${co.current_status?' · '+co.current_status:''} · ${(co.incorporation_date||'').substring(0,4)||'?'}${co.registered_address?.in_full?' · '+co.registered_address.in_full.substring(0,40):''}`,
        value:co.name||'', rc:rc?'RC'+rc:'', status:co.current_status||'Active',
        type:'company', source:'CAC', score:90,
      };
    });
  }catch(_){return [];}
}

// ── EFCC Wanted persons — direct page title extraction ────────────
// Each wanted person has their own page: title = their full name
// Query: site:efcc.gov.ng/efcc/news-and-information/wanted-persons-1 TOKENS
async function efccWantedSearch(tokens){
  // Use the specific wanted-persons-1 subsection for precision
  const q=`${tokens} site:efcc.gov.ng/efcc/news-and-information/wanted-persons-1`;
  const {organic}=await serp(q,8);
  const results=[];
  const seen=new Set();
  organic.forEach(r=>{
    // Title is the person's name (e.g. "KEHINDE EMMANUEL ADEYANJU - Economic...")
    let name=(r.title||'').split(' - ')[0].split(' | ')[0]
      .replace(/^WANTED[:\s-]*/i,'').replace(/\bEFCC\b/gi,'').trim();
    // Normalize: "JOHN DOE" → "John Doe"
    name=name.replace(/\b([A-Z]+)\b/g,w=>w.charAt(0)+w.slice(1).toLowerCase());
    if(name.length<3||name.length>60) return;
    const slug=name.toLowerCase();
    if(seen.has(slug)) return;
    // Must match at least one token
    const toks=tokens.toLowerCase().split(/\s+/).filter(t=>t.length>1);
    if(!toks.some(t=>slug.includes(t))) return;
    seen.add(slug);
    const snippet=(r.snippet||'').substring(0,90);
    results.push({
      label:name, sublabel:`⚠ EFCC WANTED · ${snippet}`,
      value:name, type:'individual', source:'EFCC',
      isEnforcement:true, severity:'HIGH',
      url:r.link, score:95,
    });
  });
  return results;
}

// ── ICPC wanted/prosecuted persons ───────────────────────────────
async function icpcSearch(tokens){
  const q=`${tokens} site:icpc.gov.ng (arraigned OR convicted OR charged OR wanted OR prosecuted)`;
  const {organic}=await serp(q,6);
  const results=[];
  const seen=new Set();
  organic.forEach(r=>{
    let name=(r.title||'').split(' - ')[0].split(' | ')[0]
      .replace(/ICPC/gi,'').replace(/^WANTED[:\s-]*/i,'').trim();
    name=name.replace(/\b([A-Z]{2,})\b/g,w=>w.charAt(0)+w.slice(1).toLowerCase());
    if(name.length<3||name.length>60) return;
    const slug=name.toLowerCase();
    if(seen.has(slug)) return;
    const toks=tokens.toLowerCase().split(/\s+/).filter(t=>t.length>1);
    if(!toks.some(t=>slug.includes(t))) return;
    seen.add(slug);
    results.push({
      label:name, sublabel:`⚠ ICPC · ${(r.snippet||'').substring(0,80)}`,
      value:name, type:'individual', source:'ICPC',
      isEnforcement:true, severity:'HIGH',
      url:r.link, score:90,
    });
  });
  return results;
}

// ── Broad enforcement coverage (news) ────────────────────────────
async function enforcementNewsSearch(tokens){
  const q=`${tokens} Nigeria EFCC OR ICPC (arraigned OR convicted OR arrested OR charged OR sentenced OR "on trial")`;
  const {organic}=await serp(q,8);
  const results=[];
  const seen=new Set();
  const toks=tokens.toLowerCase().split(/\s+/).filter(t=>t.length>1);

  // Name extraction patterns from news headlines
  const patterns=[
    /^([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})\s*(?:arraigned|convicted|arrested|charged|sentenced|jailed)/i,
    /EFCC\s+(?:re-)?(?:arrests?|arraigns?|convicts?|sentences?|charges?)\s+([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})/i,
    /ICPC\s+(?:re-)?(?:arrests?|arraigns?|convicts?|sentences?|charges?)\s+([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})/i,
    /([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})\s*(?:gets?|gets?)\s+\d+.?years?/i,
    /([A-Z][a-z]+(?:\s+[A-Za-z'-]+){1,3})[-–:,]\s*(?:EFCC|ICPC|fraud|corruption)/i,
  ];

  organic.forEach(r=>{
    const title=(r.title||'').trim();
    const snippet=(r.snippet||'').trim();
    const link=r.link||'';
    const text=title+' '+snippet;

    for(const pat of patterns){
      const m=text.match(pat);
      if(!m||!m[1]) continue;
      const name=m[1].trim();
      if(name.length<4||name.length>55) continue;
      const slug=name.toLowerCase();
      if(seen.has(slug)) continue;
      if(!toks.some(t=>slug.includes(t))) continue;
      seen.add(slug);
      const isHigh=/convict|sentenc|jail|imprison|guilty/.test(text.toLowerCase());
      const agency=link.includes('efcc')||text.toLowerCase().includes('efcc')?'EFCC'
        :link.includes('icpc')||text.toLowerCase().includes('icpc')?'ICPC':'ENFORCEMENT';
      results.push({
        label:name,
        sublabel:`⚠ ${agency} · ${snippet.substring(0,80)}`,
        value:name, type:'individual', source:agency,
        isEnforcement:true, severity:isHigh?'HIGH':'MEDIUM',
        url:link, score:isHigh?80:65,
      });
      break;
    }
  });
  return results.slice(0,4);
}

// ── Company suggestions (OC + SerpApi) ───────────────────────────
async function companySuggest(q, isRC){
  const serpQ=isRC
    ? `RC${q.replace(/^RC\s*/i,'')} Nigeria company CAC registered`
    : `${q} Nigeria company registered CAC`;
  const [ocRes,{organic,kg}]=await Promise.all([
    ocSearch(q,isRC),
    serp(serpQ,8),
  ]);
  const results=[...ocRes];
  const seen=new Set(ocRes.map(r=>r.value.toLowerCase()));
  // Knowledge graph
  if(kg?.title&&kg.title.length>2){
    const slug=kg.title.toLowerCase();
    if(!seen.has(slug)){
      seen.add(slug);
      const rcM=(kg.description||'').match(/RC[\s-]?(\d{4,8})/i);
      results.push({label:kg.title,sublabel:kg.description?.substring(0,80)||'',
        value:kg.title,rc:rcM?'RC'+rcM[1]:'',type:'company',source:'CAC',score:100});
    }
  }
  // Organic results
  organic.forEach(r=>{
    const title=(r.title||'').replace(/ - CAC.*$/i,'').replace(/ \| .*/,'').replace(/\s*-\s*OpenCorporates.*/i,'').trim();
    if(title.length<3) return;
    const slug=title.toLowerCase();
    if(seen.has(slug)) return;
    seen.add(slug);
    const text=title+' '+(r.snippet||'');
    const rcM=text.match(/RC[\s-:]?(\d{4,8})/i);
    const statusM=text.match(/\b(ACTIVE|INACTIVE|STRUCK OFF|DISSOLVED)\b/i);
    let score=50;
    const link=r.link||'';
    if(link.includes('opencorporates.com/companies/ng')) score=88;
    else if(link.includes('companiesng.com')) score=70;
    results.push({
      label:title, sublabel:`${rcM?'RC'+rcM[1]+' · ':''}${statusM?statusM[1]+' · ':''}${(r.snippet||'').substring(0,65)}`,
      value:title, rc:rcM?'RC'+rcM[1]:'', status:statusM?statusM[1]:'Active',
      type:'company', source:score>=88?'CAC':'Web', score,
    });
  });
  return results.sort((a,b)=>b.score-a.score).slice(0,8);
}

// ── Individual suggestions ────────────────────────────────────────
async function individualSuggest(q){
  const tokens=q.trim().split(/\s+/).filter(t=>t.length>1).join(' ')||q.trim();
  // Run ALL in parallel
  const [efccRes,icpcRes,newsRes,liRes]=await Promise.all([
    efccWantedSearch(tokens),
    icpcSearch(tokens),
    enforcementNewsSearch(tokens),
    serp(`${tokens} Nigeria (site:linkedin.com/in OR site:wikipedia.org)`,6),
  ]);

  const results=[];
  const seen=new Set();

  function add(r){
    const slug=(r.value||'').toLowerCase();
    if(!slug||seen.has(slug)) return;
    seen.add(slug);
    results.push(r);
  }

  // LinkedIn/Wikipedia
  (liRes.organic||[]).forEach(r=>{
    const title=(r.title||'').trim();
    const snippet=(r.snippet||'').trim();
    const link=r.link||'';
    let name=title, role='', company='';
    const liM=title.match(/^(.+?)\s*[-–|]\s*(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[-|].*)?$/i);
    const liS=title.match(/^(.+?)\s*[-–|]\s*(.+?)(?:\s*[-|].*)?$/);
    const wikiM=title.match(/^(.+?)\s*[-|–]\s*Wikipedia/i);
    if(wikiM){name=wikiM[1].trim();}
    else if(liM){name=liM[1].trim();role=liM[2].trim();company=liM[3].trim();}
    else if(liS&&link.includes('linkedin')){name=liS[1].trim();role=liS[2].trim();}
    if(name.length<3||name.length>55) return;
    const toks=tokens.toLowerCase().split(/\s+/).filter(t=>t.length>1);
    if(!toks.some(t=>name.toLowerCase().includes(t))) return;
    let sub=snippet.substring(0,85);
    if(role&&company) sub=`${role} at ${company}`;
    else if(role) sub=role;
    add({label:name,sublabel:sub,value:name,type:'individual',
      source:link.includes('linkedin')?'LinkedIn':'Wikipedia',
      role,company,score:link.includes('wikipedia')?88:82});
  });

  // Enforcement — always add
  [...efccRes,...icpcRes,...newsRes].forEach(add);

  // Sort: EFCC/ICPC wanted first (highest severity), then by score
  results.sort((a,b)=>{
    // EFCC WANTED > other enforcement > general
    const aEFCC = a.source==='EFCC'&&a.severity==='HIGH'?0: a.isEnforcement?1:2;
    const bEFCC = b.source==='EFCC'&&b.severity==='HIGH'?0: b.isEnforcement?1:2;
    if(aEFCC!==bEFCC) return aEFCC-bEFCC;
    return (b.score||50)-(a.score||50);
  });
  return results.slice(0,8);
}

// ══════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════
module.exports = async function handler(req,res){
  refreshKeys();
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const q=(req.query?.q||'').trim();
  const type=req.query?.type||'company';
  if(q.length<2) return res.status(200).json({suggestions:[]});

  const isRC=/^(RC\s*)?(\d{4,8})$/i.test(q);

  try{
    const suggestions = type==='individual'
      ? await individualSuggest(q)
      : await companySuggest(q, isRC);

    return res.status(200).json({
      suggestions: suggestions.slice(0,8),
      query:q, is_rc:isRC,
    });
  }catch(e){
    return res.status(500).json({suggestions:[],error:e.message});
  }
};
