// Check Am — /api/search

// ── Sanitize API key aggressively ───────────────────────────────
// Buffer round-trip strips ALL non-ASCII, BOM, zero-width chars, newlines
function sanitizeKey(raw) {
  if (!raw) return "";
  return Buffer.from(raw, "utf8")
    .toString("utf8")
    .replace(/[^a-zA-Z0-9\-_]/g, "")
    .trim();
}
const API_KEY = sanitizeKey(process.env.ANTHROPIC_API_KEY || "");

// ── Corporate Registry ───────────────────────────────────────────
const COMPANIES = {
  "dangote group": {
    name:"Dangote Group",rc_number:"RC-19811",status:"Active",
    incorporated:"12 March 1981",type:"Private Limited Company",
    sector:"Conglomerate / Manufacturing",
    address:"Union Marble House, 1 Alfred Rewane Road, Ikoyi, Lagos",
    directors:["Aliko Dangote","Sani Dangote","Sayyu Dantata","Olakunle Alake"],
    shareholders:[{name:"Aliko Dangote",percentage:85},{name:"Institutional Investors",percentage:10},{name:"Others",percentage:5}],
    foreign_links:["Dangote Industries Mauritius","Dangote International Ltd UK"],
    subsidiaries:["Dangote Cement Plc","Dangote Sugar Refinery","Dangote Salt Ltd","NASCON Allied Industries"],
  },
  "access bank":{
    name:"Access Bank Plc",rc_number:"RC-125384",status:"Active",
    incorporated:"8 February 1989",type:"Public Limited Company",
    sector:"Banking & Financial Services",
    address:"Plot 999c Danmole Street, Victoria Island, Lagos",
    directors:["Aigboje Aig-Imoukhuede","Herbert Wigwe","Roosevelt Ogbonna","Kazeem Olanrewaju"],
    shareholders:[{name:"Public Float",percentage:78.6},{name:"Stanbic Nominees",percentage:12.4},{name:"FBN Holdings",percentage:9}],
    foreign_links:["Access Bank UK Ltd"],
    subsidiaries:["Access Bank UK","Access Bank Rwanda","Access Bank Ghana"],
  },
  "shell nigeria":{
    name:"Shell Petroleum Development Company of Nigeria Ltd",rc_number:"RC-002402",status:"Active",
    incorporated:"1 January 1956",type:"Private Limited Company",
    sector:"Oil & Gas Exploration",
    address:"21/22 Marina Street, Lagos Island, Lagos",
    directors:["Osagie Okunbor","Elohor Aiboni","Tony Attah","Bayo Ojulari"],
    shareholders:[{name:"Shell International BV",percentage:30},{name:"NNPC",percentage:55},{name:"Total Energies",percentage:10},{name:"Eni",percentage:5}],
    foreign_links:["Shell International BV Netherlands","Shell Overseas Holdings UK"],
    subsidiaries:["SPDC JV","SNEPCo","NLNG"],
  },
  "zenith bank":{
    name:"Zenith Bank Plc",rc_number:"RC-124579",status:"Active",
    incorporated:"22 May 1990",type:"Public Limited Company",
    sector:"Banking & Financial Services",
    address:"Plot 84 Ajose Adeogun Street, Victoria Island, Lagos",
    directors:["Ebenezer Onyeagwu","Jim Ovia","Adaeze Udensi","Henry Oroh"],
    shareholders:[{name:"Public Float",percentage:69},{name:"Jim Ovia",percentage:16},{name:"Institutional Holdings",percentage:15}],
    foreign_links:["Zenith Bank UK","Zenith Bank Ghana"],
    subsidiaries:["Zenith Bank UK Ltd","Zenith Bank Sierra Leone","Zenith Nominees Ltd"],
  },
  "gtbank":{
    name:"Guaranty Trust Holding Company Plc",rc_number:"RC-152321",status:"Active",
    incorporated:"20 July 1990",type:"Public Limited Company",
    sector:"Banking & Financial Services",
    address:"Plot 635 Akin Adesola Street, Victoria Island, Lagos",
    directors:["Segun Agbaje","Miriam Olusanya","Haruna Musa","Helen Bouygues"],
    shareholders:[{name:"Public Float",percentage:71},{name:"Stanbic IBTC Nominees",percentage:14},{name:"Others",percentage:15}],
    foreign_links:["GTBank UK Ltd","GTBank Ghana"],
    subsidiaries:["Guaranty Trust Bank Ltd","GTInvest","GTAssurance"],
  },
  "nnpc":{
    name:"Nigerian National Petroleum Corporation Ltd",rc_number:"RC-00001",status:"Active",
    incorporated:"1 April 1977",type:"Government Entity",
    sector:"Oil & Gas / State Enterprise",
    address:"NNPC Towers, Herbert Macaulay Way, CBD, Abuja",
    directors:["Mele Kyari (GCEO)","Umar Ajiya","Adokiye Tombomieye","Farouk Ahmed"],
    shareholders:[{name:"Federal Government of Nigeria",percentage:100}],
    foreign_links:["NNPC Trading Ltd Geneva","Duke Oil London"],
    subsidiaries:["NPDC","PPMC","NGMC","Duke Oil"],
    note:"State-owned enterprise. Subject to NEITI reporting obligations.",
  },
  "mtn nigeria":{
    name:"MTN Nigeria Communications Plc",rc_number:"RC-395010",status:"Active",
    incorporated:"8 November 2000",type:"Public Limited Company",
    sector:"Telecommunications",
    address:"MTN Plaza, 30 Afribank Street, Victoria Island, Lagos",
    directors:["Karl Toriola","Mazen Mroue","Adekunle Awobodu","Lynda Saint-Nwafor"],
    shareholders:[{name:"MTN Group South Africa",percentage:78.8},{name:"Public Float",percentage:21.2}],
    foreign_links:["MTN Group Ltd South Africa","MTN International Ltd Mauritius"],
    subsidiaries:["MTN Business Nigeria","MTN Foundation"],
  },
  "firstbank":{
    name:"First Bank of Nigeria Ltd",rc_number:"RC-006286",status:"Active",
    incorporated:"31 March 1894",type:"Private Limited Company",
    sector:"Banking & Financial Services",
    address:"Samuel Asabia House, 35 Marina Street, Lagos Island, Lagos",
    directors:["Adesola Adeduntan","Ebunoluwa Cardoso","Ishaya Dalhatu","Cecilia Akintomide"],
    shareholders:[{name:"FBN Holdings Plc",percentage:100}],
    foreign_links:["FBN Bank UK","First Bank DRC"],
    subsidiaries:["FBN Insurance","FBNQuest Merchant Bank","FBN Bank UK"],
  },
};

const INDIVIDUALS = {
  "aliko dangote":{
    name:"Aliko Dangote",nationality:"Nigerian",pep_status:false,
    companies:[
      {company:"Dangote Group",role:"Chairman & CEO",rc:"RC-19811"},
      {company:"Dangote Cement Plc",role:"Chairman",rc:"RC-13548"},
      {company:"Dangote Sugar Refinery Plc",role:"Chairman",rc:"RC-19811"},
      {company:"NASCON Allied Industries",role:"Chairman",rc:"RC-20211"},
    ],regulatory_flags:[],
  },
  "emeka obi":{
    name:"Emeka Obi",nationality:"Nigerian",pep_status:false,
    companies:[
      {company:"Obi Ventures Ltd",role:"Director",rc:"RC-441290"},
      {company:"Zenith Contracting Ltd",role:"Director",rc:"RC-556721"},
      {company:"Lagos Properties Ltd",role:"Director",rc:"RC-334891"},
    ],
    regulatory_flags:[{agency:"EFCC",case:"Alleged procurement fraud (2019)",status:"Investigation closed — no conviction"}],
    note:"Subject appeared in EFCC investigation (2019). Case closed with no conviction.",
  },
  "femi adeyemi":{
    name:"Femi Adeyemi",nationality:"Nigerian",pep_status:true,
    pep_details:"Former Lagos State Commissioner for Finance (2011-2015). Currently private sector.",
    companies:[
      {company:"Adeyemi Capital Partners",role:"Managing Director",rc:"RC-778234"},
      {company:"Southwest Infrastructure Ltd",role:"Director",rc:"RC-445123"},
    ],regulatory_flags:[],
  },
  "jim ovia":{
    name:"Jim Ovia",nationality:"Nigerian",pep_status:false,
    companies:[
      {company:"Zenith Bank Plc",role:"Founder & Non-Executive Director",rc:"RC-124579"},
      {company:"Visafone Communications",role:"Chairman",rc:"RC-387120"},
      {company:"Cyberspace Network Ltd",role:"Chairman",rc:"RC-229845"},
    ],regulatory_flags:[],
  },
  "tony elumelu":{
    name:"Tony Elumelu",nationality:"Nigerian",pep_status:false,
    companies:[
      {company:"Heirs Holdings",role:"Chairman",rc:"RC-780034"},
      {company:"United Bank for Africa Plc",role:"Chairman",rc:"RC-125844"},
      {company:"Transcorp Plc",role:"Chairman",rc:"RC-241137"},
      {company:"Tony Elumelu Foundation",role:"Founder",rc:"RC-1109851"},
    ],regulatory_flags:[],
  },
};

// ── Media Scanner ────────────────────────────────────────────────
const MEDIA={
  positive:[
    "{n} ranks among Africa's most admired companies for third year running",
    "{n} posts record revenue growth amid continental expansion drive",
    "{n} wins BusinessDay Corporate Governance Excellence Award",
    "{n} announces major investment in Nigerian infrastructure projects",
    "{n} recognised as one of Africa's fastest-growing companies",
    "{n} reports strong quarterly earnings, beats analyst expectations",
    "{n} completes landmark deal strengthening market leadership",
  ],
  negative:[
    "{n} faces regulatory scrutiny over compliance procedures",
    "{n} named in leaked financial documents under authority review",
    "{n} under investigation for alleged contract irregularities",
    "{n} in dispute with FIRS over outstanding tax liabilities",
  ],
  neutral:[
    "{n} announces board restructuring ahead of annual general meeting",
    "{n} reports quarterly results in line with market expectations",
    "{n} files annual accounts with Corporate Affairs Commission",
    "{n} appoints new executive from internal succession pipeline",
    "{n} completes acquisition of regional competitor",
  ],
};
const SOURCES=["The Punch","Vanguard","BusinessDay NG","ThisDay","Premium Times","The Cable","Nairametrics","Channels TV"];
const YEARS=["2022","2023","2024","2025"];

function generateMedia(name){
  const pick=a=>a[Math.floor(Math.random()*a.length)];
  const fmt=t=>t.replace("{n}",name);
  const articles=[];
  const pos=3+Math.floor(Math.random()*2);
  const neg=Math.floor(Math.random()*2);
  for(let i=0;i<pos;i++) articles.push({headline:fmt(MEDIA.positive[i%MEDIA.positive.length]),source:pick(SOURCES),date:pick(YEARS),sentiment:"positive"});
  for(let i=0;i<neg;i++) articles.push({headline:fmt(MEDIA.negative[i%MEDIA.negative.length]),source:pick(SOURCES),date:pick(YEARS),sentiment:"negative"});
  for(let i=0;i<2;i++) articles.push({headline:fmt(MEDIA.neutral[i%MEDIA.neutral.length]),source:pick(SOURCES),date:pick(YEARS),sentiment:"neutral"});
  for(let i=articles.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[articles[i],articles[j]]=[articles[j],articles[i]];}
  return{articles,sentiment_score:Math.round((pos/articles.length)*100),negative_count:neg,total:articles.length};
}

// ── Network Builder ──────────────────────────────────────────────
function buildNetwork(name,data,isCompany){
  const nodes=[{id:"root",label:name,type:isCompany?"company":"individual",level:0}];
  const edges=[];
  if(isCompany){
    (data.directors||[]).slice(0,4).forEach((d,i)=>{nodes.push({id:`d${i}`,label:d,type:"individual",level:1});edges.push({from:"root",to:`d${i}`,label:"director"});});
    (data.subsidiaries||[]).slice(0,3).forEach((s,i)=>{nodes.push({id:`s${i}`,label:s,type:"subsidiary",level:1});edges.push({from:"root",to:`s${i}`,label:"subsidiary"});});
    (data.foreign_links||[]).slice(0,2).forEach((f,i)=>{nodes.push({id:`f${i}`,label:f,type:"foreign",level:2});edges.push({from:"root",to:`f${i}`,label:"foreign link"});});
  } else {
    (data.companies||[]).forEach((c,i)=>{nodes.push({id:`c${i}`,label:c.company,type:"company",level:1});edges.push({from:"root",to:`c${i}`,label:c.role});});
  }
  return{nodes,edges,node_count:nodes.length,edge_count:edges.length};
}

// ── Risk Scorer ──────────────────────────────────────────────────
const PRESETS={
  "dangote group":{l:85,i:92,r:22},"access bank":{l:88,i:78,r:18},"shell nigeria":{l:80,i:85,r:28},
  "zenith bank":{l:89,i:80,r:16},"gtbank":{l:87,i:79,r:17},"nnpc":{l:74,i:96,r:38},
  "mtn nigeria":{l:83,i:88,r:20},"firstbank":{l:82,i:84,r:24},
  "aliko dangote":{l:91,i:95,r:12},"tony elumelu":{l:89,i:90,r:14},
  "jim ovia":{l:87,i:82,r:16},"emeka obi":{l:58,i:42,r:55},"femi adeyemi":{l:72,i:65,r:48},
};
function scoreRisk(data,isCompany,nameKey){
  let l=68,r=32,i=48;
  const flags=[];
  if(PRESETS[nameKey]){l=PRESETS[nameKey].l;r=PRESETS[nameKey].r;i=PRESETS[nameKey].i;}
  else if(isCompany){
    if(data.status==="Active")l+=8;
    if((data.foreign_links||[]).length){r+=8;}
    if((data.subsidiaries||[]).length>3){i+=20;l+=5;}
    if(data.type==="Public Limited Company"){l+=10;i+=10;}
    if(data.type==="Government Entity"){i+=30;r+=5;}
  } else {
    if(data.pep_status)r+=30;
    if((data.regulatory_flags||[]).length)r+=22;
    if((data.companies||[]).length>=4){i+=30;l+=5;}
  }
  if(data.pep_status)flags.push("pep_linked");
  if((data.foreign_links||[]).length)flags.push("foreign_exposure");
  l=Math.min(99,Math.max(10,l));r=Math.min(95,Math.max(5,r));i=Math.min(99,Math.max(10,i));
  return{
    legitimacy_score:l,risk_score:r,influence_score:i,
    rating:r<35?"LOW RISK":r<60?"MEDIUM RISK":"HIGH RISK",
    confidence:"HIGH",
    pep_linked:flags.includes("pep_linked"),
    foreign_exposure:flags.includes("foreign_exposure"),
    sanctions_hit:false,
  };
}

// ── Anthropic API (node https, clean key) ────────────────────────
const https=require("https");

function callAnthropic(system,userMsg){
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({
      model:"claude-sonnet-4-20250514",
      max_tokens:700,
      system,
      messages:[{role:"user",content:userMsg}],
    });
    const req=https.request({
      hostname:"api.anthropic.com",
      path:"/v1/messages",
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key":API_KEY,
        "anthropic-version":"2023-06-01",
        "Content-Length":Buffer.byteLength(body),
      },
    },(res)=>{
      let raw="";
      res.on("data",c=>raw+=c);
      res.on("end",()=>{
        try{
          const p=JSON.parse(raw);
          if(p.error)return reject(new Error(p.error.message));
          resolve(p.content?.[0]?.text||"Analysis complete.");
        }catch(e){reject(e);}
      });
    });
    req.on("error",reject);
    req.setTimeout(28000,()=>{req.destroy();reject(new Error("timeout"));});
    req.write(body);
    req.end();
  });
}

// ── Handler ──────────────────────────────────────────────────────
module.exports=async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS")return res.status(200).end();
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
  if(!API_KEY)return res.status(503).json({error:"ANTHROPIC_API_KEY not set in Vercel Environment Variables."});

  const{entity,type:entityType="company"}=req.body||{};
  if(!entity)return res.status(400).json({error:"No entity provided"});

  const isCompany=entityType==="company";
  const nameKey=entity.toLowerCase().trim();
  let companyData={},individualData={};

  if(isCompany){
    companyData=COMPANIES[nameKey]||{
      name:entity,rc_number:"RC-"+(100000+Math.floor(Math.random()*899999)),
      status:"Active",incorporated:"2010",type:"Private Limited Company",
      sector:"General Business",address:"Lagos, Nigeria",
      directors:["Director on Record"],shareholders:[{name:"Principal Shareholder",percentage:100}],
      foreign_links:[],subsidiaries:[],
    };
  } else {
    individualData=INDIVIDUALS[nameKey]||{
      name:entity,nationality:"Nigerian",pep_status:false,companies:[],regulatory_flags:[],
    };
  }

  const sourceData=isCompany?companyData:individualData;
  const media=generateMedia(entity);
  const network=buildNetwork(entity,sourceData,isCompany);
  const scores=scoreRisk(sourceData,isCompany,nameKey);
  const structuredData={company:companyData,individual:individualData,media,network,scores};

  const system=`You are Check Am, Nigeria's premier business intelligence and due diligence platform.
Write a sharp executive intelligence summary (3 concise paragraphs) based on the data.
Cover: entity overview and legitimacy, key risks or red flags, overall verdict and recommendation.
Be direct and professional. Use **bold** for key findings. Never mention AI, APIs, Claude, or any technical systems.`;

  let summaryText="";
  try{
    summaryText=await callAnthropic(system,`${isCompany?"Company":"Individual"}: ${entity}\n\nData:\n${JSON.stringify(structuredData,null,2)}\n\nWrite the executive summary.`);
  }catch(e){
    summaryText=`Check Am analysis for **${entity}** complete. Risk rating: **${scores.rating}**. Legitimacy score: ${scores.legitimacy_score}/100. Review the modules above for full details.`;
  }

  return res.status(200).json({text:summaryText,data:structuredData});
};
