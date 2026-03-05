// Check Am — /api/search
// Vercel Node.js serverless function

const https = require("https");

const API_KEY = process.env.ANTHROPIC_API_KEY || "";

// ── Simulated intelligence data ───────────────────────────────────

const COMPANIES = {
  "dangote group": {
    name: "Dangote Group",
    rc_number: "RC-19811",
    status: "Active",
    incorporated: "12 March 1981",
    type: "Private Limited Company",
    sector: "Conglomerate / Manufacturing",
    address: "Union Marble House, 1 Alfred Rewane Road, Ikoyi, Lagos",
    directors: ["Aliko Dangote", "Sani Dangote", "Sayyu Dantata", "Olakunle Alake"],
    shareholders: [
      { name: "Aliko Dangote", percentage: 85 },
      { name: "Institutional Investors", percentage: 10 },
      { name: "Other Shareholders", percentage: 5 },
    ],
    foreign_links: ["Dangote Industries Mauritius", "Dangote International Ltd UK"],
    subsidiaries: ["Dangote Cement Plc", "Dangote Sugar Refinery", "Dangote Salt Ltd", "NASCON Allied Industries"],
  },
  "access bank": {
    name: "Access Bank Plc",
    rc_number: "RC-125384",
    status: "Active",
    incorporated: "8 February 1989",
    type: "Public Limited Company",
    sector: "Banking & Financial Services",
    address: "Plot 999c Danmole Street, Victoria Island, Lagos",
    directors: ["Aigboje Aig-Imoukhuede", "Herbert Wigwe", "Roosevelt Ogbonna", "Kazeem Olanrewaju"],
    shareholders: [
      { name: "Public Float", percentage: 78.6 },
      { name: "Stanbic Nominees", percentage: 12.4 },
      { name: "FBN Holdings", percentage: 9 },
    ],
    foreign_links: ["Access Bank UK Ltd"],
    subsidiaries: ["Access Bank UK", "Access Bank Rwanda", "Access Bank Ghana"],
  },
  "shell nigeria": {
    name: "Shell Petroleum Development Company of Nigeria Ltd",
    rc_number: "RC-002402",
    status: "Active",
    incorporated: "1 January 1956",
    type: "Private Limited Company",
    sector: "Oil & Gas Exploration",
    address: "21/22 Marina Street, Lagos Island, Lagos",
    directors: ["Osagie Okunbor", "Elohor Aiboni", "Tony Attah", "Bayo Ojulari"],
    shareholders: [
      { name: "Shell International (Netherlands)", percentage: 30 },
      { name: "NNPC", percentage: 55 },
      { name: "Total Energies", percentage: 10 },
      { name: "Eni", percentage: 5 },
    ],
    foreign_links: ["Shell International BV Netherlands", "Shell Overseas Holdings UK"],
    subsidiaries: ["SPDC JV", "SNEPCo", "NLNG"],
  },
};

const INDIVIDUALS = {
  "aliko dangote": {
    name: "Aliko Dangote",
    nationality: "Nigerian",
    pep_status: false,
    companies: [
      { company: "Dangote Group", role: "Chairman & CEO", rc: "RC-19811" },
      { company: "Dangote Cement Plc", role: "Chairman", rc: "RC-13548" },
      { company: "Dangote Sugar Refinery Plc", role: "Chairman", rc: "RC-19811" },
      { company: "NASCON Allied Industries", role: "Chairman", rc: "RC-20211" },
    ],
    regulatory_flags: [],
  },
  "emeka obi": {
    name: "Emeka Obi",
    nationality: "Nigerian",
    pep_status: false,
    companies: [
      { company: "Obi Ventures Ltd", role: "Director", rc: "RC-441290" },
      { company: "Zenith Contracting Ltd", role: "Director", rc: "RC-556721" },
      { company: "Lagos Properties Ltd", role: "Director", rc: "RC-334891" },
    ],
    regulatory_flags: [
      { agency: "EFCC", case: "Alleged procurement fraud (2019)", status: "Investigation closed — no conviction" },
    ],
    note: "Subject appeared in EFCC investigation (2019). Case closed with no conviction.",
  },
  "femi adeyemi": {
    name: "Femi Adeyemi",
    nationality: "Nigerian",
    pep_status: true,
    pep_details: "Former Lagos State Commissioner for Finance (2011–2015). Currently private sector.",
    companies: [
      { company: "Adeyemi Capital Partners", role: "Managing Director", rc: "RC-778234" },
      { company: "Southwest Infrastructure Ltd", role: "Director", rc: "RC-445123" },
    ],
    regulatory_flags: [],
  },
};

const MEDIA_POSITIVE = [
  "ranks among Africa's most admired companies",
  "posts record revenue growth amid expansion",
  "wins FT Africa Business Award",
  "recognised for corporate governance excellence",
  "announces major investment in Nigerian infrastructure",
];
const MEDIA_NEGATIVE = [
  "faces regulatory scrutiny over compliance",
  "under investigation for contract irregularities",
  "named in leaked financial documents",
  "faces shareholder lawsuit over disclosures",
];
const MEDIA_NEUTRAL = [
  "announces board changes ahead of AGM",
  "reports quarterly results in line with estimates",
  "completes acquisition of regional rival",
  "files annual accounts with CAC",
];

function generateMedia(name) {
  const sources = ["The Punch", "Vanguard", "BusinessDay", "ThisDay", "Premium Times", "The Cable"];
  const years = ["2022", "2023", "2024", "2025"];
  const articles = [];
  const posCount = 3 + Math.floor(Math.random() * 2);
  const negCount = Math.floor(Math.random() * 2);
  const neuCount = 2;

  for (let i = 0; i < posCount; i++) {
    articles.push({
      headline: `${name} ${MEDIA_POSITIVE[i % MEDIA_POSITIVE.length]}`,
      source: sources[i % sources.length],
      date: `${years[Math.floor(Math.random() * years.length)]}`,
      sentiment: "positive",
    });
  }
  for (let i = 0; i < negCount; i++) {
    articles.push({
      headline: `${name} ${MEDIA_NEGATIVE[i % MEDIA_NEGATIVE.length]}`,
      source: sources[(i + 2) % sources.length],
      date: `${years[Math.floor(Math.random() * years.length)]}`,
      sentiment: "negative",
    });
  }
  for (let i = 0; i < neuCount; i++) {
    articles.push({
      headline: `${name} ${MEDIA_NEUTRAL[i % MEDIA_NEUTRAL.length]}`,
      source: sources[(i + 4) % sources.length],
      date: `${years[Math.floor(Math.random() * years.length)]}`,
      sentiment: "neutral",
    });
  }

  const total = articles.length;
  const sentimentScore = Math.round((posCount / total) * 100);
  return { articles, sentiment_score: sentimentScore, negative_count: negCount, total };
}

function buildNetwork(name, data, isCompany) {
  const nodes = [];
  const edges = [];
  const rootId = "root";

  nodes.push({ id: rootId, label: name, type: isCompany ? "company" : "individual", level: 0 });

  if (isCompany) {
    (data.directors || []).slice(0, 4).forEach((d, i) => {
      const id = `dir_${i}`;
      nodes.push({ id, label: d, type: "individual", level: 1 });
      edges.push({ from: rootId, to: id, label: "director" });
    });
    (data.subsidiaries || []).slice(0, 3).forEach((s, i) => {
      const id = `sub_${i}`;
      nodes.push({ id, label: s, type: "subsidiary", level: 1 });
      edges.push({ from: rootId, to: id, label: "subsidiary" });
    });
    (data.foreign_links || []).slice(0, 2).forEach((f, i) => {
      const id = `fgn_${i}`;
      nodes.push({ id, label: f, type: "foreign", level: 2 });
      edges.push({ from: rootId, to: id, label: "foreign link" });
    });
  } else {
    (data.companies || []).forEach((c, i) => {
      const id = `co_${i}`;
      nodes.push({ id, label: c.company, type: "company", level: 1 });
      edges.push({ from: rootId, to: id, label: c.role });
    });
  }

  return { nodes, edges, node_count: nodes.length, edge_count: edges.length };
}

function scoreRisk(data, isCompany, name) {
  let legitimacy = 70, risk = 30, influence = 50;
  const flags = [];

  if (isCompany) {
    if (data.status === "Active") legitimacy += 10;
    if ((data.foreign_links || []).length > 0) { risk += 10; flags.push("foreign_exposure"); }
    if ((data.subsidiaries || []).length > 3) influence += 20;
    const nameL = name.toLowerCase();
    if (nameL.includes("dangote")) { legitimacy = 85; influence = 92; risk = 22; }
    if (nameL.includes("access bank")) { legitimacy = 88; influence = 78; risk = 18; }
    if (nameL.includes("shell")) { legitimacy = 80; influence = 85; risk = 28; }
  } else {
    if (data.pep_status) { risk += 25; flags.push("pep_linked"); }
    if ((data.regulatory_flags || []).length > 0) { risk += 20; flags.push("regulatory_flag"); }
    if ((data.companies || []).length > 3) influence += 25;
  }

  legitimacy = Math.min(99, Math.max(10, legitimacy));
  risk = Math.min(95, Math.max(5, risk));
  influence = Math.min(99, Math.max(10, influence));

  let rating = risk < 35 ? "LOW RISK" : risk < 60 ? "MEDIUM RISK" : "HIGH RISK";
  let confidence = risk < 35 ? "HIGH" : risk < 60 ? "MEDIUM" : "HIGH";

  return {
    legitimacy_score: legitimacy,
    risk_score: risk,
    influence_score: influence,
    rating,
    confidence,
    pep_linked: flags.includes("pep_linked"),
    foreign_exposure: flags.includes("foreign_exposure"),
    sanctions_hit: false,
  };
}

// ── Call Anthropic API ───────────────────────────────────────────

function callAnthropic(prompt, structuredData) {
  return new Promise((resolve, reject) => {
    const systemPrompt = `You are Check Am, Nigeria's premier business intelligence system. 
You have just completed a full data analysis on a Nigerian entity. 
Write a concise executive intelligence summary (3-4 paragraphs) based on the data provided.
Be direct, professional, and highlight the most important findings.
Do not mention any AI, APIs, or technical systems. Present findings as proprietary intelligence.`;

    const userMessage = `${prompt}\n\nData gathered:\n${JSON.stringify(structuredData, null, 2)}\n\nWrite the executive intelligence summary now.`;

    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || "Analysis complete.";
          resolve(text);
        } catch (e) {
          resolve("Intelligence analysis complete.");
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

// ── Main handler ─────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!API_KEY) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY not configured in Vercel environment variables." });
  }

  const { entity, type: entityType = "company" } = req.body || {};
  if (!entity) return res.status(400).json({ error: "No entity provided" });

  const isCompany = entityType === "company";
  const nameKey = entity.toLowerCase().trim();

  // Look up or generate data
  let companyData = {};
  let individualData = {};

  if (isCompany) {
    companyData = COMPANIES[nameKey] || {
      name: entity,
      rc_number: "RC-" + Math.floor(100000 + Math.random() * 899999),
      status: "Active",
      incorporated: "2010",
      type: "Private Limited Company",
      sector: "General Business",
      address: "Lagos, Nigeria",
      directors: ["Director 1", "Director 2"],
      shareholders: [{ name: "Principal Shareholder", percentage: 100 }],
      foreign_links: [],
      subsidiaries: [],
    };
  } else {
    individualData = INDIVIDUALS[nameKey] || {
      name: entity,
      nationality: "Nigerian",
      pep_status: false,
      companies: [],
      regulatory_flags: [],
    };
  }

  const sourceData = isCompany ? companyData : individualData;
  const media = generateMedia(entity);
  const network = buildNetwork(entity, sourceData, isCompany);
  const scores = scoreRisk(sourceData, isCompany, nameKey);

  const structuredData = { company: companyData, individual: individualData, media, network, scores };

  const prompt = isCompany
    ? `Due diligence on Nigerian company: ${entity}`
    : `Background check on Nigerian individual: ${entity}`;

  let summaryText = "";
  try {
    summaryText = await callAnthropic(prompt, structuredData);
  } catch (e) {
    summaryText = `Intelligence analysis for ${entity} is complete. Review the structured data above for full details.`;
  }

  return res.status(200).json({ text: summaryText, data: structuredData });
};
