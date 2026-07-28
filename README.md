# EGX Portfolio Tracker

A portfolio tracker for the Egyptian market — funds, stocks, gold. Works two ways:

- **Signed in** (you): data syncs across devices via Supabase, real login (magic-link email, no password to manage), plus an on-request AI-analysis section.
- **Visitor** (anyone else): fully usable with zero setup — data stays in that browser's local storage only, never touches a server. Export/import a JSON file to move it between devices manually.

Everything runs free: Vercel (hosting) + Supabase (auth + database), both free tier.

## What auto-refreshes, and what doesn't

| Ticker | Source | Notes |
|---|---|---|
| BAL, BMM, BRE | snduk.com (public, no login) | Verified working while building this |
| COMI, MASR, ETEL, CLHO, IBCT | EODHD free tier | 20 calls/day free limit, this uses 5 |
| Gold | GoldAPI.io | EGP price, converted troy-oz → gram |
| C2O, T70 | — | No confirmed public source found. Enter manually, or add a fetcher in `scripts/refresh-prices.mjs` if you find one |
| Clouds | — | Not a market price — it's interest-accruing cash. Track it via manual value updates, same as before |

**Deliberately not automated:** Thndr and TheRumble logins. See the main project conversation for why — the short version is that storing brokerage/subscription credentials in any unattended pipeline is a real security and ToS risk, regardless of how it's stored. The AI-analysis section is refreshed on request instead: ask Claude to log in with your own authenticated browser session and review TheRumble, then paste the resulting JSON into the app.

## One-time setup

### 1. Supabase project

1. Create a new project at [supabase.com](https://supabase.com) (free tier).
2. Open the SQL editor, paste in `supabase/schema.sql`, run it.
3. Auth → Providers → make sure **Email** is enabled, with "Confirm email" and magic-link sign-in on (default).
4. Auth → URL Configuration → set **Site URL** to your eventual Vercel URL (you can update this after step 3 below once you know it).
5. Project Settings → API: copy the **Project URL** and the **anon/public key** — these go in Vercel. Copy the **service_role key** too — this goes in a GitHub secret, never in Vercel/client code.

### 2. Push this to GitHub

```bash
cd webapp
git init
git add .
git commit -m "Initial commit"
gh repo create eg-stock-tracker --public --source=. --push
```

(Public is required for GitHub Pages/Vercel's free tier to apply cleanly — this is safe because no real data ever lives in the repo, only in Supabase behind auth, or in a visitor's own browser.)

### 3. Vercel

1. Import the GitHub repo into Vercel.
2. Root directory: `webapp` (if you pushed from inside `webapp/`, leave as default).
3. Environment Variables:
   - `VITE_SUPABASE_URL` = your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` = your Supabase anon key
   (Both are safe to expose client-side — Supabase's security model relies on Row Level Security, not on hiding these.)
4. Deploy. Vercel auto-redeploys on every push to `main` from here on — no custom GitHub Action needed for that part.
5. Go back to Supabase → Auth → URL Configuration and set the Site URL to your real Vercel URL.

### 4. GitHub Action secrets (for the price refresh)

Repo → Settings → Secrets and variables → Actions → New repository secret:

- `SUPABASE_URL` — same project URL as above
- `SUPABASE_SERVICE_ROLE_KEY` — from Supabase Project Settings → API. **Never** put this anywhere else.
- `EODHD_API_KEY` — free signup at [eodhd.com](https://eodhd.com)
- `GOLDAPI_KEY` — free signup at [goldapi.io](https://www.goldapi.io)

The workflow (`.github/workflows/refresh-prices.yml`) runs automatically Sun–Thu after EGX close, or trigger it manually from the Actions tab (`workflow_dispatch`).

### 5. Load your own starting data

1. Visit the deployed site, sign in with your email (check inbox for the magic link).
2. In the Supabase SQL editor, run `supabase/seed-my-data.sql` (this file is gitignored — it has real numbers and stays local to your machine, never pushed).
3. Refresh the site — your positions and targets should appear.
4. Add this month's actual executed orders yourself via the "Record a purchase" form once you know the real filled amounts.

## Local development

```bash
cp .env.example .env   # fill in your Supabase URL + anon key
npm install
npm run dev
```

Visitor mode works with zero configuration — if `.env` is missing, the app just runs without login, local-storage only.

## Files

- `src/portfolio.js` — pure calculation logic (gain, allocation, investment-split gap-fill), ported directly from the project's `track.py` CLI tool. Keep the two in sync if you change one.
- `src/storage.js` — the only place that talks to Supabase or localStorage; the rest of the app doesn't know which one it's using.
- `scripts/refresh-prices.mjs` — the price fetcher, runs both locally (`npm run refresh-prices`) and in the GitHub Action.
- `supabase/schema.sql` — safe to re-run, all statements are idempotent.
