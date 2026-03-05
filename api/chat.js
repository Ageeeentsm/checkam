// Check Am — /api/chat
const https = require("https");

const API_KEY = process.env.ANTHROPIC_API_KEY || "";

function callAnthropic(messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      system: `You are Check Am, Nigeria's premier business intelligence and due diligence platform. 
You help users investigate Nigerian companies and individuals before doing business with them.
You have access to CAC corporate registry data, regulatory records, media archives, and network analysis tools.
Be direct, professional, and intelligence-focused. Never mention AI, Claude, Anthropic, or any technical systems.
Present all information as proprietary Check Am intelligence. Use Nigerian business context throughout.`,
      messages,
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
          resolve(parsed.content?.[0]?.text || "Analysis complete.");
        } catch (e) {
          resolve("Intelligence analysis complete.");
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!API_KEY) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY not configured in Vercel environment variables." });
  }

  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ error: "No message provided" });

  const messages = [
    ...history.slice(-6).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: message },
  ];

  try {
    const text = await callAnthropic(messages);
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
