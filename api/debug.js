// Check Am — /api/debug
const https = require("https");

function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}

module.exports = function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Content-Type", "application/json");

  const ANTHROPIC_KEY = cleanKey(process.env.ANTHROPIC_API_KEY);
  const GOOGLE_KEY    = cleanKey(process.env.GOOGLE_API_KEY);
  const GOOGLE_CX     = cleanKey(process.env.GOOGLE_CX);
  const MAPBOX_TOKEN  = cleanKey(process.env.MAPBOX_TOKEN);

  const env_vars = {
    ANTHROPIC_API_KEY: ANTHROPIC_KEY ? `✅ PRESENT (${ANTHROPIC_KEY.length} chars) — ${ANTHROPIC_KEY.substring(0,8)}...` : "❌ MISSING",
    GOOGLE_API_KEY:    GOOGLE_KEY    ? `✅ PRESENT (${GOOGLE_KEY.length} chars) — ${GOOGLE_KEY.substring(0,8)}...`    : "❌ MISSING",
    GOOGLE_CX:         GOOGLE_CX     ? `✅ PRESENT (${GOOGLE_CX.length} chars) — ${GOOGLE_CX.substring(0,8)}...`     : "❌ MISSING",
    MAPBOX_TOKEN:      MAPBOX_TOKEN  ? `✅ PRESENT (${MAPBOX_TOKEN.length} chars) — ${MAPBOX_TOKEN.substring(0,8)}...` : "❌ MISSING",
  };

  if (!GOOGLE_KEY || !GOOGLE_CX) {
    response.status(200).end(JSON.stringify({ status:"PARTIAL", env_vars, google_test:"SKIPPED — key or CX missing" }, null, 2));
    return;
  }

  const testUrl = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_KEY}&cx=${GOOGLE_CX}&q=nigeria+business&num=1`;

  https.get(testUrl, {headers:{"Accept":"application/json"}}, (gres) => {
    let body = "";
    gres.on("data", c => body += c);
    gres.on("end", () => {
      let google_test = "", google_error = "";
      try {
        const j = JSON.parse(body);
        if (j.error)            { google_test = "❌ ERROR";   google_error = `Code ${j.error.code}: ${j.error.message}`; }
        else if (j.items?.length) google_test = `✅ WORKING — ${j.items.length} result(s)`;
        else                      google_test = "✅ WORKING — API live";
      } catch(e) { google_test = "❌ PARSE ERROR"; google_error = body.substring(0,300); }

      response.status(200).end(JSON.stringify({
        status: google_test.includes("✅") ? "ALL GOOD" : "GOOGLE BROKEN",
        env_vars, google_test,
        google_error: google_error || undefined,
      }, null, 2));
    });
  }).on("error", e => {
    response.status(200).end(JSON.stringify({ status:"NETWORK ERROR", env_vars, google_test:"❌ FAILED", google_error: e.message }, null, 2));
  });
};
