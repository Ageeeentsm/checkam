// ══════════════════════════════════════════════════════════════════
// Check Am — /api/enforcement
// Dedicated enforcement intelligence endpoint
// Scrapes EFCC wanted list, ICPC records, CBN debarment + broader
// name search across ALL enforcement sources simultaneously
// ══════════════════════════════════════════════════════════════════

const https = require('https');

function cleanKey(r){ return String(r||'').replace(/[^\x21-\x7E]/g,'').trim(); }
let SERPAPI_KEY = '';
function refreshKeys(){ SERPAPI_KEY = cleanKey(process.env.SERPAPI_KEY); }

function get(url, hdrs={}, ms=9000){
  return new Promise(resolve=>{
    try{
      const u = new URL(url);
      const req = https.get({
        hostname:u.hostname, path:u.pathname+u.search,
        headers:{'User-Agent':'Mozilla/5.0 Chrome/120','Accept':'text/html,application/json,*/*',...hdrs}
      }, res=>{
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location)
          return get(res.headers.location,hdrs,ms).then(resolve);
        let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({s:res.statusCode,b}));
      });
      req.on('error',()=>resolve({s:0,b:''}));
      req.setTimeout(ms,()=>{req.destroy();resolve({s:0,b:''}); });
    }catch(_){resolve({s:0,b:''});}
  });
}

async function serp(q, num=10){
  if(!SERPAPI_KEY) return [];
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&engine=google&gl=ng&hl=en&num=${num}&safe=off&q=${encodeURIComponent(q)}`;
    const {s,b}=await get(url,{},12000);
    if(s!==200||!b) return [];
    const j=JSON.parse(b);
    return j.organic_results||[];
  }catch(_){return [];}
}

// ── Extract names from HTML pages ────────────────────────────────
function extractNamesFromHTML(html, pattern='') {
  const names = [];
  // Common EFCC/ICPC name patterns in HTML
  // 1. Table cells with names
  const tdPat = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while((m=tdPat.exec(html))!==null){
    const text = m[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim();
    // Nigerian name heuristic: 2-4 words, all alpha, starts with capital
    if(/^[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){1,3}$/.test(text) && text.length>4 && text.length<60){
      if(!pattern || text.toLowerCase().includes(pattern.toLowerCase())){
        names.push(text);
      }
    }
  }
  // 2. <li> items
  const liPat = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  while((m=liPat.exec(html))!==null){
    const text = m[1].replace(/<[^>]+>/g,'').trim();
    if(/^[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){1,3}$/.test(text) && text.length>4 && text.length<60){
      if(!pattern || text.toLowerCase().includes(pattern.toLowerCase())){
        names.push(text);
      }
    }
  }
  // 3. Strong/h tags
  const strongPat = /<(?:strong|h[2-5]|b)[^>]*>([\s\S]*?)<\/(?:strong|h[2-5]|b)>/gi;
  while((m=strongPat.exec(html))!==null){
    const text = m[1].replace(/<[^>]+>/g,'').trim();
    if(/^[A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){1,3}$/.test(text) && text.length>4 && text.length<60){
      if(!pattern || text.toLowerCase().includes(pattern.toLowerCase())){
        names.push(text);
      }
    }
  }
  return [...new Set(names)];
}

// ── Scrape EFCC wanted/watchlist pages ───────────────────────────
async function scrapeEFCCWanted(query) {
  const results = [];
  const q = query.toLowerCase();
  
  const pages = [
    'https://efcc.gov.ng/efcc/wanted',
    'https://efcc.gov.ng/efcc/most-wanted', 
    'https://efcc.gov.ng/category/wanted/',
    'https://efcc.gov.ng/efcc/fugitive',
  ];

  await Promise.all(pages.map(async url => {
    try{
      const {s,b} = await get(url);
      if(s!==200||!b) return;
      const html = b;
      
      // Extract individual wanted cards
      // EFCC site structure: article/div cards with name + crime
      const cardPat = /<article[^>]*>([\s\S]*?)<\/article>|<div[^>]*class="[^"]*(?:wanted|person|card|entry)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
      let m;
      while((m=cardPat.exec(html))!==null){
        const card = (m[1]||m[2]||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
        if(card.toLowerCase().includes(q)){
          // Extract name from card
          const nameM = card.match(/([A-Z][A-Za-z'-]+(?:\s+[A-Za-z'-]+){1,3})/);
          if(nameM) results.push({
            name: nameM[1],
            detail: card.substring(0,150),
            source: 'EFCC Wanted',
            severity: 'HIGH',
            url,
          });
        }
      }

      // Full page name match
      if(html.toLowerCase().includes(q)){
        const names = extractNamesFromHTML(html, q);
        names.forEach(name => {
          if(!results.find(r=>r.name.toLowerCase()===name.toLowerCase())){
            results.push({name, detail:'Found in EFCC wanted list', source:'EFCC Wanted', severity:'HIGH', url});
          }
        });
      }
    }catch(_){}
  }));

  return results;
}

// ── SerpApi broad enforcement search ─────────────────────────────
async function broadEnforcementSearch(query) {
  const results = [];
  const q = query.trim();
  const nameParts = q.split(/\s+/);
  
  // Multiple broad query strategies
  const queries = [
    // 1. Token search - any name part + enforcement agency
    `${q} (EFCC OR ICPC OR "court" OR "arraigned" OR "convicted" OR "sentenced") Nigeria`,
    // 2. EFCC site search without quotes (broader)
    `${q} site:efcc.gov.ng`,
    // 3. ICPC site search
    `${q} site:icpc.gov.ng`,
    // 4. Court records
    `${q} Nigeria court "Economic Financial" OR "money laundering" OR "fraud"`,
    // 5. News enforcement coverage
    `${q} Nigeria (EFCC arraigned OR convicted OR arrested OR "on trial") site:punchng.com OR site:vanguardngr.com OR site:premiumtimesng.com OR site:thenigerialawyer.com`,
  ];

  // Run first 3 queries in parallel
  const [r1, r2, r3, r4] = await Promise.all([
    serp(queries[0], 8),
    serp(queries[1], 6),
    serp(queries[2], 5),
    serp(queries[3], 5),
  ]);

  const allOrganic = [...r1, ...r2, ...r3, ...r4];
  const seen = new Set();

  allOrganic.forEach(r => {
    const title = (r.title||'').trim();
    const snippet = (r.snippet||'').trim();
    const link = r.link||'';
    const text = (title+' '+snippet).toLowerCase();
    
    // Check if query tokens appear in result
    const matched = nameParts.every(part => 
      part.length < 2 || text.includes(part.toLowerCase())
    );
    if(!matched) return;

    const key = link.split('?')[0];
    if(seen.has(key)) return;
    seen.add(key);

    // Determine severity and agency
    const isHigh = /convict|sentenc|guilty|guilt|jail|prison|imprison/i.test(text);
    const isMed = /arraign|charge|prosecut|trial|indict/i.test(text);
    const severity = isHigh ? 'HIGH' : isMed ? 'MEDIUM' : 'LOW';
    
    let agency = 'ENFORCEMENT';
    if(link.includes('efcc.gov.ng')||text.includes('efcc')) agency = 'EFCC';
    else if(link.includes('icpc.gov.ng')||text.includes('icpc')) agency = 'ICPC';
    else if(link.includes('cbn.gov.ng')) agency = 'CBN';
    else if(text.includes('court')||text.includes('judge')||text.includes('tribunal')) agency = 'COURT';

    results.push({
      title,
      snippet: snippet.substring(0,250),
      url: link,
      source: agency,
      severity,
      date: r.date||'',
      isEnforcement: true,
    });
  });

  return results.slice(0,15);
}

// ── Suggest names matching partial query from EFCC sources ────────
async function suggestEnforcementNames(partialQuery) {
  const q = partialQuery.trim().toLowerCase();
  const results = [];

  // Strategy 1: SerpApi — find people named like the query in enforcement context
  // Use first name only search for broad matching
  const nameParts = q.split(/\s+/).filter(p=>p.length>=2);
  if(!nameParts.length) return [];

  // Build broad query — no quotes, just tokens
  const broadQ = nameParts.join(' ') + ' Nigeria EFCC OR ICPC OR "fraud" OR "arraigned" OR "wanted"';
  
  const [efccRes, icpcRes, newsRes] = await Promise.all([
    serp(nameParts.join(' ') + ' site:efcc.gov.ng', 8),
    serp(nameParts.join(' ') + ' site:icpc.gov.ng', 6),
    serp(broadQ, 8),
  ]);

  const seen = new Set();
  const allResults = [...efccRes, ...icpcRes, ...newsRes];

  allResults.forEach(r => {
    const title = (r.title||'').trim();
    const snippet = (r.snippet||'').trim();
    const link = r.link||'';
    const text = title+' '+snippet;

    // Extract person names from titles
    // Pattern: "NAME arraigned", "NAME convicted", "EFCC arrests NAME"
    const namePatterns = [
      /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*(?:arraigned|convicted|arrested|charged|sentenced|on trial)/i,
      /EFCC\s+(?:arrests?|arraigns?|convicts?|prosecutes?|charges?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
      /ICPC\s+(?:arrests?|arraigns?|convicts?|prosecutes?|charges?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[-–:]\s*(?:EFCC|ICPC|fraud|corruption)/i,
    ];

    for(const pat of namePatterns){
      const m = text.match(pat);
      if(m && m[1]){
        const name = m[1].trim();
        // Verify it actually matches the query tokens
        const matches = nameParts.every(p => name.toLowerCase().includes(p));
        if(!matches) continue;
        const slug = name.toLowerCase();
        if(seen.has(slug)) continue;
        seen.add(slug);

        const agency = link.includes('efcc')||text.toLowerCase().includes('efcc') ? 'EFCC'
          : link.includes('icpc')||text.toLowerCase().includes('icpc') ? 'ICPC' : 'ENFORCEMENT';
        
        const isHigh = /convict|sentenc|guilty|jail/i.test(text);
        results.push({
          label: name,
          sublabel: snippet.substring(0,90),
          value: name,
          type: 'individual',
          source: agency,
          isEnforcement: true,
          severity: isHigh ? 'HIGH' : 'MEDIUM',
          url: link,
          score: isHigh ? 85 : 70,
        });
        break;
      }
    }

    // Also: if title itself is mostly a name and contains query tokens
    const cleanTitle = title.replace(/ - .*$/,'').replace(/ \| .*$/,'').trim();
    if(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$/.test(cleanTitle)){
      const matches = nameParts.every(p => cleanTitle.toLowerCase().includes(p));
      if(matches && !seen.has(cleanTitle.toLowerCase())){
        seen.add(cleanTitle.toLowerCase());
        results.push({
          label: cleanTitle,
          sublabel: snippet.substring(0,90),
          value: cleanTitle,
          type: 'individual',
          source: link.includes('efcc')?'EFCC':link.includes('icpc')?'ICPC':'ENFORCEMENT',
          isEnforcement: true,
          severity: /convict|sentenc/i.test(text) ? 'HIGH' : 'MEDIUM',
          url: link,
          score: 65,
        });
      }
    }
  });

  return results.sort((a,b)=>b.score-a.score).slice(0,6);
}

// ══════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  refreshKeys();
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();

  const q = (req.body?.query || req.query?.q || '').trim();
  const mode = req.query?.mode || 'search'; // 'search' | 'suggest' | 'watchlist'

  if(!q) return res.status(400).json({error:'No query'});

  try{
    if(mode === 'suggest'){
      const names = await suggestEnforcementNames(q);
      return res.status(200).json({suggestions: names, query: q});
    }

    if(mode === 'watchlist'){
      const names = await scrapeEFCCWanted(q);
      return res.status(200).json({results: names, query: q});
    }

    // Full enforcement search
    const [broadResults, wantedResults] = await Promise.all([
      broadEnforcementSearch(q),
      scrapeEFCCWanted(q),
    ]);

    const allResults = [...wantedResults.map(r=>({...r,isWanted:true})), ...broadResults];

    return res.status(200).json({
      found: allResults.length > 0,
      total: allResults.length,
      wanted: wantedResults.length > 0,
      results: allResults,
      query: q,
    });

  }catch(e){
    return res.status(500).json({error: e.message, results:[]});
  }
};
