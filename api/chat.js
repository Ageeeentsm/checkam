// Check Am — /api/chat v3.0
// Detects entity mentions → runs full live intelligence scan → responds with real data in due diligence chat style

const https = require("https");

function cleanKey(r) { return String(r||"").replace(/[^\x21-\x7E]/g,"").trim(); }

let ANTHROPIC_KEY="", SERPAPI_KEY="";
function refreshKeys(){
  ANTHROPIC_KEY = cleanKey(process.env.ANTHROPIC_API_KEY);
  SERPAPI_KEY   = cleanKey(process.env.SERPAPI_KEY);
}

// ─── HTTP GET (never throws) ──────────────────────────────────────
function get(url, hdrs={}, ms=11000) {
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
        let b=""; res.on("data",c=>b+=c); res.on("end",()=>resolve({s:res.statusCode,b}));
      });
      req.on("error",()=>resolve({s:0,b:""}));
      req.setTimeout(ms,()=>{req.destroy();resolve({s:0,b:""});});
    } catch(_){ resolve({s:0,b:""}); }
  });
}

function postJson(hostname,path,bodyObj,hdrs={}) {
  return new Promise((resolve,reject)=>{
    const buf=Buffer.from(JSON.stringify(bodyObj));
    const req=https.request({hostname,path,method:"POST",headers:{"Content-Type":"application/json","Content-Length":buf.length,...hdrs}},(res)=>{
      let raw=""; res.on("data",c=>raw+=c); res.on("end",()=>{try{resolve(JSON.parse(raw));}catch{resolve({});}});
    });
    req.on("error",reject);
    req.setTimeout(30000,()=>{req.destroy();reject(new Error("timeout"));});
    req.write(buf);req.end();
  });
}

// ─── SerpApi search (replaces Google CSE) ─────────────────────────
async function gSearch(query, num=8) {
  if(!SERPAPI_KEY) return [];
  try{
    const url=`https://serpapi.com/search.json?api_key=${SERPAPI_KEY}&q=${encodeURIComponent(query)}&num=${num}&engine=google&gl=ng&hl=en&safe=off`;
    const {s,b}=await get(url,{},13000);
    if(s!==200||!b) return [];
    const j=JSON.parse(b);
    const results=(j.organic_results||[]).slice(0,num).map(r=>({
      title:r.title||"",snippet:r.snippet||"",link:r.link||"",
      displayLink:(r.displayed_link||r.link||"").replace(/^https?:\/\//,"").split("/")[0]
    }));
    // Prepend knowledge graph as rich first result
    const kg=j.knowledge_graph;
    if(kg&&kg.title){
      const kgSnip=[kg.description,kg.address,kg.phone,kg.website,(kg.people_also_search_for||[]).map(p=>p.name||p).join(", ")].filter(Boolean).join(" · ");
      results.unshift({title:kg.title+" [Knowledge Graph]",snippet:kgSnip,link:kg.website||"",displayLink:"knowledge-graph"});
    }
    const ab=j.answer_box;
    if(ab&&ab.answer) results.unshift({title:"Answer: "+query,snippet:ab.answer||ab.snippet||"",link:"",displayLink:"answer-box"});
    return results;
  }catch(_){}
  return [];
}

// ─── Quick intelligence pull for chat ─────────────────────────────
// Lighter than the full /api/search — runs key sources fast for conversational response
async function quickIntel(entity, type) {
  const isCompany = type === "company";
  const enc = encodeURIComponent(entity.trim());

  const NG_NEWS = "punchng.com OR site:vanguardngr.com OR site:premiumtimesng.com OR site:thecable.ng OR site:businessday.ng OR site:thisdaylive.com OR site:guardian.ng OR site:dailytrust.com OR site:channelstv.com OR site:nairametrics.com";
  const NG_RESEARCH = "stears.co OR site:proshareng.com OR site:sbmintel.com OR site:dataphyte.com";

  const [cac, efcc, icpc, cbn, courts, news, research] = await Promise.all([
    // CAC — via SerpApi (direct CAC DNS blocked on Vercel)
    gSearch(isCompany
      ?`"${entity}" site:search.cac.gov.ng OR "${entity}" CAC Nigeria RC number directors incorporated`
      :`"${entity}" site:search.cac.gov.ng OR "${entity}" Nigeria director company CAC RC`
    , 6).then(items=>{
      if(!items.length) return {found:false};
      const allText=items.map(i=>`${i.title} ${i.snippet}`).join(" ");
      const rcM=allText.match(/RC[\s:\-]?(\d{4,8})/i);
      const addrM=allText.match(/(?:address|registered|located)[:\s]+([^.•\n]{15,80})/i);
      const dateM=allText.match(/incorporat\w+\s+(?:on\s+)?(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4})/i);
      const statusM=allText.match(/status[:\s]*(active|inactive|struck off|dissolved)/i);
      // Extract directors from snippets
      const dirs=[];
      items.forEach(i=>{
        const t=`${i.title} ${i.snippet}`;
        [...t.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[-–]\s*(Director|Chairman|CEO|MD|Managing Director|Founder)/g)]
          .forEach(m=>{if(!dirs.find(d=>d.name===m[1])) dirs.push({name:m[1].trim(),role:m[2].trim()});});
      });
      return {
        found:true,
        name:entity,
        rc:rcM?"RC"+rcM[1]:"—",
        status:statusM?statusM[1]:"Active",
        type:"—",
        address:addrM?addrM[1].trim():"—",
        incorporated:dateM?dateM[1]:"—",
        directors:dirs.slice(0,6),
        companies:[],
        _source:"serp_cac",
      };
    }),

    // EFCC
    gSearch(`site:efcc.gov.ng "${entity}"`, 4).then(items=>({
      found:items.length>0,
      records:items.map(i=>({title:i.title,snippet:i.snippet,url:i.link}))
    })),

    // ICPC
    gSearch(`site:icpc.gov.ng "${entity}"`, 3).then(items=>({
      found:items.length>0,
      records:items.map(i=>({title:i.title,snippet:i.snippet,url:i.link}))
    })),

    // CBN
    gSearch(`site:cbn.gov.ng "${entity}" sanction OR debarment OR enforcement`, 3).then(items=>({
      found:items.length>0,
      records:items.map(i=>({title:i.title,snippet:i.snippet,url:i.link}))
    })),

    // Courts
    gSearch(`"${entity}" (site:nicn.gov.ng OR site:courtofappeal.gov.ng OR site:legalnaija.com) judgment`, 3).then(items=>({
      found:items.length>0,
      records:items.map(i=>({title:i.title,snippet:i.snippet,url:i.link}))
    })),

    // Nigerian news
    gSearch(`"${entity}" (site:${NG_NEWS})`, 6).then(items=>{
      const NEG=["fraud","efcc","icpc","corrupt","arrest","scam","scandal","probe","laundering","fake","ponzi"];
      const POS=["award","growth","invest","profit","expand","recognised","landmark","partner"];
      return items.map(i=>{
        const t=((i.title||"")+" "+(i.snippet||"")).toLowerCase();
        const neg=NEG.filter(w=>t.includes(w)).length;
        const pos=POS.filter(w=>t.includes(w)).length;
        return{title:i.title,snippet:i.snippet,url:i.link,source:i.displayLink,sentiment:neg>pos?"negative":pos>0?"positive":"neutral"};
      });
    }),

    // Research
    gSearch(`"${entity}" (site:${NG_RESEARCH})`, 3).then(items=>items.map(i=>({title:i.title,snippet:i.snippet,url:i.link,source:i.displayLink}))),
  ]);

  // Compute risk signals
  const flags=[];
  if(efcc.found) flags.push("EFCC records found");
  if(icpc.found) flags.push("ICPC records found");
  if(cbn.found)  flags.push("CBN enforcement records found");
  if(courts.found) flags.push("Court records found");
  const negNews=(news||[]).filter(a=>a.sentiment==="negative");
  if(negNews.length>=2) flags.push(`${negNews.length} negative news articles`);

  const pepTerms=["minister","governor","senator","commissioner","president","lawmaker","house of rep"];
  const allText=(news||[]).map(a=>`${a.title} ${a.snippet}`).join(" ").toLowerCase();
  if(pepTerms.some(t=>allText.includes(t))) flags.push("PEP indicators detected");

  return {
    entity, type,
    cac,
    efcc, icpc, cbn, courts,
    news: news||[],
    research: research||[],
    flags,
    risk: flags.length>=3?"HIGH":flags.length>=1?"MEDIUM":"LOW",
  };
}

// ─── Entity detection from message ───────────────────────────────
// Detects "check X", "tell me about X", "investigate X", "who is X", "what is X" etc.
function detectEntity(message, history) {
  const msg = message.trim();

  // Explicit check patterns
  const checkPatterns = [
    /\bcheck\s+(?:on\s+)?([A-Z][a-zA-Z\s&\.\-,']+?)(?:\s+(?:for\s+me|please|now|asap))?[?!.]?$/i,
    /\binvestigate\s+([A-Z][a-zA-Z\s&\.\-,']+?)(?:\s+(?:for\s+me|please))?[?!.]?$/i,
    /\brun\s+(?:a\s+)?(?:check|scan|search|due\s+diligence)\s+(?:on\s+)?([A-Z][a-zA-Z\s&\.\-,']+?)(?:\s+(?:for\s+me|please))?[?!.]?$/i,
    /\b(?:who\s+is|what\s+is|tell\s+me\s+about|find\s+(?:info\s+on|information\s+on|out\s+about))\s+([A-Z][a-zA-Z\s&\.\-,']+?)(?:\s+(?:for\s+me|please))?[?!.]?$/i,
    /\b(?:pull|get)\s+(?:info|intel|information|data)\s+on\s+([A-Z][a-zA-Z\s&\.\-,']+?)(?:\s+(?:for\s+me|please))?[?!.]?$/i,
    /^([A-Z][a-zA-Z\s&\.\-,']{3,40})$/,  // Just a name/company by itself
  ];

  for (const pat of checkPatterns) {
    const m = msg.match(pat);
    if (m) {
      const raw = m[1].trim().replace(/[.,!?]+$/, "");
      if (raw.length >= 3 && raw.length <= 60) {
        // Guess type: individuals are typically 2-3 words, companies often have Ltd/Plc/Group etc.
        const companyWords = ["ltd","limited","plc","group","nigeria","industries","holdings","bank","company","corp","enterprises","services","investment","capital","finance","tech","energy","oil","gas"];
        const isCompany = companyWords.some(w=>raw.toLowerCase().includes(w)) || raw.split(" ").length >= 3;
        return { entity: raw, type: isCompany ? "company" : "individual" };
      }
    }
  }

  // Check if user is asking a follow-up about the current locked entity
  const lockedEntity = extractLockedEntity(history);
  if (lockedEntity) {
    const followUpPatterns = [/\bwhat about\b/i,/\bmore (?:info|details|on)\b/i,/\band (?:the|their|his|her)\b/i,/\bany (?:records|news|info)\b/i,/\bwhat (?:else|do you know)\b/i,/\btheir?\b/i,/\bhis\b/i,/\bher\b/i,/\bits\b/i];
    if (followUpPatterns.some(p=>p.test(msg))) {
      return { entity: lockedEntity.entity, type: lockedEntity.type, followUp: true };
    }
  }

  return null;
}

// Extract the current "locked" entity from chat history
function extractLockedEntity(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role === "assistant" && h.lockedEntity) return h.lockedEntity;
  }
  return null;
}

// ─── Build system prompt with intel data ─────────────────────────
function buildSystemPrompt(intel) {
  if (!intel) {
    return `You are Check Am, Nigeria's premier business intelligence platform. You investigate companies and individuals with the depth of a top Nigerian due diligence firm.
When you run a scan, extract and report: RC number, CAC registration status, directors with roles, address, phone, website, incorporation date, regulatory records (EFCC/ICPC/CBN), court cases, media sentiment.
Directors are critical — always name every director/chairman/CEO/MD you find by name and role.
If RC number found, confirm it. If address found, note it. If website found, verify it.
Structure responses: **ENTITY PROFILE** → **LEADERSHIP** → **REGULATORY** → **VERDICT**.
Use **bold** for every key finding. Be specific, never vague. Never mention AI, Claude, Anthropic, or any technical systems. Present all findings as Check Am proprietary intelligence.`;
  }

  const {entity,type,cac,efcc,icpc,cbn,courts,news,research,flags,risk}=intel;
  const negNews=news.filter(a=>a.sentiment==="negative");
  const posNews=news.filter(a=>a.sentiment==="positive");

  const intelBlock=`
=== LIVE INTELLIGENCE DATA FOR: ${entity.toUpperCase()} ===
Type: ${type}
Risk Level: ${risk}
Flags: ${flags.length?flags.join(" | "):"None detected"}

--- CAC REGISTRY ---
${cac.found?`
FOUND: ${cac.name||entity}
RC Number: ${cac.rc||"—"}
Status: ${cac.status||"—"}
Type: ${cac.type||"—"}
Incorporated: ${cac.incorporated||"—"}
Address: ${cac.address||"—"}
Directors on record: ${(cac.directors||[]).join(", ")||"—"}
Linked companies: ${(cac.companies||[]).map(c=>`${c.company} (${c.role})`).join(", ")||"—"}
`:"NOT FOUND in CAC public registry"}

--- EFCC RECORDS ---
${efcc.found?`RECORDS FOUND:\n${efcc.records.map(r=>`- ${r.title}: ${r.snippet}`).join("\n")}`:"No EFCC records found"}

--- ICPC RECORDS ---
${icpc.found?`RECORDS FOUND:\n${icpc.records.map(r=>`- ${r.title}: ${r.snippet}`).join("\n")}`:"No ICPC records found"}

--- CBN RECORDS ---
${cbn.found?`RECORDS FOUND:\n${cbn.records.map(r=>`- ${r.title}: ${r.snippet}`).join("\n")}`:"No CBN enforcement records found"}

--- COURT RECORDS ---
${courts.found?`RECORDS FOUND:\n${courts.records.map(r=>`- ${r.title}: ${r.snippet}`).join("\n")}`:"No court records found"}

--- NIGERIAN NEWS (${news.length} articles) ---
Negative: ${negNews.length} | Positive: ${posNews.length}
Top headlines:
${news.slice(0,6).map(a=>`[${a.sentiment?.toUpperCase()}] ${a.title} — ${a.source}`).join("\n")||"No news found"}

--- RESEARCH & ANALYSIS ---
${research.length?research.map(r=>`- ${r.title} (${r.source})`).join("\n"):"No research found"}
=== END INTELLIGENCE DATA ===`;

  return `You are Check Am, Nigeria's premier business intelligence and due diligence platform.
You have just completed a live intelligence scan on ${entity} and have the following real data.
Use this data to give a thorough, conversational due diligence briefing.

${intelBlock}

INSTRUCTIONS:
- You are now "locked in" on ${entity} — respond as a seasoned Nigerian business intelligence analyst
- Lead with the risk level and most important finding
- Walk through each intelligence area naturally in conversation: CAC status, enforcement records, court records, news sentiment
- Give specific, actionable due diligence advice based on the findings
- If the user asks follow-up questions, answer using the data above
- Use **bold** for key findings and risk flags
- Structure responses clearly but conversationally — this is a briefing, not a bullet list
- If a record is NOT found in a database, say so — it's a positive signal worth noting
- Always end with a clear recommendation: PROCEED WITH CAUTION / CLEAR TO PROCEED / DO NOT ENGAGE
- Never mention AI, Claude, Anthropic, APIs, or any technical systems
- Present all data as Check Am proprietary live intelligence`;
}

// ─── Anthropic call ───────────────────────────────────────────────
async function callAnthropic(messages, system) {
  const resp = await postJson(
    "api.anthropic.com", "/v1/messages",
    { model:"claude-sonnet-4-20250514", max_tokens:1200, system, messages },
    { "x-api-key":ANTHROPIC_KEY, "anthropic-version":"2023-06-01" }
  );
  if(resp.error) throw new Error(resp.error.message||"API error");
  return resp.content?.[0]?.text || "Analysis complete.";
}

// ─── Main handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  refreshKeys();
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  if(!ANTHROPIC_KEY) return res.status(503).json({error:"ANTHROPIC_API_KEY not configured."});

  const {message, history=[]} = req.body||{};
  if(!message) return res.status(400).json({error:"No message"});

  try {
    // Detect if user is naming an entity to investigate
    const detected = detectEntity(message, history);
    let intel = null;
    let lockedEntity = null;

    if(detected && !detected.followUp) {
      // New entity — run live scan
      intel = await quickIntel(detected.entity, detected.type);
      lockedEntity = {entity: detected.entity, type: detected.type};
    } else if(detected && detected.followUp) {
      // Follow-up on locked entity — rebuild intel context from history
      const prev = extractLockedEntity(history);
      if(prev) {
        // Re-use cached intel if available in history, else re-scan
        const cachedIntel = history.slice().reverse().find(h=>h.role==="assistant"&&h.intel);
        if(cachedIntel?.intel) {
          intel = cachedIntel.intel;
          lockedEntity = prev;
        } else {
          intel = await quickIntel(prev.entity, prev.type);
          lockedEntity = prev;
        }
      }
    }

    const system = buildSystemPrompt(intel);

    // Build message history for Anthropic
    const msgs = [
      ...history.slice(-10).map(h=>({role:h.role,content:h.content})),
      {role:"user",content:message},
    ];

    // If new entity detected, prepend a context message
    if(intel && !detected?.followUp) {
      msgs.unshift({
        role:"user",
        content:`[INTERNAL: Live intelligence scan complete for "${detected.entity}". Use the data in the system prompt to brief the user.]`
      });
      msgs.unshift({role:"assistant",content:`[Scanning ${detected.entity}...]`});
    }

    const text = await callAnthropic(msgs.slice(-12), system);

    return res.status(200).json({
      text,
      lockedEntity,
      intel: intel ? {
        entity:intel.entity,
        type:intel.type,
        risk:intel.risk,
        flags:intel.flags,
        cac_found:intel.cac?.found,
        reg_hits:[intel.efcc?.found&&"EFCC",intel.icpc?.found&&"ICPC",intel.cbn?.found&&"CBN",intel.courts?.found&&"COURTS"].filter(Boolean),
        news_count:intel.news?.length,
        // Don't send full intel back to client — just summary
      } : null,
      scanning: !!intel && !detected?.followUp,
    });
  } catch(e) {
    console.error("Chat error:",e.message);
    return res.status(500).json({error:e.message});
  }
};
