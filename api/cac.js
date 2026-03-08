// ══════════════════════════════════════════════════════════════════
// CAC NIGERIA — Direct Public Portal Scraper
// Hits search.cac.gov.ng public search (no auth required)
// Returns: name, rc_number, status, type, address, directors
// ══════════════════════════════════════════════════════════════════

const https = require('https');
const http = require('http');

// Generic HTTPS fetch helper
function fetch(url, opts={}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        ...(opts.headers || {}),
      },
      ...(opts.port ? {port: opts.port} : {}),
    };
    if(opts.body) {
      options.headers['Content-Type'] = opts.headers?.['Content-Type'] || 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(opts.body);
    }
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: data}));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    if(opts.body) req.write(opts.body);
    req.end();
  });
}

// ── CAC Public Search Portal ──────────────────────────────────────
// search.cac.gov.ng is an Angular SPA that calls its own backend
// Internal API endpoint discovered by network inspection:
// POST https://search.cac.gov.ng/api/search/public-search
// GET  https://search.cac.gov.ng/api/search/public?name=...

async function searchCAC(query) {
  const results = [];
  const isRC = /^(RC\s*)?(\d{4,8})$/i.test(query.trim());
  const rcNum = isRC ? query.replace(/^RC\s*/i, '') : '';

  // ── Strategy 1: Direct API endpoint (reverse-engineered from the portal's XHR) ──
  try {
    const searchPayload = isRC
      ? JSON.stringify({ rcNumber: rcNum, searchType: 'RC' })
      : JSON.stringify({ companyName: query.trim(), searchType: 'NAME', page: 0, size: 10 });

    // Try the documented internal endpoint
    const endpoints = [
      { url: 'https://search.cac.gov.ng/api/search/public-search', method: 'POST', body: searchPayload },
      { url: `https://search.cac.gov.ng/api/search/public?name=${encodeURIComponent(query)}&page=0&size=10`, method: 'GET' },
      { url: `https://search.cac.gov.ng/api/company/search?q=${encodeURIComponent(query)}`, method: 'GET' },
    ];

    for(const ep of endpoints) {
      try {
        const r = await fetch(ep.url, {
          method: ep.method,
          body: ep.body,
          headers: {
            'Referer': 'https://search.cac.gov.ng/',
            'Origin': 'https://search.cac.gov.ng',
            'Accept': 'application/json',
            ...(ep.body ? {'Content-Type':'application/json'} : {}),
          }
        });
        if(r.status === 200) {
          const json = JSON.parse(r.body);
          const list = json?.data || json?.content || json?.results || (Array.isArray(json) ? json : []);
          if(list.length > 0) {
            list.forEach(co => {
              results.push(mapCACResult(co));
            });
            if(results.length) return { success: true, source: 'cac_api', results };
          }
        }
      } catch(_) {}
    }
  } catch(_) {}

  // ── Strategy 2: Scrape the HTML search page ──────────────────────
  try {
    const searchUrl = isRC
      ? `https://search.cac.gov.ng/home/searchResult?rcNumber=${rcNum}`
      : `https://search.cac.gov.ng/home/searchSimilarBusiness?name=${encodeURIComponent(query)}`;

    const r = await fetch(searchUrl, {
      headers: {
        'Referer': 'https://search.cac.gov.ng/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });

    if(r.status === 200 && r.body) {
      const scraped = scrapeCAC(r.body, query);
      if(scraped.length) return { success: true, source: 'cac_html', results: scraped };
    }
  } catch(_) {}

  // ── Strategy 3: Try the older public search endpoint ─────────────
  try {
    const legacyUrl = `http://publicsearch.cac.gov.ng:8080/comsearch/SearchCompany?name=${encodeURIComponent(query)}`;
    const r = await fetch(legacyUrl);
    if(r.status === 200 && r.body) {
      const scraped = scrapeLegacyCAC(r.body);
      if(scraped.length) return { success: true, source: 'cac_legacy', results: scraped };
    }
  } catch(_) {}

  return { success: false, source: 'none', results: [] };
}

// Map CAC API response fields to our schema
function mapCACResult(co) {
  const directors = [];
  (co.affiliates || co.directors || co.officers || []).forEach(a => {
    const name = [a.firstname||'', a.otherName||a.other_name||'', a.surname||''].filter(Boolean).join(' ').trim()
               || a.name || a.fullName || '';
    if(name) directors.push({
      name,
      role: a.designation || a.occupation || (a.is_chairman ? 'Chairman' : 'Director'),
      address: a.address || '',
      status: a.status || 'ACTIVE',
    });
  });
  const shareholders = [];
  (co.shareholders || co.affiliates || []).filter(a => a.numSharesAlloted || a.num_shares_alloted).forEach(s => {
    const name = [s.firstname||'', s.surname||''].filter(Boolean).join(' ').trim() || s.name || '';
    if(name) shareholders.push({
      name,
      shares: s.numSharesAlloted || s.num_shares_alloted || '—',
      type: s.typeOfShares || s.type_of_shares || 'Ordinary',
    });
  });

  const rcRaw = co.rcNumber || co.rc_number || co.rcNo || co.companyId || '';
  return {
    name: co.companyName || co.company_name || co.name || co.businessName || '—',
    rc_number: rcRaw ? 'RC' + String(rcRaw).replace(/^RC/i, '').replace(/^0+/, '') : '—',
    status: co.companyStatus || co.company_status || co.status || 'ACTIVE',
    type: co.companyType || co.company_type || co.typeOfEntity || co.classification || '—',
    address: co.headOfficeAddress || co.head_office_address || co.branchAddress || co.branch_address || co.address || '—',
    email: co.companyEmail || co.email || co.website_email || '—',
    incorporated: co.registrationDate || co.registration_date || '—',
    state: co.state || '—',
    city: co.city || co.lga || '—',
    share_capital: co.shareCapital || co.share_capital || '—',
    directors,
    shareholders,
    tin: co.tin || co.jtbTin || '—',
    _raw: co,
  };
}

// Parse HTML from search.cac.gov.ng/home/searchSimilarBusiness
function scrapeCAC(html, query) {
  const results = [];
  // The portal renders a table or list with company entries
  // Pattern: RC number, company name, type, status
  const tableRowPat = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdPat = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const rows = html.match(tableRowPat) || [];

  rows.forEach(row => {
    const cells = [];
    let m;
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while((m = tdRe.exec(row)) !== null) {
      cells.push(m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim());
    }
    if(cells.length >= 2) {
      // Typical CAC table: RC Number | Company Name | Company Type | Status | Date
      const rcMatch = cells.find(c => /^\d{4,8}$/.test(c) || /^RC\d/i.test(c));
      const nameCell = cells.find(c => c.length > 3 && !/^\d+$/.test(c) && !/^(active|inactive|ltd|plc|private|public)/i.test(c));
      if(rcMatch || nameCell) {
        results.push({
          name: nameCell || '—',
          rc_number: rcMatch ? 'RC' + rcMatch.replace(/^RC/i,'') : '—',
          status: cells.find(c => /active|inactive|struck/i.test(c)) || 'ACTIVE',
          type: cells.find(c => /limited|private|public|trustee|business/i.test(c)) || '—',
          address: '—', email: '—', incorporated: '—',
          state: '—', city: '—', share_capital: '—',
          directors: [], shareholders: [], tin: '—',
        });
      }
    }
  });

  // Also try JSON embedded in page script tags
  const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});/m)
                 || html.match(/ng-init=".*?({[\s\S]+?})/m)
                 || html.match(/"companies"\s*:\s*(\[[\s\S]+?\])/m);
  if(jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const list = Array.isArray(data) ? data : (data.companies || data.results || []);
      list.forEach(co => results.push(mapCACResult(co)));
    } catch(_) {}
  }
  return results;
}

function scrapeLegacyCAC(html) {
  const results = [];
  const pat = /<tr[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while((m = pat.exec(html)) !== null) {
    const cells = m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    const text = cells.map(c => c.replace(/<[^>]+>/g,'').trim());
    if(text.length >= 2) {
      results.push({
        name: text[1] || text[0] || '—',
        rc_number: (text[0]||'').match(/\d{4,8}/) ? 'RC'+text[0].match(/\d{4,8}/)[0] : '—',
        status: 'ACTIVE', type: '—', address: '—', email: '—',
        incorporated: '—', state: '—', city: '—', share_capital: '—',
        directors: [], shareholders: [], tin: '—',
      });
    }
  }
  return results;
}

// ── Vercel handler ────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const query = req.body?.query || req.query?.q || '';
  if(!query) return res.status(400).json({error: 'No query provided'});

  try {
    const result = await searchCAC(query.trim());
    return res.status(200).json(result);
  } catch(e) {
    return res.status(200).json({success: false, source: 'error', results: [], error: e.message});
  }
};
