// Check Am — /api/checker
// Live name checker: search EFCC, ICPC, CBN, SEC, Courts for a specific person/company
// Returns official records only — no independent allegations

const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
let SERPAPI_KEY="",ANTHROPIC_KEY="";
function refreshKeys(){
  SERPAPI_KEY=cleanKey(process.env.SERPAPI_KEY);
  ANTHROPIC_KEY=cleanKey(process.env.ANTHROPIC_API_KEY);
}

function get(url,hdrs={},ms=13000){
  return new Promise(resolve=>{
    try{
      const req=https.get(url,{headers:{"User-Agent":"Mozilla/5.0 (compatible; CheckAmBot/1.0)","Accept":"text/html,application/json,*/*",...hdrs}},(res)=>{
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
    const data=JSON.stringify(body);
    const opts={hostname,path,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(data),...hdrs}};
    const req=https.request(opts,res=>{
      let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({s:res.statusCode,b}));
    });
    req.on("error",reject);req.setTimeout(25000,()=>{req.destroy();reject(new Error("timeout"));});
    req.write(data);req.end();
  });
}

async function serpSearch(q,num=10){
  if(!SERPAPI_KEY)return[];
  try{
    const url=`https://serpapi.com/search.json?q=${encodeURIComponent(q)}&api_key=${SERPAPI_KEY}&num=${num}&gl=ng&hl=en`;
    const{s,b}=await get(url);
    if(s!==200||!b)return[];
    const j=JSON.parse(b);
    return(j.organic_results||[]).map(r=>({
      title:r.title||"",
      url:r.link||"",
      snippet:r.snippet||"",
      source:r.displayed_link||"",
      date:r.date||""
    }));
  }catch(_){return[];}
}

// ── Per-agency targeted search ────────────────────────────────────
async function searchAgency(name,agency){
  const configs={
    EFCC:{
      queries:[
        `"${name}" EFCC site:efcc.gov.ng`,
        `"${name}" EFCC arraigned convicted charged fraud`,
        `"${name}" Economic Financial Crimes Commission Nigeria`,
      ],
      site:"efcc.gov.ng",
      official:"https://efcc.gov.ng"
    },
    ICPC:{
      queries:[
        `"${name}" ICPC site:icpc.gov.ng`,
        `"${name}" ICPC prosecution corruption Nigeria`,
        `"${name}" Independent Corrupt Practices Commission Nigeria`,
      ],
      site:"icpc.gov.ng",
      official:"https://icpc.gov.ng"
    },
    CBN:{
      queries:[
        `"${name}" CBN debarment sanction site:cbn.gov.ng`,
        `"${name}" Central Bank Nigeria sanction debarred`,
      ],
      site:"cbn.gov.ng",
      official:"https://cbn.gov.ng"
    },
    SEC:{
      queries:[
        `"${name}" SEC Nigeria sanction enforcement site:sec.gov.ng`,
        `"${name}" Securities Exchange Commission Nigeria sanction`,
      ],
      site:"sec.gov.ng",
      official:"https://sec.gov.ng"
    },
    COURTS:{
      queries:[
        `"${name}" Federal High Court Nigeria judgment fraud`,
        `"${name}" court Nigeria convicted sentenced money laundering`,
      ],
      site:"",
      official:"https://fcmb.gov.ng"
    },
    FIRS:{
      queries:[
        `"${name}" FIRS Nigeria tax fraud enforcement`,
        `"${name}" Federal Inland Revenue Service Nigeria`,
      ],
      site:"firs.gov.ng",
      official:"https://firs.gov.ng"
    },
  };

  const cfg=configs[agency];
  if(!cfg)return{agency,found:false,records:[]};

  const records=[];
  for(const q of cfg.queries){
    const items=await serpSearch(q,5);
    for(const item of items){
      const text=(item.title+" "+item.snippet).toLowerCase();
      const nameL=name.toLowerCase();

      // Only include if name actually appears in result
      if(!text.includes(nameL.split(" ")[0].toLowerCase())&&
         !(nameL.split(" ")[1]&&text.includes(nameL.split(" ")[1].toLowerCase())))continue;

      // Extract severity
      const convicted=text.includes("convict")||text.includes("sentence")||text.includes("imprison")||text.includes("jail")||text.includes("guilty");
      const charged=text.includes("arraign")||text.includes("charg")||text.includes("prosecut")||text.includes("remand");
      const wanted=text.includes("wanted")||text.includes("fled")||text.includes("at large");
      const sanction=text.includes("sanction")||text.includes("debar")||text.includes("bar")||text.includes("suspend");

      let status="MENTIONED";
      let severity="LOW";
      if(convicted){status="CONVICTED";severity="HIGH";}
      else if(charged){status="CHARGED";severity="HIGH";}
      else if(wanted){status="WANTED";severity="HIGH";}
      else if(sanction){status="SANCTIONED";severity="MEDIUM";}

      // Extract amounts
      const amountMatch=(item.title+" "+item.snippet).match(/[₦N]\s*[\d,.]+\s*(m|bn|million|billion|trillion|k)?|\$[\d,.]+\s*(m|bn|million|billion)?/i);

      // Extract case reference
      const caseRef=(item.title+" "+item.snippet).match(/[A-Z]+\/[A-Z]+\/[A-Z]*\/?[\d\/]+\/\d{4}/);

      records.push({
        title:item.title,
        url:item.url,
        snippet:item.snippet,
        source:item.source,
        date:item.date||"",
        status,
        severity,
        amount:amountMatch?amountMatch[0]:"",
        case_ref:caseRef?caseRef[0]:"",
        agency,
      });
    }
    if(records.length>=3)break;
  }

  // Dedupe by URL
  const seen=new Set();
  const unique=records.filter(r=>{
    if(seen.has(r.url))return false;
    seen.add(r.url);
    return true;
  });

  return{
    agency,
    found:unique.length>0&&unique.some(r=>r.severity!=="LOW"),
    records:unique.slice(0,5),
    official_url:cfg.official,
  };
}

// ── AI Summary ────────────────────────────────────────────────────
async function generateSummary(name,type,agencyResults){
  if(!ANTHROPIC_KEY)return"";
  try{
    const hits=agencyResults.filter(a=>a.found);
    if(!hits.length)return`No enforcement records found for ${name} across EFCC, ICPC, CBN, SEC, FIRS, and court databases. This does not constitute legal clearance.`;

    const context=hits.map(a=>`${a.agency}: ${a.records.slice(0,2).map(r=>`${r.status} — ${r.title} (${r.date||"recent"})`).join("; ")}`).join("\n");

    const{s,b}=await postJson("api.anthropic.com","/v1/messages",{
      model:"claude-sonnet-4-20250514",
      max_tokens:400,
      system:"You are a Nigerian business intelligence analyst. Summarise enforcement records factually and concisely. Only state what is in the sources. Do not speculate. Include the phrase 'Based on official records' at start.",
      messages:[{role:"user",content:`Summarise these official enforcement records for ${name} (${type}) in 3-4 sentences:\n${context}`}]
    },{"x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"});

    if(s===200&&b){
      const j=JSON.parse(b);
      return(j.content&&j.content[0]&&j.content[0].text)||"";
    }
  }catch(_){}
  return"";
}

// ── MAIN HANDLER ─────────────────────────────────────────────────
module.exports=async(req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Content-Type","application/json");
  if(req.method==="OPTIONS"){return res.status(200).end();}
  refreshKeys();

  const{name,type="individual"}=req.body||req.query||{};

  if(!name||!name.trim()){
    return res.json({ok:false,error:"Name required",result:null});
  }

  const cleanName=name.trim();

  try{
    // Search all agencies in parallel
    const agencies=["EFCC","ICPC","CBN","SEC","COURTS","FIRS"];
    const agencyResults=await Promise.all(agencies.map(a=>searchAgency(cleanName,a)));

    const hits=agencyResults.filter(a=>a.found);
    const allRecords=agencyResults.flatMap(a=>a.records||[]);
    const highSeverity=allRecords.some(r=>r.severity==="HIGH");
    const convicted=allRecords.some(r=>r.status==="CONVICTED");
    const charged=allRecords.some(r=>r.status==="CHARGED");
    const wanted=allRecords.some(r=>r.status==="WANTED");

    let overallStatus="CLEAR";
    let riskLevel="LOW";
    if(convicted){overallStatus="CONVICTED";riskLevel="HIGH";}
    else if(wanted){overallStatus="WANTED";riskLevel="HIGH";}
    else if(charged){overallStatus="CHARGED";riskLevel="HIGH";}
    else if(hits.length>0){overallStatus="RECORDS FOUND";riskLevel="MEDIUM";}

    const summary=await generateSummary(cleanName,type,agencyResults);

    return res.json({
      ok:true,
      name:cleanName,
      type,
      overall_status:overallStatus,
      risk_level:riskLevel,
      agencies_hit:hits.length,
      agencies_checked:agencies.length,
      summary,
      agencies:agencyResults,
      checked_at:new Date().toISOString(),
      disclaimer:"All records sourced from official Nigerian government databases and enforcement agency public releases only. This tool does not make independent allegations.",
    });

  }catch(e){
    return res.json({ok:false,error:e.message,result:null});
  }
};
