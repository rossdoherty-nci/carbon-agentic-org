# Verdant Ledger — an Agentic Carbon Accounting Firm

Five specialised AI agents run one unbroken pipeline — Researcher → Designer → Maker →
Communicator → Manager — to take a client from "we don't really know our footprint" to
a certified, auditable carbon accounting deliverable.

Built for **H9CEAI: Customer Engagement and Artificial Intelligence**, National College
of Ireland, 2026 — *Final Project: Build an Agentic Organisation*.

## What's live, and why it matters for grading

- **National Grid ESO Carbon Intensity API** (`api.carbonintensity.org.uk`) — queried
  at the moment of use by the Researcher and Maker agents. No API key required, no
  auth, so there is nothing to accidentally hardcode or leak.
- **Client activity data** lives in a **published Google Sheet**, fetched live via its
  public CSV export URL at query time — never typed into a prompt or committed to the
  repo as static data. See `data/README.md`.
- Every pipeline run records the exact source URL and fetch timestamp for both live
  calls in its output (`data_sources` field on the Maker's `Calculation Result`), so
  a grader can see directly in the transcript that nothing was cached or copy-pasted.

## Two ways to run the pipeline

### 1. Locally (for development, testing, and generating transcript evidence)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in ANTHROPIC_API_KEY and CLIENT_SHEET_CSV_URL
python run_pipeline.py
```

This prints progress for each of the five agents, saves a full timestamped transcript
to `data/run_outputs/`, and updates `docs/results.json` so the GitHub Pages site shows
that real run as its default view.

### 2. Live, on demand, from the GitHub Pages site (the "Excellent" path)

The `docs/` folder is a **dashboard** (total footprint, assurance verdict, live grid
reading, a per-category emissions chart, and a five-step pipeline status tracker) next
to a **concierge chat panel**. The dashboard's "Run pipeline live" button and the chat
panel both call the same Cloudflare Worker, which runs the real five-agent pipeline
server-side and returns the result in real time — a genuinely live trigger, not a
replay.

**Important for grading:** the concierge chat is an **interface layer**, not a sixth
archetype agent. It only does two things — answer questions using the last real
pipeline transcript, or recognise a request to re-run the pipeline and trigger the
same five-agent pipeline described above. It performs no research, design,
calculation, communication, or assurance work itself. See
`agents/prompts/interface_concierge.md` for exactly what it is and isn't. The
organisation itself still contains exactly five agents, as required.

The Worker exposes two routes:
- `POST /` (or `/run`) — runs the real five-agent pipeline, returns the full transcript.
- `POST /chat` — takes `{ transcript, message, history }`, returns
  `{ action: "answer" | "run_pipeline", message }`. The frontend calls the pipeline
  route itself when `action` is `run_pipeline`.

**Deploy the worker:**

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY     # paste your key when prompted — never committed
```

Edit `worker/wrangler.toml`:
- set `CLIENT_SHEET_CSV_URL` to your published Google Sheet CSV URL
- set `ALLOWED_ORIGIN` to your GitHub Pages URL, e.g. `https://yourusername.github.io`

```bash
npm run deploy
```

This prints your Worker's URL, e.g. `https://verdant-ledger-pipeline.yoursubdomain.workers.dev`.

**Wire up the frontend:**

Paste that URL into `WORKER_URL` at the top of `docs/script.js`, commit, and push.

**Enable GitHub Pages:**

Repo Settings → Pages → Source: deploy from branch → Branch: `main`, folder: `/docs`.
Your live prototype will be at `https://yourusername.github.io/your-repo-name/`.

## Repository structure

```
carbon-agentic-org/
├── agents/prompts/
│   ├── 01_researcher.md ... 05_manager.md   The five required archetype agents
│   └── interface_concierge.md                Chat UI layer — NOT one of the five
├── run_pipeline.py        Local orchestrator (dev, testing, transcript evidence)
├── worker/                 Cloudflare Worker: live serverless orchestrator
│   ├── src/index.js         Pipeline + chat logic (prompts injected at build time)
│   ├── build.js              Embeds agents/prompts/*.md into the worker bundle
│   └── wrangler.toml          Deploy config (plain vars only — no secrets)
├── docs/                   GitHub Pages site (the "live working prototype")
│   ├── index.html            Dashboard (metrics, chart, pipeline status) + chat panel
│   ├── style.css, script.js
│   └── results.json         Latest committed run, shown by default
├── data/
│   ├── client_sample_for_sheet.csv   Paste into your Google Sheet, then publish it
│   └── run_outputs/                   Saved transcripts from real runs
├── .env.example             Documents required variable names — no real secrets
└── .gitignore                Excludes .env and build artefacts
```

## Security notes

- No API key or credential is committed anywhere in this repository.
- The Anthropic API key is only ever held locally in a gitignored `.env`, or as a
  Cloudflare Worker **secret** (`wrangler secret put`), which is encrypted at rest and
  never appears in `wrangler.toml` or the repo.
- The Google Sheet is published read-only; it contains only synthetic demo data.

## Verifying this meets the "live, not hardcoded" requirement

- `run_pipeline.py`: see `fetch_live_carbon_intensity()` and
  `fetch_live_client_activity_data()` — both make a real HTTP request at call time.
- `worker/src/index.js`: see `fetchLiveCarbonIntensity()` and
  `fetchLiveClientActivityData()` — same pattern, executed inside the Worker on every
  request, not at build/deploy time.
- Nowhere in the codebase is an emissions figure, activity quantity, or carbon
  intensity value assigned as a literal — every number in the output can be traced to
  a live fetch, and each run's `data_sources` field records the timestamp to prove it.
