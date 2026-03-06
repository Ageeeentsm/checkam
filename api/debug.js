// Check Am — /api/debug  (safe diagnostics — shows presence, never values)
module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  function cleanKey(r){return String(r||"").replace(/[^\x21-\x7E]/g,"").trim();}

  const keys = {
    ANTHROPIC_API_KEY:  cleanKey(process.env.ANTHROPIC_API_KEY),
    GOOGLE_API_KEY:     cleanKey(process.env.GOOGLE_API_KEY),
    GOOGLE_CX:          cleanKey(process.env.GOOGLE_CX),
    MAPBOX_TOKEN:       cleanKey(process.env.MAPBOX_TOKEN),
  };

  const report = {};
  for (const [k, v] of Object.entries(keys)) {
    if (!v) {
      report[k] = "❌ MISSING — not found in environment";
    } else {
      // Show first 6 chars and last 4 chars only — never full value
      const preview = v.length > 12
        ? v.substring(0, 6) + "..." + v.substring(v.length - 4)
        : v.substring(0, 3) + "***";
      report[k] = `✅ PRESENT (${v.length} chars) — starts: ${preview}`;
    }
  }

  // Also test Google API live
  const https = require("https");
  const gKey = keys.GOOGLE_API_KEY;
  const gCx  = keys.GOOGLE_CX;

  if (!gKey || !gCx) {
    return res.status(200).json({
      status: "PARTIAL",
      env_vars: report,
      google_test: "SKIPPED — key or CX missing",
      fix: "Go to Vercel → Settings → Environment Variables and add the missing keys, then redeploy"
    });
  }

  // Live Google test
  const testUrl = `https://www.googleapis.com/customsearch/v1?key=${gKey}&cx=${gCx}&q=test+nigeria&num=1`;
  const req = https.get(testUrl, { headers: { "Accept": "application/json" } }, (gres) => {
    let body = "";
    gres.on("data", c => body += c);
    gres.on("end", () => {
      let googleStatus = "";
      let googleError  = "";
      try {
        const j = JSON.parse(body);
        if (j.error) {
          googleStatus = "❌ GOOGLE API ERROR";
          googleError  = `Code ${j.error.code}: ${j.error.message}`;
        } else if (j.items) {
          googleStatus = `✅ WORKING — returned ${j.items.length} result(s)`;
        } else if (j.searchInformation) {
          googleStatus = "✅ WORKING — 0 results for test query but API is live";
        } else {
          googleStatus = "⚠ UNEXPECTED RESPONSE";
          googleError  = body.substring(0, 200);
        }
      } catch(e) {
        googleStatus = "❌ PARSE ERROR";
        googleError  = body.substring(0, 200);
      }

      return res.status(200).json({
        status: "OK",
        env_vars: report,
        google_live_test: googleStatus,
        google_error: googleError || undefined,
        cx_value_length: gCx.length,
        cx_preview: gCx.substring(0, 8) + "...",
        tip: googleError?.includes("API key not valid")
          ? "Your GOOGLE_API_KEY is wrong or Custom Search API is not enabled on it"
          : googleError?.includes("Invalid Value")
          ? "Your GOOGLE_CX value looks wrong — go to programmablesearchengine.google.com and copy the Search Engine ID again"
          : googleError?.includes("dailyLimitExceeded")
          ? "You have hit the 100 free searches/day limit — upgrade billing in Google Cloud Console"
          : "If Google test failed, check the google_error field above"
      });
    });
  });
  req.on("error", (e) => {
    return res.status(200).json({
      status: "ERROR",
      env_vars: report,
      google_live_test: "❌ NETWORK ERROR",
      google_error: e.message
    });
  });
  req.setTimeout(8000, () => {
    req.destroy();
    return res.status(200).json({
      status: "TIMEOUT",
      env_vars: report,
      google_live_test: "❌ TIMEOUT — Google API did not respond in 8s"
    });
  });
};
