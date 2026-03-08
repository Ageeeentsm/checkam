// Check Am v11 — /api/search
// Architecture: 3 SHORT focused queries → Claude synthesizes ALL intelligence
// Short queries = better Google KG + snippets = better data
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
let ANTHROPIC_KEY="",SERPAPI_KEY="",MAPBOX_TOKEN="";
function refreshKeys(){
  ANTHROPIC_KEY=cleanKey(process.env.ANTHROPIC_API_KEY);
  SERPAPI_KEY  =cleanKey(process.env.SERPAPI_KEY);
  MAPBOX_TOKEN =cleanKey(process.env.MAPBOX_TOKEN);
}

// ── HTTP ──────────────────────────────────────────────────────────
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

// ── SerpApi — returns full structured response ─────────────────────
async function serp(query,num=10){
  if(!SERPAPI_KEY) return {organic:[],kg:null,answer:null};
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=${encodeURIComponent(query)}&num=${num}&engine=google&gl=ng&hl=en&safe=off`;
    const {s,b}=await get(url,{},15000);
    if(s!==200||!b) return {organic:[],kg:null,answer:null};
    const j=JSON.parse(b);
    const organic=(j.organic_results||[]).slice(0,num).map(r=>({
      title:r.title||"",
      snippet:r.snippet||"",
      link:r.link||"",
      source:(r.displayed_link||r.link||"").replace(/^https?:\/\//,"").split("/")[0],
      date:r.date||""
    }));
    // Extract knowledge graph — most structured data
    const kg=j.knowledge_graph ? {
      title:j.knowledge_graph.title,
      type:j.knowledge_graph.type,
      description:j.knowledge_graph.description,
      website:j.knowledge_graph.website||j.knowledge_graph.official_website,
      phone:j.knowledge_graph.phone,
      address:j.knowledge_graph.address||j.knowledge_graph.headquarters,
      founded:j.knowledge_graph.founded||j.knowledge_graph.incorporated,
      ceo:j.knowledge_graph.ceo,
      employees:j.knowledge_graph.number_of_employees,
      revenue:j.knowledge_graph.revenue,
      subsidiaries:j.knowledge_graph.subsidiaries,
      parent:j.knowledge_graph.parent_organization,
      people:j.knowledge_graph.people_also_searched_for||[],
    } : null;
    const answer=j.answer_box ? {
      title:j.answer_box.title,
      answer:j.answer_box.answer||j.answer_box.snippet,
    } : null;
    return {organic,kg,answer};
  }catch(_){return {organic:[],kg:null,answer:null};}
}

// ── CAC Direct Portal (try even though often DNS blocked) ──────────
async function cacDirect(query){
  const isRC=/^(RC\s*)?(\d{4,8})$/i.test(query.trim());
  const rcNum=isRC?query.trim().replace(/^RC\s*/i,""):"";
  const hdrs={"User-Agent":"Mozilla/5.0","Referer":"https://search.cac.gov.ng/","Accept":"application/json,*/*"};
  const urls=isRC?[
    `https://search.cac.gov.ng/api/search/public?rcNumber=${rcNum}`,
    `https://api.opencorporates.com/v0.4/companies/ng/${rcNum}`,
  ]:[
    `https://search.cac.gov.ng/api/search/public?name=${encodeURIComponent(query)}&page=0&size=5`,
  ];
  for(const url of urls){
    try{
      const {s,b}=await get(url,hdrs,8000);
      if(s===200&&b&&b.length>50){
        try{
          const j=JSON.parse(b);
          // CAC API format
          const list=j?.data||j?.content||j?.results||(Array.isArray(j)?j:[]);
          if(list.length) return {found:true,companies:list.map(mapCACCo)};
          // OpenCorporates format
          const oc=j?.results?.company;
          if(oc?.name) return {found:true,companies:[{
            name:oc.name, rc_number:"RC"+(oc.company_number||"").replace(/^0+/,""),
            status:oc.current_status||"Active", type:oc.company_type||"—",
            address:(oc.registered_address?.street_address||"")+" "+(oc.registered_address?.locality||""),
            email:"—", incorporated:oc.incorporation_date||"—",
            state:oc.registered_address?.region||"—", tin:"—", directors:[], shareholders:[],
          }]};
        }catch(_){}
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

// ── Geocode ────────────────────────────────────────────────────────
const GEO={
  "victoria island":{lat:6.4281,lng:3.4219},"v.i.":{lat:6.4281,lng:3.4219},"v/i":{lat:6.4281,lng:3.4219},
  "ikoyi":{lat:6.4549,lng:3.4366},"lekki":{lat:6.4655,lng:3.5403},
  "ikeja":{lat:6.5954,lng:3.3417},"maryland":{lat:6.5706,lng:3.3588},
  "surulere":{lat:6.4996,lng:3.3536},"yaba":{lat:6.5059,lng:3.3734},
  "marina":{lat:6.4530,lng:3.3958},"apapa":{lat:6.4474,lng:3.3617},
  "festac":{lat:6.4671,lng:3.2795},"oshodi":{lat:6.5581,lng:3.3508},
  "agege":{lat:6.6177,lng:3.3219},"lagos island":{lat:6.4541,lng:3.3947},
  "broad street":{lat:6.4518,lng:3.3884},"herbert macaulay":{lat:6.5059,lng:3.3734},
  "abuja":{lat:9.0765,lng:7.3986},"maitama":{lat:9.0836,lng:7.4931},
  "wuse":{lat:9.0579,lng:7.4802},"garki":{lat:9.0307,lng:7.4876},
  "asokoro":{lat:9.0403,lng:7.5319},"central business district":{lat:9.0579,lng:7.4951},
  "port harcourt":{lat:4.8156,lng:7.0498},"ph ":{lat:4.8156,lng:7.0498},
  "kano":{lat:12.002,lng:8.592},"kaduna":{lat:10.5264,lng:7.4382},
  "ibadan":{lat:7.3775,lng:3.947},"enugu":{lat:6.4162,lng:7.4942},
  "benin city":{lat:6.335,lng:5.627},"warri":{lat:5.5167,lng:5.75},
  "jos":{lat:9.8965,lng:8.8583},"onitsha":{lat:6.1449,lng:6.7858},
  "owerri":{lat:5.4836,lng:7.0333},"abeokuta":{lat:7.1562,lng:3.3458},
  "calabar":{lat:4.9518,lng:8.322},"uyo":{lat:5.0377,lng:7.9128},
  "sokoto":{lat:13.0059,lng:5.2476},"maiduguri":{lat:11.8311,lng:13.1510},
  "lagos":{lat:6.5244,lng:3.3792},
};
async function geocode(address,entity){
  const txt=(address+" "+entity).toLowerCase();
  for(const[k,v] of Object.entries(GEO)) if(txt.includes(k)) return {...v,source:"match"};
  if(MAPBOX_TOKEN){
    try{
      const term=(address&&address!=="—"&&address.length>5)?address:entity;
      const q=encodeURIComponent(term+", Nigeria");
      const {s,b}=await get(`https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json?access_token=${MAPBOX_TOKEN}&country=NG&limit=1`);
      if(s===200&&b){const f=JSON.parse(b).features?.[0];if(f)return{lng:f.center[0],lat:f.center[1],source:"mapbox"};}
    }catch(_){}
  }
  return {lat:6.5244,lng:3.3792,source:"default"};
}

// ── Network graph ──────────────────────────────────────────────────
function buildNetwork(entity,data,isCompany){
  const nodes=[{id:"root",label:entity,type:isCompany?"company":"individual",level:0,risk:false}];
  const edges=[];const seen=new Set(["root"]);
  if(isCompany){
    (data.directors||[]).slice(0,6).forEach((d,i)=>{
      if(!d.name||seen.has(d.name)) return; seen.add(d.name);
      nodes.push({id:"d"+i,label:d.name,type:"individual",level:1,risk:false});
      edges.push({from:"root",to:"d"+i,label:d.role||"Director"});
    });
    (data.shareholders||[]).slice(0,3).forEach((s,i)=>{
      if(!s.name||seen.has(s.name)) return; seen.add(s.name);
      nodes.push({id:"s"+i,label:s.name,type:"shareholder",level:1,risk:false});
      edges.push({from:"root",to:"s"+i,label:s.shares?"Shareholder ("+s.shares+")":"Shareholder"});
    });
  } else {
    (data.companies||[]).slice(0,5).forEach((c,i)=>{
      if(!c.name||seen.has(c.name)) return; seen.add(c.name);
      nodes.push({id:"c"+i,label:c.name,type:"company",level:1,risk:false});
      edges.push({from:"root",to:"c"+i,label:c.role||"Director"});
    });
  }
  return {nodes,edges};
}

// ── Score risk ─────────────────────────────────────────────────────
function scoreRisk(enf,neg,pep){
  let r=15,flags=[];
  if(enf.wanted){r+=45;flags.push("EFCC wanted list");}
  if(enf.efcc?.length){r+=30;flags.push("EFCC enforcement records");}
  if(enf.icpc?.length){r+=25;flags.push("ICPC enforcement records");}
  if(enf.cbn_debarred){r+=30;flags.push("CBN debarment");}
  if(enf.courts?.length){r+=15;flags.push("Court judgments");}
  if(enf.firs?.length){r+=10;flags.push("Tax enforcement");}
  if(neg>3){r+=15;flags.push("Negative media coverage");}
  if(pep){r+=10;flags.push("Politically exposed person");}
  const score=Math.min(r,95);
  const rating=score>=70?"HIGH RISK":score>=40?"MEDIUM RISK":"LOW RISK";
  const legit=Math.max(100-score-5,10);
  const infl=pep?Math.min(legit+20,90):legit;
  return {risk_score:score,legitimacy_score:legit,influence_score:infl,rating,flags,pep_linked:!!pep};
}

// ══════════════════════════════════════════════════════════════════
// FORMAT RAW RESULTS FOR CLAUDE — structured and readable
// ══════════════════════════════════════════════════════════════════
function formatForClaude(label, res){
  const lines=[];
  if(res.kg){
    lines.push(`=== GOOGLE KNOWLEDGE GRAPH ===`);
    Object.entries(res.kg).forEach(([k,v])=>{
      if(v && typeof v==="string" && v.trim()) lines.push(`${k}: ${v}`);
      else if(Array.isArray(v)&&v.length) lines.push(`${k}: ${JSON.stringify(v.slice(0,5))}`);
    });
  }
  if(res.answer) lines.push(`=== FEATURED ANSWER ===\n${res.answer.title||""}: ${res.answer.answer||""}`);
  if(res.organic?.length){
    lines.push(`=== ${label} RESULTS (${res.organic.length}) ===`);
    res.organic.forEach((r,i)=>{
      lines.push(`[${i+1}] ${r.source}\nTitle: ${r.title}\nSnippet: ${r.snippet}${r.date?" | "+r.date:""}\nURL: ${r.link}`);
    });
  }
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════════
// CLAUDE INTELLIGENCE SYNTHESIS — extracts everything from raw data
// ══════════════════════════════════════════════════════════════════
async function synthesize(entity,isCompany,isRC,rcNum,rawData,cacData){
  if(!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

  const today=new Date().toLocaleDateString("en-GB",{year:"numeric",month:"long",day:"numeric"});
  const eType=isCompany?"company":"individual";

  const system=`You are Check Am, Nigeria's #1 business intelligence platform. You extract structured intelligence from Google search results about Nigerian companies and individuals.

EXTRACTION RULES:
- Extract ONLY what is actually present in the search results. Do not hallucinate.
- RC numbers appear as "RC123456" or just digits in OpenCorporates URLs (/companies/ng/123456)
- OpenCorporates snippet format: "Company Number 177064, Status Active, Incorporated 14 May 1990..."
- Knowledge Graph often has the most reliable data — always prioritize it
- Directors appear in LinkedIn snippets, OpenCorporates, company websites
- EFCC/ICPC records appear in news snippets (punchng, vanguard, premium times, etc.)
- If enforcement not found, say "No records found" — do not invent
- For RC lookups: the company name is in the OpenCorporates page title before the RC number

Respond with ONLY valid JSON, no markdown, no explanation:
{
  "name": "exact official name",
  "rc_number": "RC123456 or —",
  "status": "Active / Inactive / Struck Off / —",
  "type": "Private Limited Company / Public Limited Company / Business Name / —",
  "incorporated": "DD Month YYYY or —",
  "address": "full street address or —",
  "state": "Lagos / Abuja / etc or —",
  "phone": "phone or —",
  "email": "email or —",
  "website": "https://... or —",
  "sector": "Banking / Oil & Gas / Telecom / FMCG / Construction / etc or —",
  "directors": [{"name":"Full Name","role":"Managing Director / CEO / Chairman / Director"}],
  "shareholders": [{"name":"Full Name","shares":"amount or %","type":"Ordinary"}],
  "companies": [],
  "pep": false,
  "pep_detail": "",
  "enforcement": {
    "wanted": false,
    "efcc": [],
    "icpc": [],
    "cbn_debarred": false,
    "courts": [],
    "firs": [],
    "sec": [],
    "summary": "No enforcement records found OR specific detail"
  },
  "news": [{"title":"headline","source":"punchng.com","date":"2024","url":"https://...","sentiment":"positive/negative/neutral"}],
  "neg_count": 0,
  "brief": "## CORPORATE IDENTITY\\n\\n[Full executive intelligence brief in markdown. Use **bold** for key facts. Include all findings. Be specific — names, dates, amounts, RC numbers, addresses. 4 sections: CORPORATE IDENTITY, LEADERSHIP & OWNERSHIP, REGULATORY & ENFORCEMENT, DUE DILIGENCE VERDICT.]"
}`;

  const cacBlock = cacData?.found&&cacData.companies?.length
    ? `\nCAC PORTAL (official source):\n${JSON.stringify(cacData.companies[0],null,1)}\n` : "";

  const user=`Entity: "${entity}" | Type: ${eType}${isRC?` | RC Number: RC${rcNum}`:""}
Date: ${today}
${cacBlock}
${rawData}`;

  const resp=await postJson("api.anthropic.com","/v1/messages",{
    model:"claude-sonnet-4-20250514",max_tokens:2200,system,
    messages:[{role:"user",content:user}]
  },{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"});

  if(resp.error) throw new Error(resp.error.message);
  let text=(resp.content?.[0]?.text||"{}").trim();
  text=text.replace(/^```json\s*/,"").replace(/^```\s*/,"").replace(/\s*```$/,"").trim();
  try{return JSON.parse(text);}
  catch(e){
    const m=text.match(/\{[\s\S]+\}/);
    if(m){try{return JSON.parse(m[0]);}catch(_){}}
    return null;
  }
}

// ── Main handler ───────────────────────────────────────────────────
module.exports=async function handler(req,res){
  refreshKeys();
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  if(!ANTHROPIC_KEY) return res.status(503).json({error:"ANTHROPIC_API_KEY not configured in Vercel."});

  const {entity,type:entityType="company"}=req.body||{};
  if(!entity) return res.status(400).json({error:"No entity provided"});

  const isRC=/^(RC\s*)?(\d{4,8})$/i.test(entity.trim());
  const rcNum=isRC?entity.trim().replace(/^RC\s*/i,""):"";
  const isCompany=isRC?true:entityType==="company";

  try{
    // ── 3 SHORT parallel queries ─────────────────────────────────
    // Short queries = better Knowledge Graph + more relevant snippets
    let q1,q2,q3;
    if(isRC){
      q1=`RC${rcNum} site:opencorporates.com/companies/ng`;
      q2=`RC${rcNum} nigeria`;
      q3=`RC${rcNum} company nigeria directors address`;
    } else if(isCompany){
      const bare=entity.replace(/\s*(limited|ltd\.?|plc)\s*$/i,"").trim();
      q1=`"${entity}" nigeria`;           // KG + general profile
      q2=`"${bare}" EFCC OR ICPC OR fraud OR court nigeria`;  // enforcement
      q3=`"${entity}" site:opencorporates.com/companies/ng OR "${bare}" nigeria rc number directors`;
    } else {
      q1=`"${entity}" nigeria`;
      q2=`"${entity}" EFCC OR ICPC OR fraud OR court nigeria`;
      q3=`"${entity}" nigeria company director position`;
    }

    const [r1,r2,r3,cacPortal]=await Promise.all([
      serp(q1,10),
      serp(q2,8),
      serp(q3,8),
      isCompany?cacDirect(entity).catch(()=>({found:false,companies:[]})):Promise.resolve({found:false,companies:[]}),
    ]);

    const rawData=[
      formatForClaude("PROFILE",r1),
      formatForClaude("ENFORCEMENT",r2),
      formatForClaude("REGISTRY",r3),
    ].filter(Boolean).join("\n\n---\n\n");

    const allSources=[...(r1.organic||[]),...(r2.organic||[]),...(r3.organic||[])];

    // ── Claude synthesizes everything ────────────────────────────
    let d=await synthesize(entity,isCompany,isRC,rcNum,rawData,cacPortal);

    // If Claude synthesis failed, build minimal fallback
    if(!d) d={name:entity,rc_number:isRC?`RC${rcNum}`:"—",status:"—",type:"—",incorporated:"—",address:"—",state:"—",phone:"—",email:"—",website:"—",sector:"—",directors:[],shareholders:[],companies:[],pep:false,pep_detail:"",enforcement:{wanted:false,efcc:[],icpc:[],cbn_debarred:false,courts:[],firs:[],sec:[],summary:"Analysis unavailable"},news:[],neg_count:0,brief:`**${entity}** — Intelligence gathered.`};

    // Merge CAC portal data (official source wins)
    if(cacPortal.found&&cacPortal.companies?.length){
      const c=cacPortal.companies[0];
      if(c.name&&c.name!=="—") d.name=c.name;
      if(c.rc_number&&c.rc_number!=="—") d.rc_number=c.rc_number;
      if(c.status&&c.status!=="—") d.status=c.status;
      if(c.type&&c.type!=="—") d.type=c.type;
      if(c.address&&c.address!=="—") d.address=c.address;
      if(c.email&&c.email!=="—") d.email=c.email;
      if(c.incorporated&&c.incorporated!=="—") d.incorporated=c.incorporated;
      if(c.state&&c.state!=="—") d.state=c.state;
      if(c.directors?.length){
        const pNames=new Set(c.directors.map(x=>x.name.toLowerCase()));
        d.directors=[...c.directors,...(d.directors||[]).filter(x=>!pNames.has(x.name.toLowerCase()))];
      }
      if(c.shareholders?.length) d.shareholders=c.shareholders;
    }

    const enf=d.enforcement||{};
    const scores=scoreRisk(enf,d.neg_count||0,d.pep);
    const address=d.address&&d.address!=="—"?d.address:entity;
    const geo=await geocode(address,entity);
    const network=buildNetwork(entity,d,isCompany);

    const regData={
      efcc:{found:!!(enf.efcc?.length||enf.wanted),records:enf.efcc||[],source:"EFCC"},
      icpc:{found:!!(enf.icpc?.length),records:enf.icpc||[],source:"ICPC"},
      cbn: {found:!!enf.cbn_debarred,records:enf.cbn_debarred?[{type:"CBN_DEBARMENT",severity:"HIGH"}]:[],source:"CBN"},
      courts:{found:!!(enf.courts?.length),records:enf.courts||[],source:"Courts"},
      firs:{found:!!(enf.firs?.length),records:enf.firs||[],source:"FIRS"},
      sec: {found:!!(enf.sec?.length),records:enf.sec||[],source:"SEC Nigeria"},
      total_hits:[enf.efcc?.length,enf.icpc?.length,enf.cbn_debarred,enf.courts?.length,enf.firs?.length,enf.sec?.length].filter(Boolean).length,
    };

    const newsData={
      articles:(d.news||[]).map(a=>({title:a.title||"",source:a.source||"",date:a.date||"",url:a.url||"",sentiment:a.sentiment||"neutral",summary:""})),
      negative_count:d.neg_count||0,total:d.news?.length||0,
    };

    const summary=d.brief||`**${d.name||entity}** — Risk: **${scores.rating}**.`;

    return res.status(200).json({
      text:summary,
      data:{
        entity,type:isCompany?"company":"individual",
        company:isCompany?{
          name:d.name||entity,logo:null,
          rc_number:d.rc_number||"—",status:d.status||"Active",type:d.type||"—",
          address:d.address||"—",incorporated:d.incorporated||"—",
          email:d.email||"—",phone:d.phone||"—",website:d.website||"—",
          state:d.state||"—",sector:d.sector||"—",
          directors:d.directors||[],shareholders:d.shareholders||[],
          related_companies:[],
          cac_found:!!(d.rc_number&&d.rc_number!=="—"),
          cac_confidence:cacPortal.found?"high":"medium",
          cac_records:[],
        }:{},
        individual:!isCompany?{
          name:d.name||entity,pep_status:scores.pep_linked,pep_detail:d.pep_detail||"",
          companies:d.companies||[],cac_found:!!(d.companies?.length),photo:null,
        }:{},
        regulatory:regData,media:newsData,network,scores,
        geo:{address:d.address||"—",lat:geo.lat,lng:geo.lng,mapbox_token:MAPBOX_TOKEN||"",source:geo.source},
        foot_traffic:null,
      }
    });
  }catch(e){
    console.error("Check Am error:",e.message,e.stack?.substring(0,300));
    return res.status(500).json({error:e.message});
  }
};
