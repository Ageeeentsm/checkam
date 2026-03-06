// Check Am v4 — /api/search  (robust, multi-strategy)
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
const ANTHROPIC_KEY = cleanKey(process.env.ANTHROPIC_API_KEY);
const GOOGLE_KEY    = cleanKey(process.env.GOOGLE_API_KEY);
const GOOGLE_CX     = cleanKey(process.env.GOOGLE_CX);
const MAPBOX_TOKEN  = cleanKey(process.env.MAPBOX_TOKEN);

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

// ── Google search (graceful) ──────────────────────────────────────
async function gSearch(query,num=8){
  if(!GOOGLE_KEY||!GOOGLE_CX)return[];
  try{
    const {s,b}=await get(`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&num=${num}`,{},10000);
    if(s===200){const j=JSON.parse(b);return j.items||[];}
  }catch(_){}
  return[];
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

// ── 1. CAC — multi-strategy ───────────────────────────────────────
async function scanCAC(entity,isCompany){
  const out={source:"CAC Nigeria",found:false,data:{},raw_records:[]};
  const isRC=/^(RC\s*)?(\d{4,8})$/i.test(entity.trim());
  const rcNum=isRC?(entity.replace(/^RC\s*/i,"")):"";

  const attempts=isCompany?[
    isRC?`https://search.cac.gov.ng/home/searchByRC?rc=${rcNum}`:null,
    `https://search.cac.gov.ng/home/searchSimilarBusiness?name=${encodeURIComponent(entity)}`,
    `https://search.cac.gov.ng/home/searchNameAvailability?name=${encodeURIComponent(entity)}`,
    // Try without quotes/special chars
    `https://search.cac.gov.ng/home/searchSimilarBusiness?name=${encodeURIComponent(entity.replace(/[^a-zA-Z0-9\s]/g,"").trim())}`,
  ].filter(Boolean):[
    `https://search.cac.gov.ng/home/searchDirector?name=${encodeURIComponent(entity)}`,
    `https://search.cac.gov.ng/home/searchDirector?name=${encodeURIComponent(entity.split(" ").slice(-1)[0])}`,
  ];

  let records=[];
  for(const url of attempts){
    const {s,b}=await get(url);
    if(s===200&&b){
      records=parseCACRecords(b);
      if(records.length)break;
    }
  }

  // Fallback: scrape CAC website search page
  if(!records.length){
    const {s,b}=await get(`https://search.cac.gov.ng/home?name=${encodeURIComponent(entity)}`);
    if(s===200&&b){
      // Extract from HTML
      const nameMatches=b.match(/company_name[^>]*>([^<]+)/gi)||[];
      const rcMatches=b.match(/RC\s*\d{5,8}/gi)||[];
      if(rcMatches.length){
        records=[{company_name:entity,rc_number:rcMatches[0],status:"Active"}];
      }
    }
  }

  // Google fallback for entity resolution
  if(!records.length&&GOOGLE_KEY&&GOOGLE_CX){
    const items=await gSearch(`"${entity}" CAC Nigeria RC number registered company`);
    if(items.length){
      const text=(items[0].title||"")+" "+(items[0].snippet||"");
      const rcMatch=text.match(/RC[\s:\-]?(\d{4,8})/i);
      records=[{
        company_name:entity,
        rc_number:rcMatch?"RC"+rcMatch[1]:"—",
        status:"Active",
        address:items[0].snippet||"—",
        _source:"google_fallback"
      }];
    }
  }

  if(!records.length)return out;
  out.found=true;
  out.raw_records=records.slice(0,8);

  const r=records[0];
  if(isCompany){
    // Extract directors — try multiple shapes
    let directors=[];
    if(Array.isArray(r.directors))directors=r.directors.map(d=>typeof d==="string"?d:(d.name||d.director_name||d.DirectorName||JSON.stringify(d))).filter(Boolean);
    else if(Array.isArray(r.Shareholders))directors=r.Shareholders.map(s=>s.name||s).filter(Boolean);

    // Shareholders
    let shareholders=[];
    if(Array.isArray(r.shareholders))shareholders=r.shareholders.map(s=>({name:s.name||s,percentage:s.percentage||s.shares||0}));

    // Additional related companies from all records
    const relatedCompanies=records.slice(1,5).map(x=>({
      name:extractField(x,"company_name","CompanyName","name"),
      rc:extractField(x,"rc_number","RcNumber","rc"),
      status:extractField(x,"status","CompanyStatus"),
    })).filter(x=>x.name&&x.name!=="—");

    out.data={
      name:extractField(r,"company_name","CompanyName","name")||entity,
      rc_number:extractField(r,"rc_number","RcNumber","rc"),
      status:extractField(r,"status","CompanyStatus"),
      type:extractField(r,"company_type","CompanyType","type"),
      address:extractField(r,"address","RegisteredAddress","registeredAddress"),
      incorporated:extractField(r,"date_of_incorporation","DateOfIncorporation","incorporationDate"),
      email:extractField(r,"email","Email"),
      phone:extractField(r,"phone","Phone","telephone"),
      directors,shareholders,
      related_companies:relatedCompanies,
      cac_records:out.raw_records.map(x=>({
        name:extractField(x,"company_name","CompanyName","name"),
        rc:extractField(x,"rc_number","RcNumber","rc"),
        status:extractField(x,"status","CompanyStatus"),
      })),
    };
  } else {
    // Individual director search results
    const companies=records.map(x=>({
      company:extractField(x,"company_name","CompanyName","name"),
      rc:extractField(x,"rc_number","RcNumber","rc"),
      role:extractField(x,"role","designation","Designation"),
      status:extractField(x,"status","CompanyStatus"),
    })).filter(x=>x.company&&x.company!=="—");
    out.data={name:entity,companies};
  }
  return out;
}

// ── 2. EFCC ───────────────────────────────────────────────────────
async function scanEFCC(name){
  const out={source:"EFCC",found:false,records:[]};
  try{
    const [wantedRes,googleRes]=await Promise.all([
      get("https://efcc.gov.ng/efcc/wanted"),
      gSearch(`site:efcc.gov.ng "${name}"`,6),
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
    const res=await gSearch(`site:icpc.gov.ng "${name}"`,5);
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
      gSearch(`site:cbn.gov.ng "${name}"`,5),
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
    const res=await gSearch(`site:sec.gov.ng "${name}"`,5);
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
    const res=await gSearch(`site:firs.gov.ng "${name}"`,4);
    res.forEach(r=>{
      out.found=true;
      out.records.push({type:"FIRS_NOTICE",title:r.title,snippet:r.snippet,url:r.link,source:"firs.gov.ng",severity:"MEDIUM"});
    });
  }catch(e){out.error=e.message;}
  return out;
}

// ── 8. Nigerian news + research ───────────────────────────────────
// Split into two separate queries — Google API rejects very long site: chains
const NEWS_SITES_A = "punchng.com OR site:vanguardngr.com OR site:premiumtimesng.com OR site:thecable.ng OR site:businessday.ng OR site:thisdaylive.com OR site:guardian.ng OR site:dailytrust.com";
const NEWS_SITES_B = "channelstv.com OR site:tribuneonlineng.com OR site:leadership.ng OR site:ripplesnigeria.com OR site:nairametrics.com OR site:proshareng.com OR site:stears.co OR site:sbmintel.com";

async function scanNews(name){
  const out={source:"Nigerian News",articles:[],sentiment_score:50,negative_count:0};
  const NEG=["fraud","corrupt","efcc","icpc","arrest","scam","scandal","laundering","ponzi","illegal","probe","arraign","convict","embezzle","bribe"];
  const POS=["award","growth","invest","profit","expand","recognised","commend","launch","record","honour","partner"];
  try{
    const [a,b,c]=await Promise.all([
      gSearch(`"${name}" site:${NEWS_SITES_A}`,8),
      gSearch(`"${name}" site:${NEWS_SITES_B}`,6),
      // General Nigerian business news without site restriction as fallback
      gSearch(`"${name}" Nigeria business news`,5),
    ]);
    const all=[...a,...b,...c];
    const seen=new Set();
    const articles=[];
    all.forEach(item=>{
      if(seen.has(item.link))return;seen.add(item.link);
      const text=((item.title||"")+" "+(item.snippet||"")).toLowerCase();
      const neg=NEG.filter(w=>text.includes(w)).length;
      const pos=POS.filter(w=>text.includes(w)).length;
      const sentiment=neg>pos?"negative":pos>0?"positive":"neutral";
      const isResearch=["stears","proshare","nairametrics","sbmintel","budgit"].some(s=>(item.displayLink||"").includes(s));
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
  const FB={"victoria island":{lat:6.4281,lng:3.4219},"ikoyi":{lat:6.4549,lng:3.4366},"lekki":{lat:6.4655,lng:3.5403},"ikeja":{lat:6.5954,lng:3.3417},"marina":{lat:6.453,lng:3.3958},"abuja":{lat:9.0765,lng:7.3986},"port harcourt":{lat:4.8156,lng:7.0498},"kano":{lat:12.002,lng:8.592},"ibadan":{lat:7.3775,lng:3.947},"enugu":{lat:6.4162,lng:7.4942},"lagos":{lat:6.5244,lng:3.3792}};
  const combined=`${address} ${entity}`.toLowerCase();
  for(const[k,v]of Object.entries(FB))if(combined.includes(k))return{...v,source:"match"};
  if(!MAPBOX_TOKEN)return{lat:6.5244,lng:3.3792,source:"default"};
  try{
    const q=encodeURIComponent(`${address}, Nigeria`);
    const {s,b}=await get(`https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json?access_token=${MAPBOX_TOKEN}&country=NG&limit=1`);
    if(s===200){const j=JSON.parse(b);const f=j.features?.[0];if(f)return{lng:f.center[0],lat:f.center[1],source:"mapbox"};}
  }catch(_){}
  return{lat:6.5244,lng:3.3792,source:"default"};
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
    cac:intel.cac.found?`Verified — RC: ${intel.cac.data?.rc_number||"—"}, Status: ${intel.cac.data?.status||"—"}, Address: ${intel.cac.data?.address||"—"}`:"Not found in CAC public registry",
    directors:intel.cac.data?.directors||[],
    companies:intel.cac.data?.companies||[],
    regulatory_hits:[intel.efcc.found&&"EFCC",intel.icpc.found&&"ICPC",intel.cbn.found&&"CBN",intel.courts.found&&"Courts",intel.firs.found&&"FIRS"].filter(Boolean),
    top_reg_records:[...(intel.efcc.records||[]),...(intel.icpc.records||[]),...(intel.courts.records||[])].slice(0,3).map(r=>r.title||r.detail||""),
    news:{total:intel.news.articles?.length||0,negative:intel.news.negative_count||0,positive:intel.news.articles?.filter(a=>a.sentiment==="positive").length||0,headlines:(intel.news.articles||[]).slice(0,5).map(a=>a.title)},
    risk:intel.scores.rating,flags:intel.scores.flags,
  };
  const resp=await postJson("api.anthropic.com","/v1/messages",{
    model:"claude-sonnet-4-20250514",max_tokens:950,
    system:`You are Check Am, Nigeria's premier business intelligence platform. Write a sharp executive due diligence report in 3 paragraphs:
1. Entity profile & CAC registration status (name, RC, status, directors, address)
2. Enforcement & regulatory exposure (EFCC/ICPC/CBN/court findings) and media intelligence
3. Final verdict and specific due diligence recommendations
Use **bold** for key findings. Be direct and actionable. Never mention AI, Claude, Anthropic, or APIs.`,
    messages:[{role:"user",content:`Data:\n${JSON.stringify(summary,null,2)}\n\nWrite executive summary for: ${entity}`}]
  },{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"});
  if(resp.error)throw new Error(resp.error.message);
  return resp.content?.[0]?.text||"Analysis complete.";
}

// ── Main handler ──────────────────────────────────────────────────
module.exports=async function handler(req,res){
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
          name:cac.data?.name||entity,rc_number:cac.data?.rc_number||"Not in CAC",
          status:cac.data?.status||"Unknown",type:cac.data?.type||"—",
          address,incorporated:cac.data?.incorporated||"—",email:cac.data?.email||"—",
          directors:cac.data?.directors||[],shareholders:cac.data?.shareholders||[],
          related_companies:cac.data?.related_companies||[],
          cac_found:cac.found,cac_records:cac.data?.cac_records||[],
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
