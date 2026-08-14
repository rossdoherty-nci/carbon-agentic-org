# Data

This folder does **not** contain the live data source used by the pipeline —
that would defeat the point. It contains:

- `client_sample_for_sheet.csv` — sample synthetic client activity data.
  **Paste this into a new Google Sheet**, then publish that sheet to the web
  as CSV (`File > Share > Publish to web > CSV`). Put the resulting URL in
  `CLIENT_SHEET_CSV_URL` (see root `.env.example` and `worker/wrangler.toml`).
  The Researcher and Maker agents fetch that published URL live, at query
  time, every run — this file is only the starting content for the sheet,
  never read directly by the code.

- `run_outputs/` — timestamped full transcripts from real pipeline runs
  (created automatically by `run_pipeline.py`). These are the evidence for
  the "Pipeline in Action" section of the submission — genuine saved output,
  not fabricated for the write-up.
