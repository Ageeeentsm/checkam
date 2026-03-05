// Check Am — /api/chat v3.0
// Detects entity mentions → runs full live intelligence scan → responds with real data in due diligence chat style

const https = require("https");

function cleanKey(r) { return String(r||"").replace(/[^\x21-\x7E]/g,"").trim(); }

const ANTHROPIC_KEY = cleanKey(process.env.ANTHROPIC_API_KEY);
const GOOGLE_KEY    = cleanKey(process.env.GOOGLE_API_KEY);
const GOOGLE_CX     = cleanKey(process.env.GOOGLE_CX);

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

// ─── Google search ────────────────────────────────────────────────
async function gSearch(query, num=6) {
  if(!GOOGLE_KEY||!GOOGLE_CX) return [];
  try {
    const url=`https://www.googleapis.com/customsearch/v1?key=${GOOGLE_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&num=${num}`;
    const {s,b}=await get(url,{},10000);
    if(s===200){const j=JSON.parse(b);return j.items||[];}
  } catch(_){}
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
    // CAC
    get(isCompany
      ?`https://search.cac.gov.ng/home/searchSimilarBusiness?name=${enc}`
      :`https://search.cac.gov.ng/home/searchDirector?name=${enc}`
    ).then(({s,b})=>{
      if(s!==200) return {found:false};
      try{
        const j=JSON.parse(b);
        const recs=j.data||j.results||(Array.isArray(j)?j:[]);
        if(!recs.length) return {found:false};
        const r=recs[0];
        return {
          found:true,
          name:r.company_name||r.CompanyName||r.name||entity,
          rc:r.rc_number||r.RcNumber||"—",
          status:r.status||r.CompanyStatus||"Active",
          type:r.company_type||r.CompanyType||"—",
          address:r.address||r.RegisteredAddress||"—",
          incorporated:r.date_of_incorporation||r.DateOfIncorporation||"—",
          directors:(r.directors||[]).map(d=>typeof d==="string"?d:d.name||d).filter(Boolean).slice(0,5),
          companies:recs.map(x=>({company:x.company_name||x.CompanyName||x.name,rc:x.rc_number||x.RcNumber||"—",role:x.role||x.designation||"Director"})).slice(0,6),
        };
      }catch(_){return{found:false};}
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
    return `You are Check Am, Nigeria's premier business intelligence and due diligence platform.
You help users investigate Nigerian companies and individuals before doing business with them.
You scan CAC Registry, EFCC, ICPC, CBN, Court Records, SEC, FIRS, and all major Nigerian news sources.
Be direct, professional, and intelligence-focused. Use **bold** for key findings.
When a user names a company or person, tell them you're locking in and scanning — then provide due diligence advice.
Never mention AI, Claude, Anthropic, or any technical systems. Present all findings as Check Am proprietary intelligence.`;
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
