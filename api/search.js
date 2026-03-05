// Check Am v3.0 — /api/search
// Nigerian Intelligence Pipeline:
// CAC · EFCC · ICPC · CBN · SEC · Courts · FIRS · Nigerian News · Blogs/Research · Mapbox · AI

const https = require("https");

function cleanKey(r) { return String(r||"").replace(/[^\x21-\x7E]/g,"").trim(); }

const ANTHROPIC_KEY  = cleanKey(process.env.ANTHROPIC_API_KEY);
const GOOGLE_KEY     = cleanKey(process.env.GOOGLE_API_KEY);
const GOOGLE_CX      = cleanKey(process.env.GOOGLE_CX);
const MAPBOX_TOKEN   = cleanKey(process.env.MAPBOX_TOKEN);

// ─── HTTP GET (never throws — always resolves) ────────────────────
function get(url, hdrs={}, ms=12000) {
  return new Promise(resolve => {
    try {
      const req = https.get(url, {
        headers: {
          "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          "Accept":"text/html,application/json,*/*",
          ...hdrs
        }
      }, res => {
        if([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
          return get(res.headers.location,hdrs,ms).then(resolve);
        let b="";
        res.on("data",c=>b+=c);
        res.on("end",()=>resolve({s:res.statusCode,b}));
      });
      req.on("error",()=>resolve({s:0,b:""}));
      req.setTimeout(ms,()=>{req.destroy();resolve({s:0,b:""});});
    } catch(_){ resolve({s:0,b:""}); }
  });
}

// ─── Google Custom Search ─────────────────────────────────────────
async function gSearch(query, num=8) {
  if(!GOOGLE_KEY||!GOOGLE_CX) return [];
  try {
    const url=`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&num=${num}`;
    const {s,b}=await get(url,{},10000);
    if(s===200){ const j=JSON.parse(b); return j.items||[]; }
  } catch(_){}
  return [];
}

// ─── Direct site:search via Google ───────────────────────────────
function siteSearch(site, name, extra="") {
  return gSearch(`site:${site} "${name}" ${extra}`, 5);
}

// ─── 1. CAC Nigeria ──────────────────────────────────────────────
async function scanCAC(entity, isCompany) {
  const out={source:"CAC Nigeria",found:false,data:{}};
  try {
    const enc=encodeURIComponent(entity.trim());
    const url=isCompany
      ?`https://search.cac.gov.ng/home/searchSimilarBusiness?name=${enc}`
      :`https://search.cac.gov.ng/home/searchDirector?name=${enc}`;
    const {s,b}=await get(url);
    if(s===200){
      try {
        const j=JSON.parse(b);
        const records=j.data||j.results||(Array.isArray(j)?j:[]);
        if(records.length){
          out.found=true;
          const r=records[0];
          if(isCompany){
            out.data={
              name:r.company_name||r.CompanyName||r.name||entity,
              rc_number:r.rc_number||r.RcNumber||"—",
              status:r.status||r.CompanyStatus||"Active",
              type:r.company_type||r.CompanyType||"Private Limited Company",
              address:r.address||r.RegisteredAddress||"—",
              incorporated:r.date_of_incorporation||r.DateOfIncorporation||"—",
              email:r.email||"—",
              directors:(r.directors||[]).map(d=>typeof d==="string"?d:d.name||d.director_name||""),
              shareholders:r.shareholders||[],
              cac_records:records.slice(0,6).map(x=>({
                name:x.company_name||x.CompanyName||x.name,
                rc:x.rc_number||x.RcNumber||"—",
                status:x.status||"—"
              }))
            };
          } else {
            out.data={
              name:entity,
              companies:records.map(x=>({
                company:x.company_name||x.CompanyName||x.name||"Unknown",
                rc:x.rc_number||x.RcNumber||"—",
                role:x.role||x.designation||"Director",
                status:x.status||"Active"
              }))
            };
          }
        }
      } catch(_) {}
    }
  } catch(e){ out.error=e.message; }
  return out;
}

// ─── 2. EFCC scan ────────────────────────────────────────────────
async function scanEFCC(name) {
  const out={source:"EFCC",found:false,records:[]};
  try {
    // Direct EFCC wanted page
    const [{s,b}, googleResults] = await Promise.all([
      get(`https://efcc.gov.ng/efcc/wanted`),
      siteSearch("efcc.gov.ng", name, "conviction OR wanted OR charged OR arraigned")
    ]);

    // Check if name appears in wanted page
    if(s===200 && b.toLowerCase().includes(name.toLowerCase())){
      out.found=true;
      out.records.push({type:"WANTED_LIST",source:"EFCC Official Website",detail:`Name "${name}" found in EFCC wanted persons list`,severity:"HIGH"});
    }

    // Process Google results from EFCC site
    googleResults.forEach(r=>{
      const text=(r.title||"")+" "+(r.snippet||"");
      const isMatch=text.toLowerCase().includes(name.toLowerCase());
      if(isMatch){
        out.found=true;
        const severity=["convicted","sentenced","guilty"].some(w=>text.toLowerCase().includes(w))?"HIGH":"MEDIUM";
        out.records.push({
          type:"EFCC_REPORT",
          title:r.title,
          snippet:r.snippet,
          url:r.link,
          source:"efcc.gov.ng",
          severity
        });
      }
    });
  } catch(e){ out.error=e.message; }
  return out;
}

// ─── 3. ICPC scan ────────────────────────────────────────────────
async function scanICPC(name) {
  const out={source:"ICPC",found:false,records:[]};
  try {
    const results=await siteSearch("icpc.gov.ng", name, "prosecution OR conviction OR charged");
    results.forEach(r=>{
      const text=(r.title||"")+" "+(r.snippet||"");
      if(text.toLowerCase().includes(name.toLowerCase())){
        out.found=true;
        out.records.push({type:"ICPC_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:"icpc.gov.ng",severity:"HIGH"});
      }
    });
  } catch(e){ out.error=e.message; }
  return out;
}

// ─── 4. CBN debarment & sanctions ───────────────────────────────
async function scanCBN(name) {
  const out={source:"CBN",found:false,records:[]};
  try {
    const [debarRes, googleRes] = await Promise.all([
      get(`https://www.cbn.gov.ng/Supervision/Inst-DBar.asp`),
      siteSearch("cbn.gov.ng", name, "debarment OR sanction OR prohibition OR revoked")
    ]);

    if(debarRes.s===200 && debarRes.b.toLowerCase().includes(name.toLowerCase())){
      out.found=true;
      out.records.push({type:"CBN_DEBARMENT",source:"CBN Debarment List",detail:`"${name}" found on CBN debarred persons/institutions list`,severity:"HIGH"});
    }

    googleRes.forEach(r=>{
      const text=(r.title||"")+" "+(r.snippet||"");
      if(text.toLowerCase().includes(name.toLowerCase())){
        out.found=true;
        out.records.push({type:"CBN_RECORD",title:r.title,snippet:r.snippet,url:r.link,source:"cbn.gov.ng",severity:"MEDIUM"});
      }
    });
  } catch(e){ out.error=e.message; }
  return out;
}

// ─── 5. SEC Nigeria ──────────────────────────────────────────────
async function scanSEC(name) {
  const out={source:"SEC Nigeria",found:false,records:[]};
  try {
    const results=await Promise.all([
      siteSearch("sec.gov.ng", name, "deregistered OR suspended OR enforcement OR sanction"),
      siteSearch("sec.gov.ng", name, "registered operator dealer broker")
    ]);
    [...results[0],...results[1]].forEach(r=>{
      const text=(r.title||"")+" "+(r.snippet||"");
      if(text.toLowerCase().includes(name.toLowerCase())){
        out.found=true;
        const isSanction=["deregistered","suspended","sanction","enforcement"].some(w=>text.toLowerCase().includes(w));
        out.records.push({
          type:isSanction?"SEC_SANCTION":"SEC_REGISTRATION",
          title:r.title,snippet:r.snippet,url:r.link,
          source:"sec.gov.ng",
          severity:isSanction?"HIGH":"LOW"
        });
      }
    });
  } catch(e){ out.error=e.message; }
  return out;
}

// ─── 6. Court records ────────────────────────────────────────────
async function scanCourts(name) {
  const out={source:"Court Records",found:false,records:[]};
  try {
    const courtSites=[
      {site:"nicn.gov.ng",label:"National Industrial Court"},
      {site:"courtofappeal.gov.ng",label:"Court of Appeal"},
      {site:"supremecourt.gov.ng",label:"Supreme Court"},
      {site:"legalnaija.com",label:"LegalNaija Database"},
    ];
    const searches=await Promise.all(courtSites.map(c=>siteSearch(c.site,name,"judgment OR ruling OR suit").then(res=>({...c,res}))));
    searches.forEach(({site,label,res})=>{
      res.forEach(r=>{
        const text=(r.title||"")+" "+(r.snippet||"");
        if(text.toLowerCase().includes(name.toLowerCase())){
          out.found=true;
          out.records.push({type:"COURT_RECORD",court:label,title:r.title,snippet:r.snippet,url:r.link,source:site,severity:"MEDIUM"});
        }
      });
    });
  } catch(e){ out.error=e.message; }
  return out;
}

// ─── 7. FIRS tax notices ─────────────────────────────────────────
async function scanFIRS(name) {
  const out={source:"FIRS",found:false,records:[]};
  try {
    const results=await siteSearch("firs.gov.ng",name,"tax defaulter OR prosecution OR notice");
    results.forEach(r=>{
      const text=(r.title||"")+" "+(r.snippet||"");
      if(text.toLowerCase().includes(name.toLowerCase())){
        out.found=true;
        out.records.push({type:"FIRS_NOTICE",title:r.title,snippet:r.snippet,url:r.link,source:"firs.gov.ng",severity:"MEDIUM"});
      }
    });
  } catch(e){ out.error=e.message; }
  return out;
}

// ─── 8. Nigerian news — all major outlets ───────────────────────
const NG_NEWS_SITES = [
  "punchng.com","vanguardngr.com","premiumtimesng.com","thecable.ng",
  "businessday.ng","thisdaylive.com","guardian.ng","dailytrust.com",
  "channelstv.com","nta.ng","tribuneonlineng.com","sunnewsonline.com",
  "leadership.ng","nationalhelm.ng","ripplesnigeria.com"
].join(" OR site:");

// Research & blogs
const NG_RESEARCH_SITES = [
  "stears.co","proshareng.com","nairametrics.com","dataphyte.com",
  "budgit.org","sbmintel.com","noipollsng.com","thenigerialawyer.com",
  "businesselitesafrica.com","techcabal.com","techpoint.africa"
].join(" OR site:");

async function scanNigerianNews(name) {
  const out={source:"Nigerian News",articles:[],sentiment_score:50,negative_count:0};
  try {
    const [newsItems, researchItems] = await Promise.all([
      gSearch(`("${name}") (site:${NG_NEWS_SITES})`, 10),
      gSearch(`("${name}") (site:${NG_RESEARCH_SITES})`, 5),
    ]);

    const NEG_WORDS=["fraud","corrupt","efcc","icpc","arrest","scam","scandal","investigation","laundering","fake","ponzi","illegal","probe","arraign","convict","detain","fleece","embezzle","bribe","theft","forgery"];
    const POS_WORDS=["award","growth","expand","invest","partner","landmark","profit","recognised","commend","appoint","launch","record","merit","honour"];

    const processItem=(item, isResearch=false)=>{
      const text=((item.title||"")+" "+(item.snippet||"")).toLowerCase();
      const neg=NEG_WORDS.filter(w=>text.includes(w)).length;
      const pos=POS_WORDS.filter(w=>text.includes(w)).length;
      const sentiment=neg>pos?"negative":pos>0?"positive":"neutral";
      const date=item.pagemap?.metatags?.[0]?.["article:published_time"]?.substring(0,10)||item.pagemap?.metatags?.[0]?.["date"]?.substring(0,4)||"2024";
      return{
        title:item.title,snippet:item.snippet,url:item.link,
        source:item.displayLink,date,sentiment,
        type:isResearch?"research":"news"
      };
    };

    const allArticles=[
      ...newsItems.map(i=>processItem(i,false)),
      ...researchItems.map(i=>processItem(i,true))
    ];

    out.articles=allArticles;
    out.negative_count=allArticles.filter(a=>a.sentiment==="negative").length;
    const pos=allArticles.filter(a=>a.sentiment==="positive").length;
    out.sentiment_score=allArticles.length?Math.round((pos/allArticles.length)*100):50;
  } catch(e){ out.error=e.message; }
  return out;
}

// ─── 9. Mapbox geocoding ─────────────────────────────────────────
async function geocode(address, entityName) {
  const FALLBACK={
    "victoria island":{lat:6.4281,lng:3.4219},"ikoyi":{lat:6.4549,lng:3.4366},
    "lekki":{lat:6.4655,lng:3.5403},"ikeja":{lat:6.5954,lng:3.3417},
    "marina":{lat:6.4530,lng:3.3958},"abuja":{lat:9.0765,lng:7.3986},
    "port harcourt":{lat:4.8156,lng:7.0498},"kano":{lat:12.002,lng:8.5920},
    "ibadan":{lat:7.3775,lng:3.9470},"enugu":{lat:6.4162,lng:7.4942},
    "lagos":{lat:6.5244,lng:3.3792},
  };
  const combined=`${address} ${entityName}`.toLowerCase();
  for(const[k,v]of Object.entries(FALLBACK)) if(combined.includes(k)) return{...v,source:"match"};

  if(!MAPBOX_TOKEN||!address||address==="—") return{lat:6.5244,lng:3.3792,source:"default"};
  try{
    const q=encodeURIComponent(`${address}, Nigeria`);
    const url=`https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json?access_token=${MAPBOX_TOKEN}&country=NG&limit=1`;
    const {s,b}=await get(url);
    if(s===200){
      const j=JSON.parse(b);
      const f=j.features?.[0];
      if(f) return{lng:f.center[0],lat:f.center[1],place_name:f.place_name,source:"mapbox"};
    }
  } catch(_){}
  return{lat:6.5244,lng:3.3792,source:"default"};
}

// ─── 11. Build network graph ──────────────────────────────────────
function buildNetwork(entity, cac, isCompany) {
  const nodes=[{id:"root",label:entity,type:isCompany?"company":"individual",level:0}];
  const edges=[];
  if(isCompany){
    (cac.data?.directors||[]).filter(Boolean).slice(0,5).forEach((d,i)=>{
      const name=typeof d==="string"?d:d.name||d;if(!name)return;
      nodes.push({id:`d${i}`,label:name,type:"individual",level:1,clickable:true,search:name,searchType:"individual"});
      edges.push({from:"root",to:`d${i}`,label:"director"});
    });
    (cac.data?.cac_records||[]).slice(1,4).forEach((r,i)=>{
      if(r.name&&r.name!==entity){
        nodes.push({id:`r${i}`,label:r.name,type:"subsidiary",level:2,clickable:true,search:r.name,searchType:"company"});
        edges.push({from:"root",to:`r${i}`,label:"related entity"});
      }
    });
  } else {
    (cac.data?.companies||[]).slice(0,6).forEach((c,i)=>{
      const name=c.company||c;if(!name)return;
      nodes.push({id:`c${i}`,label:name,type:"company",level:1,clickable:true,search:name,searchType:"company",role:c.role||"Director",rc:c.rc||""});
      edges.push({from:"root",to:`c${i}`,label:c.role||"Director"});
    });
  }
  return{nodes,edges,node_count:nodes.length,edge_count:edges.length};
}

// ─── 12. Risk scoring ────────────────────────────────────────────
function computeRisk(cac, regulatory, news) {
  let l=52,r=30,inf=42;
  const flags=[];
  const sources=[];

  if(cac.found){l+=15;sources.push("CAC Nigeria");}
  if((cac.data?.directors||[]).length>2) inf+=8;
  if((cac.data?.companies||[]).length>3){inf+=18;l+=5;}
  if(cac.data?.status==="Active"||cac.data?.status==="ACTIVE") l+=8;

  // Regulatory hits
  if(regulatory.efcc?.found){
    const sev=regulatory.efcc.records.some(x=>x.severity==="HIGH");
    r+=sev?35:18; flags.push("EFCC_RECORD"); sources.push("EFCC");
    if(sev) flags.push("CRIMINAL_FLAG");
  }
  if(regulatory.icpc?.found){r+=28;flags.push("ICPC_RECORD");sources.push("ICPC");}
  if(regulatory.cbn?.found){r+=22;flags.push("CBN_ACTION");sources.push("CBN");}
  if(regulatory.sec?.records?.some(x=>x.type==="SEC_SANCTION")){r+=18;flags.push("SEC_SANCTION");sources.push("SEC Nigeria");}
  if(regulatory.courts?.found){r+=15;flags.push("COURT_RECORD");sources.push("Court Records");}
  if(regulatory.firs?.found){r+=10;flags.push("FIRS_NOTICE");sources.push("FIRS");}

  // News signals
  const negCount=news.negative_count||0;
  if(negCount>=3){r+=20;flags.push("NEGATIVE_PRESS");}
  else if(negCount>=1){r+=8;}
  if((news.sentiment_score||50)>70) l+=8;
  if(news.articles?.length) sources.push("Nigerian News");

  // PEP detection from news
  const allText=(news.articles||[]).map(a=>`${a.title} ${a.snippet}`).join(" ").toLowerCase();
  const pepTerms=["minister","governor","senator","commissioner","president","chairman federal","lawmaker","house of rep"];
  if(pepTerms.some(t=>allText.includes(t))){flags.push("PEP_LINKED");r+=12;inf+=15;}

  // Foreign exposure
  if((cac.data?.foreign_links||[]).length) flags.push("FOREIGN_EXPOSURE");

  l=Math.min(99,Math.max(8,l));
  r=Math.min(95,Math.max(5,r));
  inf=Math.min(99,Math.max(8,inf));

  return{
    legitimacy_score:l,risk_score:r,influence_score:inf,
    rating:r<35?"LOW RISK":r<60?"MEDIUM RISK":"HIGH RISK",
    confidence:cac.found?"HIGH":"MEDIUM",
    flags:[...new Set(flags)],
    pep_linked:flags.includes("PEP_LINKED"),
    data_sources:[...new Set(sources)],
  };
}

// ─── 13. AI synthesis ────────────────────────────────────────────
async function synthesize(entity, isCompany, intel) {
  if(!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not configured");
  const summary={
    entity,type:isCompany?"Company":"Individual",
    cac_status:intel.cac.found?`Found — RC: ${intel.cac.data?.rc_number||"—"}`:"Not found in public CAC registry",
    regulatory_hits:[
      intel.efcc.found&&"EFCC records found",
      intel.icpc.found&&"ICPC records found",
      intel.cbn.found&&"CBN action found",
      intel.courts.found&&"Court records found",
      intel.firs.found&&"FIRS notices found",
    ].filter(Boolean),
    news_summary:{
      total:intel.news.articles?.length||0,
      negative:intel.news.negative_count||0,
      positive:intel.news.articles?.filter(a=>a.sentiment==="positive").length||0,
      top_headlines:(intel.news.articles||[]).slice(0,4).map(a=>a.title),
    },
    risk_rating:intel.scores.rating,
    flags:intel.scores.flags,
  };
  const resp=await postJson(
    "api.anthropic.com","/v1/messages",
    {
      model:"claude-sonnet-4-20250514",
      max_tokens:900,
      system:`You are Check Am, Nigeria's premier business intelligence platform.
Write a sharp 3-paragraph executive intelligence report from the data:
1. Entity overview & CAC/registration status
2. Regulatory exposure, risk flags, court/enforcement findings
3. Overall verdict and due diligence recommendation
Use **bold** for key findings. Be direct, professional, data-driven.
Never mention AI, Claude, Anthropic, or technical systems.`,
      messages:[{role:"user",content:`Intelligence data:\n${JSON.stringify(summary,null,2)}\n\nWrite executive summary for: ${entity}`}]
    },
    {"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"}
  );
  if(resp.error) throw new Error(resp.error.message);
  return resp.content?.[0]?.text||"Analysis complete.";
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

// ─── Main handler ─────────────────────────────────────────────────
module.exports=async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  if(!ANTHROPIC_KEY) return res.status(503).json({error:"ANTHROPIC_API_KEY not configured in Vercel environment variables."});

  const{entity,type:entityType="company"}=req.body||{};
  if(!entity) return res.status(400).json({error:"No entity provided"});

  const isCompany=entityType==="company";

  try {
    // Run all sources in parallel
    const [cac, efcc, icpc, cbn, sec, courts, firs, news] = await Promise.all([
      scanCAC(entity, isCompany),
      scanEFCC(entity),
      scanICPC(entity),
      scanCBN(entity),
      scanSEC(entity),
      scanCourts(entity),
      scanFIRS(entity),
      scanNigerianNews(entity),
    ]);

    const regulatory={efcc,icpc,cbn,sec,courts,firs};
    const scores=computeRisk(cac,regulatory,news);

    // Geocode
    const address=cac.data?.address||"Lagos, Nigeria";
    const geo=await geocode(address,entity);

    // Build network
    const network=buildNetwork(entity,cac,isCompany);

    // AI synthesis
    const intel={cac,efcc,icpc,cbn,sec,courts,firs,news,scores};
    let summary="";
    try { summary=await synthesize(entity,isCompany,intel); }
    catch(e){ summary=`Check Am analysis for **${entity}** complete. Risk: **${scores.rating}**. ${cac.found?"CAC records located.":"Not found in CAC registry."} ${efcc.found?"⚠ EFCC records detected.":""} ${courts.found?"⚠ Court records found.":""}`; }

    return res.status(200).json({
      text:summary,
      data:{
        entity:entity,
        type:entityType,
        company:isCompany?{
          name:cac.data?.name||entity,
          rc_number:cac.data?.rc_number||"Not found",
          status:cac.data?.status||"Unknown",
          type:cac.data?.type||"—",
          address:address,
          incorporated:cac.data?.incorporated||"—",
          email:cac.data?.email||"—",
          directors:cac.data?.directors||[],
          shareholders:cac.data?.shareholders||[],
          cac_found:cac.found,
          cac_records:cac.data?.cac_records||[],
        }:{},
        individual:!isCompany?{
          name:cac.data?.name||entity,
          pep_status:scores.pep_linked,
          companies:cac.data?.companies||[],
          cac_found:cac.found,
        }:{},
        regulatory:{
          efcc,icpc,cbn,sec,courts,firs,
          total_hits:[efcc,icpc,cbn,sec,courts,firs].filter(x=>x.found).length,
        },
        media:news,
        network,
        scores,
        geo:{address,lat:geo.lat,lng:geo.lng,mapbox_token:MAPBOX_TOKEN||"",source:geo.source},
      }
    });
  } catch(e){
    console.error("Check Am error:",e.message);
    return res.status(500).json({error:e.message});
  }
};
