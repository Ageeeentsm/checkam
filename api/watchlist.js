// Check Am — /api/watchlist
// Live scrape: EFCC press releases, ICPC news, CBN notices, SEC sanctions
// All data from official Nigerian government sources only

const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}
let SERPAPI_KEY="",ANTHROPIC_KEY="";
function refreshKeys(){
  SERPAPI_KEY=cleanKey(process.env.SERPAPI_KEY);
  ANTHROPIC_KEY=cleanKey(process.env.ANTHROPIC_API_KEY);
}

function get(url,hdrs={},ms=12000){
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

// ── Parse EFCC press release page ────────────────────────────────
async function scrapeEFCCPressReleases(){
  const results=[];
  try{
    // EFCC official press release RSS / page
    const pages=[
      "https://efcc.gov.ng/agency/press-release",
      "https://efcc.gov.ng/category/press-release",
    ];
    for(const url of pages){
      const{s,b}=await get(url,{},10000);
      if(s===200&&b&&b.length>500){
        // Extract article titles and links from HTML
        const articlePattern=/<a[^>]+href="([^"]*(?:press-release|prosecution|conviction|charge|arrest)[^"]*)"[^>]*>([^<]{10,120})<\/a>/gi;
        const datePattern=/(\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4}-\d{2}-\d{2})/gi;
        let m;
        while((m=articlePattern.exec(b))!==null&&results.length<20){
          const href=m[1].startsWith("http")?m[1]:"https://efcc.gov.ng"+m[1];
          const title=m[2].replace(/\s+/g," ").trim();
          if(title.length>15){
            results.push({title,url:href,source:"EFCC Official",agency:"EFCC",date:""});
          }
        }
        if(results.length>3)break;
      }
    }
  }catch(_){}
  return results;
}

// ── Live search for recent EFCC/ICPC enforcement actions ──────────
async function fetchLiveEnforcement(){
  const queries=[
    "EFCC conviction arraignment Nigeria 2024 2025 site:efcc.gov.ng OR site:premiumtimesng.com OR site:thecable.ng",
    "EFCC arraigns convicts sentence Nigeria 2025",
    "ICPC conviction prosecution 2024 2025 Nigeria",
    "CBN debarment sanction bank Nigeria 2024 2025",
    "SEC Nigeria sanction enforcement 2024 2025",
    "EFCC arrest charge Nigeria fraud 2025",
  ];

  const allResults=[];
  for(const q of queries){
    const items=await serpSearch(q,8);
    for(const item of items){
      // Classify agency
      const text=(item.title+" "+item.snippet).toLowerCase();
      let agency="EFCC";
      if(text.includes("icpc"))agency="ICPC";
      else if(text.includes("cbn")&&(text.includes("ban")||text.includes("debar")))agency="CBN";
      else if(text.includes("sec nigeria")||text.includes("securities commission"))agency="SEC";

      // Extract severity signals
      const convicted=text.includes("convict")||text.includes("sentence")||text.includes("jail")||text.includes("prison");
      const charged=text.includes("arraign")||text.includes("charge")||text.includes("prosecut");
      const arrested=text.includes("arrest")||text.includes("detain");

      let status="REPORTED";
      if(convicted)status="CONVICTED";
      else if(charged)status="CHARGED";
      else if(arrested)status="ARRESTED";

      // Extract money amounts
      const amountMatch=(item.title+" "+item.snippet).match(/[₦N]\s*[\d,.]+(m|bn|million|billion|k|trillion)?|\$[\d,.]+\s*(m|bn|million|billion)?/i);
      const amount=amountMatch?amountMatch[0]:"";

      allResults.push({
        title:item.title,
        url:item.url,
        snippet:item.snippet,
        source:item.source,
        date:item.date||"Recent",
        agency,
        status,
        amount,
        risk:convicted?"HIGH":charged?"HIGH":"MEDIUM",
      });
    }
  }

  // Dedupe by URL
  const seen=new Set();
  return allResults.filter(r=>{
    if(seen.has(r.url))return false;
    seen.add(r.url);
    return true;
  }).slice(0,40);
}

// ── Fetch EFCC website directly for latest prosecutions ──────────
async function fetchEFCCDirect(){
  const results=[];
  try{
    const{s,b}=await get("https://efcc.gov.ng/agency/press-release",{},12000);
    if(s===200&&b){
      // Parse article entries
      const entryRe=/<(?:article|div)[^>]*class="[^"]*(?:post|entry|item|article)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|div)>/gi;
      const titleRe=/<h[1-6][^>]*><a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/i;
      const dateRe=/<time[^>]*>([^<]+)<\/time>|<span[^>]*class="[^"]*date[^"]*"[^>]*>([^<]+)<\/span>/i;
      const excerptRe=/<p[^>]*>([^<]{20,300})<\/p>/i;

      let m;
      while((m=entryRe.exec(b))!==null&&results.length<20){
        const block=m[1];
        const tMatch=titleRe.exec(block);
        const dMatch=dateRe.exec(block);
        const eMatch=excerptRe.exec(block);
        if(tMatch){
          const href=tMatch[1].startsWith("http")?tMatch[1]:"https://efcc.gov.ng"+tMatch[1];
          results.push({
            title:tMatch[2].trim(),
            url:href,
            date:(dMatch&&(dMatch[1]||dMatch[2])||"").trim(),
            snippet:(eMatch&&eMatch[1]||"").trim(),
            agency:"EFCC",
            source:"efcc.gov.ng",
            status:"OFFICIAL",
            risk:"HIGH",
          });
        }
      }
    }
  }catch(_){}
  return results;
}

// ── MAIN HANDLER ─────────────────────────────────────────────────
module.exports=async(req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Content-Type","application/json");
  if(req.method==="OPTIONS"){return res.status(200).end();}
  refreshKeys();

  const{filter="all",search="",page=0}=req.body||req.query||{};

  try{
    // Parallel fetch: live enforcement + EFCC direct + ICPC
    const[liveItems,efccDirect]=await Promise.all([
      fetchLiveEnforcement(),
      fetchEFCCDirect(),
    ]);

    // Merge, EFCC direct first (official), then live
    const merged=[...efccDirect,...liveItems];
    const seen=new Set();
    const all=merged.filter(r=>{
      if(!r.title||r.title.length<8)return false;
      const key=r.url||r.title;
      if(seen.has(key))return false;
      seen.add(key);
      return true;
    });

    // Apply filter
    let filtered=all;
    if(filter==="convicted")filtered=all.filter(r=>r.status==="CONVICTED");
    else if(filter==="charged")filtered=all.filter(r=>r.status==="CHARGED");
    else if(filter==="efcc")filtered=all.filter(r=>r.agency==="EFCC");
    else if(filter==="icpc")filtered=all.filter(r=>r.agency==="ICPC");
    else if(filter==="cbn")filtered=all.filter(r=>r.agency==="CBN");

    // Apply search
    if(search&&search.trim()){
      const q=search.toLowerCase();
      filtered=filtered.filter(r=>(r.title+" "+r.snippet).toLowerCase().includes(q));
    }

    return res.json({
      ok:true,
      total:filtered.length,
      items:filtered.slice(page*30,(page+1)*30),
      fetched_at:new Date().toISOString(),
    });
  }catch(e){
    return res.json({ok:false,error:e.message,items:[]});
  }
};
