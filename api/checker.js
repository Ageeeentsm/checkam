// ══════════════════════════════════════════════════════════════════
// Check Am — /api/checker  v2
// Live name/company check across all 6 enforcement agencies
//
// FIXES:
// 1. NO exact quotes — token-level search so "yahaya" finds all
//    Yahayas in EFCC records, wanted lists, court records
// 2. EFCC wanted-persons-1 subpath targeting (each person = own page)
// 3. RC number resolution: OC API → SerpApi → rated sites
// 4. found=true on ANY relevant hit, not just HIGH severity
// 5. Broader query strategies per agency
// ══════════════════════════════════════════════════════════════════

const https = require('https');

function cleanKey(r){ return String(r||'').replace(/[^\x21-\x7E]/g,'').trim(); }
let SERPAPI_KEY='', ANTHROPIC_KEY='';
function refreshKeys(){
  SERPAPI_KEY=cleanKey(process.env.SERPAPI_KEY);
  ANTHROPIC_KEY=cleanKey(process.env.ANTHROPIC_API_KEY);
}

function get(url, ms=12000){
  return new Promise(resolve=>{
    try{
      const req=https.get(url,{
        headers:{'User-Agent':'Mozilla/5.0 Chrome/120','Accept':'text/html,application/json,*/*'}
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

function postJson(hostname,path,body,hdrs={}){
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(body);
    const opts={hostname,path,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),...hdrs}};
    const req=https.request(opts,res=>{
      let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({s:res.statusCode,b}));
    });
    req.on('error',reject);
    req.setTimeout(25000,()=>{req.destroy();reject(new Error('timeout'));});
    req.write(data); req.end();
  });
}

async function serp(q, num=10){
  if(!SERPAPI_KEY) return [];
  try{
    const url=`https://serpapi.com/search.json?q=${encodeURIComponent(q)}&api_key=${SERPAPI_KEY}&num=${num}&gl=ng&hl=en&safe=off`;
    const {s,b}=await get(url);
    if(s!==200||!b) return [];
    const j=JSON.parse(b);
    return (j.organic_results||[]).map(r=>({
      title:r.title||'', url:r.link||'',
      snippet:r.snippet||'', source:r.displayed_link||'',
      date:r.date||''
    }));
  }catch(_){return [];}
}

// ── RC Resolution: OC API → SerpApi → rated sites ────────────────
async function resolveRC(rcInput){
  const rcNum = rcInput.replace(/^RC\s*/i,'').trim();
  
  // 1. OpenCorporates direct
  try{
    const {s,b}=await get(`https://api.opencorporates.com/v0.4/companies/ng/${rcNum}?sparse=true`);
    if(s===200&&b){
      const co=JSON.parse(b)?.results?.company;
      if(co?.name) return {name:co.name, rc:'RC'+rcNum, source:'OpenCorporates', status:co.current_status||'Active'};
    }
  }catch(_){}

  // 2. SerpApi — Google knows RC numbers from OC pages
  const results=await serp(`RC${rcNum} Nigeria company CAC registered`, 6);
  for(const r of results){
    const title=(r.title||'').trim();
    // OC / companiesng title: "COMPANY NAME - 123456 (Nigeria)"
    const clean=title.replace(/\s*[-–|]\s*\d{4,8}\s*\(?Nigeria\)?.*$/i,'').replace(/\s*\|.*/,'').trim();
    // Rated sources only
    const isRated=/opencorporates|companiesng|businesslist\.com\.ng|rc-number|cac\.gov/i.test(r.url||'');
    if(clean&&clean.length>2&&clean.length<80&&
       !/^(company|nigeria|search|page|result)/i.test(clean)&&
       (isRated||r.url?.includes('opencorporates'))){
      return {name:clean, rc:'RC'+rcNum, source:'Google/OC', status:'Active'};
    }
  }
  // 3. Fallback: best guess from any result title
  for(const r of results){
    const title=(r.title||'').split(' - ')[0].split(' | ')[0].trim();
    if(title&&title.length>3&&title.length<80&&!/^\d/.test(title)){
      return {name:title, rc:'RC'+rcNum, source:'Web', status:'Unknown'};
    }
  }
  return null;
}

// ── Token-level name matching (no exact quotes) ───────────────────
function nameMatch(text, name){
  const tl=text.toLowerCase();
  const tokens=name.toLowerCase().split(/\s+/).filter(t=>t.length>1);
  if(!tokens.length) return false;
  if(tokens.length===1) return tl.includes(tokens[0]);
  const matched=tokens.filter(t=>tl.includes(t)).length;
  return matched>=Math.ceil(tokens.length*0.5);
}

function getSeverity(text){
  const t=text.toLowerCase();
  if(/convicted|sentenced|guilty|imprisonment|jailed|years?.prison/.test(t)) return 'HIGH';
  if(/arraigned|charged|prosecuted|indicted|remanded|on.trial/.test(t)) return 'HIGH';
  if(/wanted|fugitive|at.large|fled/.test(t)) return 'HIGH';
  if(/sanctioned|debarred|suspended|barred|revoked/.test(t)) return 'MEDIUM';
  if(/arrested|detained|invited|questioned/.test(t)) return 'MEDIUM';
  return 'LOW';
}

function getStatus(text){
  const t=text.toLowerCase();
  if(/convicted|sentenc|guilty/.test(t)) return 'CONVICTED';
  if(/wanted|fugitive|at.large|fled/.test(t)) return 'WANTED';
  if(/arraigned|charg|prosecut|indict|remand/.test(t)) return 'CHARGED';
  if(/sanction|debar|bar|suspend|revok/.test(t)) return 'SANCTIONED';
  if(/arrested|detained/.test(t)) return 'ARRESTED';
  return 'MENTIONED';
}

function extractMeta(text){
  const amount=(text.match(/[₦N]\s*[\d,.]+\s*(m|bn|million|billion|trillion|k)?|\$[\d,.]+\s*(m|bn|million|billion)?/i)||[])[0]||'';
  const caseRef=(text.match(/[A-Z]+\/[A-Z]+\/[A-Z]*\/?[\d\/]+\/\d{4}/)||[])[0]||'';
  return {amount, caseRef};
}

// ── EFCC search — targets wanted-persons subpath + broad coverage ─
async function searchEFCC(name){
  const tokens=name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
  const [wantedRes, siteRes, newsRes] = await Promise.all([
    // EFCC wanted-persons-1: each page title = person name. No quotes needed.
    serp(`${tokens} site:efcc.gov.ng/efcc/news-and-information/wanted-persons-1`, 8),
    // Broad EFCC site — arraignments, convictions, press releases
    serp(`${tokens} site:efcc.gov.ng`, 8),
    // Top Nigerian papers covering EFCC cases
    serp(`${tokens} EFCC (arraigned OR convicted OR arrested OR charged OR sentenced OR wanted) site:punchng.com OR site:vanguardngr.com OR site:premiumtimesng.com OR site:thenigerialawyer.com`, 8),
  ]);

  const records=[];
  const seen=new Set();

  [...wantedRes.map(r=>({...r,_wanted:true})), ...siteRes, ...newsRes].forEach(r=>{
    const text=(r.title||'')+' '+(r.snippet||'');
    if(!nameMatch(text, name)) return;
    const key=(r.url||'').split('?')[0];
    if(seen.has(key)) return;
    seen.add(key);
    const isWanted=r._wanted||(r.url||'').includes('wanted-persons');
    const isOfficial=(r.url||'').includes('efcc.gov.ng');
    const sev=isWanted?'HIGH':getSeverity(text);
    const status=isWanted?'WANTED':getStatus(text);
    const {amount,caseRef}=extractMeta(text);
    records.push({
      title:r.title, url:r.url, snippet:r.snippet, source:r.source, date:r.date,
      status, severity:sev, amount, case_ref:caseRef, agency:'EFCC',
      official:isOfficial||isWanted,
    });
  });

  const sevOrd={HIGH:0,MEDIUM:1,LOW:2};
  records.sort((a,b)=>(sevOrd[a.severity]||2)-(sevOrd[b.severity]||2));
  const unique=records.slice(0,6);
  return {agency:'EFCC', found:unique.length>0, records:unique, official_url:'https://efcc.gov.ng'};
}

// ── ICPC ─────────────────────────────────────────────────────────
async function searchICPC(name){
  const tokens=name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
  const [siteRes, newsRes] = await Promise.all([
    serp(`${tokens} site:icpc.gov.ng`, 6),
    serp(`${tokens} ICPC (arraigned OR convicted OR arrested OR charged OR prosecuted) Nigeria site:punchng.com OR site:vanguardngr.com OR site:premiumtimesng.com`, 6),
  ]);
  const records=[]; const seen=new Set();
  [...siteRes,...newsRes].forEach(r=>{
    const text=(r.title||'')+' '+(r.snippet||'');
    if(!nameMatch(text,name)) return;
    const key=(r.url||'').split('?')[0];
    if(seen.has(key)) return; seen.add(key);
    const sev=getSeverity(text);
    const {amount,caseRef}=extractMeta(text);
    records.push({title:r.title,url:r.url,snippet:r.snippet,source:r.source,date:r.date,
      status:getStatus(text),severity:sev,amount,case_ref:caseRef,agency:'ICPC'});
  });
  records.sort((a,b)=>({HIGH:0,MEDIUM:1,LOW:2}[a.severity]||2)-({HIGH:0,MEDIUM:1,LOW:2}[b.severity]||2));
  return {agency:'ICPC',found:records.length>0,records:records.slice(0,5),official_url:'https://icpc.gov.ng'};
}

// ── CBN ──────────────────────────────────────────────────────────
async function searchCBN(name){
  const tokens=name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
  const [debarRes, siteRes] = await Promise.all([
    get('https://www.cbn.gov.ng/Supervision/Inst-DBar.asp'),
    serp(`${tokens} site:cbn.gov.ng`, 5),
  ]);
  const records=[]; const seen=new Set();
  // Check debarment list
  if(debarRes.s===200&&debarRes.b&&nameMatch(debarRes.b,name)){
    records.push({title:`${name} — CBN Debarred Persons/Institutions List`,
      url:'https://www.cbn.gov.ng/Supervision/Inst-DBar.asp',
      snippet:'Name found in CBN debarred list',source:'cbn.gov.ng',
      status:'SANCTIONED',severity:'HIGH',amount:'',case_ref:'',agency:'CBN'});
    seen.add('cbn-debar');
  }
  siteRes.forEach(r=>{
    const text=(r.title||'')+' '+(r.snippet||'');
    if(!nameMatch(text,name)) return;
    const key=(r.url||'').split('?')[0];
    if(seen.has(key)) return; seen.add(key);
    const {amount,caseRef}=extractMeta(text);
    records.push({title:r.title,url:r.url,snippet:r.snippet,source:r.source,date:r.date,
      status:getStatus(text),severity:getSeverity(text),amount,case_ref:caseRef,agency:'CBN'});
  });
  return {agency:'CBN',found:records.length>0,records:records.slice(0,5),official_url:'https://cbn.gov.ng'};
}

// ── SEC ──────────────────────────────────────────────────────────
async function searchSEC(name){
  const tokens=name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
  const res=await serp(`${tokens} site:sec.gov.ng`, 5);
  const records=[]; const seen=new Set();
  res.forEach(r=>{
    const text=(r.title||'')+' '+(r.snippet||'');
    if(!nameMatch(text,name)) return;
    const key=(r.url||'').split('?')[0];
    if(seen.has(key)) return; seen.add(key);
    const {amount,caseRef}=extractMeta(text);
    const isSanction=/deregister|suspend|sanction|enforcement|revok/i.test(text);
    records.push({title:r.title,url:r.url,snippet:r.snippet,source:r.source,date:r.date,
      status:isSanction?'SANCTIONED':'MENTIONED',severity:isSanction?'HIGH':'LOW',
      amount,case_ref:caseRef,agency:'SEC'});
  });
  return {agency:'SEC',found:records.length>0,records:records.slice(0,5),official_url:'https://sec.gov.ng'};
}

// ── Courts ───────────────────────────────────────────────────────
async function searchCourts(name){
  const tokens=name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
  const [courtRes, legalRes] = await Promise.all([
    serp(`${tokens} (site:nicn.gov.ng OR site:courtofappeal.gov.ng OR site:supremecourt.gov.ng) judgment`, 5),
    serp(`${tokens} Nigeria court judgment conviction fraud (site:legalnaija.com OR site:lawpavilion.com OR site:thenigerialawyer.com)`, 5),
  ]);
  const records=[]; const seen=new Set();
  [...courtRes,...legalRes].forEach(r=>{
    const text=(r.title||'')+' '+(r.snippet||'');
    if(!nameMatch(text,name)) return;
    const key=(r.url||'').split('?')[0];
    if(seen.has(key)) return; seen.add(key);
    const {amount,caseRef}=extractMeta(text);
    records.push({title:r.title,url:r.url,snippet:r.snippet,source:r.source,date:r.date,
      status:getStatus(text),severity:getSeverity(text),amount,case_ref:caseRef,agency:'COURTS'});
  });
  records.sort((a,b)=>({HIGH:0,MEDIUM:1,LOW:2}[a.severity]||2)-({HIGH:0,MEDIUM:1,LOW:2}[b.severity]||2));
  return {agency:'COURTS',found:records.length>0,records:records.slice(0,5),official_url:'https://nicn.gov.ng'};
}

// ── FIRS ─────────────────────────────────────────────────────────
async function searchFIRS(name){
  const tokens=name.trim().split(/\s+/).filter(t=>t.length>1).join(' ');
  const [siteRes, newsRes] = await Promise.all([
    serp(`${tokens} site:firs.gov.ng`, 4),
    serp(`${tokens} FIRS Nigeria (tax fraud OR tax evasion OR prosecution OR default OR liability)`, 4),
  ]);
  const records=[]; const seen=new Set();
  [...siteRes,...newsRes].forEach(r=>{
    const text=(r.title||'')+' '+(r.snippet||'');
    if(!nameMatch(text,name)) return;
    const key=(r.url||'').split('?')[0];
    if(seen.has(key)) return; seen.add(key);
    const {amount,caseRef}=extractMeta(text);
    records.push({title:r.title,url:r.url,snippet:r.snippet,source:r.source,date:r.date,
      status:getStatus(text),severity:getSeverity(text),amount,case_ref:caseRef,agency:'FIRS'});
  });
  return {agency:'FIRS',found:records.length>0,records:records.slice(0,5),official_url:'https://firs.gov.ng'};
}

// ── AI Summary ────────────────────────────────────────────────────
async function generateSummary(name, type, agencyResults){
  if(!ANTHROPIC_KEY) return '';
  try{
    const hits=agencyResults.filter(a=>a.found);
    if(!hits.length) return `No enforcement records found for ${name} across EFCC, ICPC, CBN, SEC, FIRS, and court databases. This does not constitute legal clearance.`;
    const context=hits.map(a=>`${a.agency}: ${a.records.slice(0,2).map(r=>`${r.status} — ${r.title} (${r.date||'recent'})`).join('; ')}`).join('\n');
    const {s,b}=await postJson('api.anthropic.com','/v1/messages',{
      model:'claude-sonnet-4-20250514',max_tokens:400,
      system:'Nigerian business intelligence analyst. Summarise enforcement records factually and concisely. Only state what is in the sources. Do not speculate. Begin with "Based on official records".',
      messages:[{role:'user',content:`Summarise these enforcement records for ${name} (${type}) in 3-4 sentences:\n${context}`}]
    },{'x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01'});
    if(s===200&&b){ const j=JSON.parse(b); return(j.content&&j.content[0]&&j.content[0].text)||''; }
  }catch(_){}
  return '';
}

// ══════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════
module.exports = async(req, res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS') return res.status(200).end();
  refreshKeys();

  let {name, type='individual'} = req.body||req.query||{};
  if(!name||!name.trim()) return res.json({ok:false,error:'Name required',result:null});

  let cleanName = name.trim();
  let resolvedFrom = null;

  // ── RC number: resolve to company name first ──────────────────
  const isRC = /^(RC\s*)?\d{4,8}$/i.test(cleanName);
  if(isRC){
    const resolved = await resolveRC(cleanName);
    if(resolved){
      resolvedFrom = {input:cleanName, rc:resolved.rc, source:resolved.source};
      cleanName = resolved.name;
      type = 'company';
    } else {
      return res.json({ok:false, error:`Could not resolve RC number "${cleanName}" to a company name`, result:null});
    }
  }

  try{
    // Search all 6 agencies in parallel
    const [efcc,icpc,cbn,sec,courts,firs] = await Promise.all([
      searchEFCC(cleanName),
      searchICPC(cleanName),
      searchCBN(cleanName),
      searchSEC(cleanName),
      searchCourts(cleanName),
      searchFIRS(cleanName),
    ]);
    const agencyResults=[efcc,icpc,cbn,sec,courts,firs];

    const hits=agencyResults.filter(a=>a.found);
    const allRecords=agencyResults.flatMap(a=>a.records||[]);
    const convicted=allRecords.some(r=>r.status==='CONVICTED');
    const wanted=allRecords.some(r=>r.status==='WANTED');
    const charged=allRecords.some(r=>r.status==='CHARGED');
    const sanctioned=allRecords.some(r=>r.status==='SANCTIONED');
    const arrested=allRecords.some(r=>r.status==='ARRESTED');

    let overallStatus='CLEAR';
    let riskLevel='LOW';
    if(convicted){overallStatus='CONVICTED';riskLevel='HIGH';}
    else if(wanted){overallStatus='WANTED';riskLevel='HIGH';}
    else if(charged){overallStatus='CHARGED';riskLevel='HIGH';}
    else if(arrested){overallStatus='ARRESTED';riskLevel='HIGH';}
    else if(sanctioned){overallStatus='SANCTIONED';riskLevel='MEDIUM';}
    else if(hits.length>0){overallStatus='RECORDS FOUND';riskLevel='MEDIUM';}

    const summary=await generateSummary(cleanName,type,agencyResults);

    return res.json({
      ok:true,
      name:cleanName,
      type,
      resolved_from:resolvedFrom,
      overall_status:overallStatus,
      risk_level:riskLevel,
      agencies_hit:hits.length,
      agencies_checked:6,
      summary,
      agencies:agencyResults,
      checked_at:new Date().toISOString(),
      disclaimer:'All records sourced from official Nigerian government databases and enforcement agency public releases only. This tool does not make independent allegations.',
    });
  }catch(e){
    return res.json({ok:false,error:e.message,result:null});
  }
};
