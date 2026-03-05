# 🇳🇬 Check Am — Nigeria Business Intelligence Platform

---

## FOLDER STRUCTURE

```
checkam/
├── index.html              ← Frontend (lives in root for Vercel)
├── vercel.json             ← Vercel routing config
├── requirements.txt        ← Python dependencies
├── api/
│   ├── search.py           ← POST /api/search
│   ├── chat.py             ← POST /api/chat
│   ├── health.py           ← GET  /api/health
│   └── modules/
│       └── agent.py        ← Intelligence engine
├── .env.example            ← API key template
├── .gitignore
└── README.md
```

---

## DEPLOY TO VERCEL (5 minutes)

### Step 1 — Push to GitHub

1. Create a **private** GitHub repository
2. Upload all these files to it (drag & drop works on GitHub)
3. Make sure `.env.local` is NOT included — `.gitignore` blocks it

### Step 2 — Connect to Vercel

1. Go to [vercel.com](https://vercel.com) → Log in → **Add New Project**
2. Import your GitHub repository
3. Vercel auto-detects the config from `vercel.json`
4. Click **Deploy** — it will fail the first time (no API key yet, that's fine)

### Step 3 — Add your API key

1. In Vercel: **Your Project → Settings → Environment Variables**
2. Add a new variable:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** `sk-ant-your-actual-key-here`
   - **Environment:** Production, Preview, Development (tick all three)
3. Click **Save**
4. Go to **Deployments → Redeploy** (click the three dots on your latest deployment)

Your site is now live at `https://your-project-name.vercel.app` ✓

---

## TEST LOCALLY (before deploying)

Vercel has a local dev tool. Install it once:

```bash
npm install -g vercel
```

Then run from inside the `checkam` folder:

```bash
# First time only — links to your Vercel account
vercel login
vercel dev
```

Open: **http://localhost:3000**

Vercel dev reads environment variables from a `.env.local` file:
```bash
# Create .env.local (copy from .env.example)
cp .env.example .env.local
# Then edit .env.local and paste your real API key
```

---

## TEST SEARCHES

Once running, try:
| Query | Type |
|---|---|
| Dangote Group | Company |
| Access Bank | Company |
| Shell Nigeria | Company |
| Aliko Dangote | Individual |
| Emeka Obi | Individual — has EFCC flag |
| Femi Adeyemi | Individual — PEP linked |

---

## TROUBLESHOOTING

| Problem | Fix |
|---|---|
| Functions fail with 503 | API key not set in Vercel environment variables |
| Functions fail with 500 | Check Vercel function logs: Project → Functions tab |
| Blank page | Check browser console for errors |
| Works locally but not on Vercel | Redeploy after adding the env variable |
