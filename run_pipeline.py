"""
Verdant Ledger — Agentic Carbon Accounting Pipeline
Local orchestrator for development, testing, and generating the transcript
evidence used in the project submission.

Pipeline: Researcher -> Designer -> Maker -> Communicator -> Manager

Live data sources (queried at runtime, never hardcoded):
  1. National Grid ESO Carbon Intensity API (no key required)
     https://api.carbonintensity.org.uk/intensity
  2. Client activity data — a published Google Sheet, read live via its
     public CSV export URL (no service-account key required)

LLM backend: Google Gemini API (generativelanguage.googleapis.com), used via
plain HTTPS requests — no SDK dependency required. Get a free key with no
credit card at https://aistudio.google.com/apikey. Note: on the free tier,
Google's terms permit using your prompts/responses to improve their models —
worth naming in your submission's Regulatory & Ethical section, since this
pipeline processes (synthetic) client emissions data.

Requires:
  pip install requests

Environment variables (see .env.example):
  GOOGLE_API_KEY
  CLIENT_SHEET_CSV_URL   (the "publish to web" CSV link for your Google Sheet)
"""

import os
import json
import csv
import io
import datetime
import requests

MODEL = "gemini-3.5-flash"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "agents", "prompts")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "data", "run_outputs")
DOCS_RESULTS_PATH = os.path.join(os.path.dirname(__file__), "docs", "results.json")

CARBON_INTENSITY_URL = "https://api.carbonintensity.org.uk/intensity"

# ---------------------------------------------------------------------------
# Strict output schemas — one per agent. Passing these as response_schema
# switches Gemini to grammar-constrained JSON generation, which cannot
# produce syntactically invalid JSON (unlike responseMimeType alone, which
# is closer to an instruction than a hard guarantee).
# ---------------------------------------------------------------------------

SCHEMAS = {
    "researcher": {
        "type": "OBJECT",
        "properties": {
            "headline_finding": {"type": "STRING"},
            "scope_breakdown": {"type": "STRING"},
            "regulatory_exposure": {"type": "STRING"},
            "grid_context": {
                "type": "OBJECT",
                "properties": {
                    "actual_intensity": {"type": "NUMBER"},
                    "forecast_intensity": {"type": "NUMBER"},
                    "commentary": {"type": "STRING"},
                },
                "required": ["commentary"],
            },
            "opportunity_summary": {"type": "STRING"},
        },
        "required": [
            "headline_finding",
            "scope_breakdown",
            "regulatory_exposure",
            "grid_context",
            "opportunity_summary",
        ],
    },
    "designer": {
        "type": "OBJECT",
        "properties": {
            "chosen_framework": {"type": "STRING"},
            "product_concept": {"type": "STRING"},
            "required_inputs": {"type": "ARRAY", "items": {"type": "STRING"}},
            "output_requirements": {"type": "STRING"},
            "ux_principles": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": [
            "chosen_framework",
            "product_concept",
            "required_inputs",
            "output_requirements",
            "ux_principles",
        ],
    },
    "maker": {
        "type": "OBJECT",
        "properties": {
            "total_estimated_kgco2e": {"type": "NUMBER"},
            "emissions_by_category": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "category": {"type": "STRING"},
                        "kgco2e": {"type": "NUMBER"},
                    },
                    "required": ["category", "kgco2e"],
                },
            },
            "calculation_trace": {"type": "ARRAY", "items": {"type": "STRING"}},
            "data_sources": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "source": {"type": "STRING"},
                        "fetched_at_utc": {"type": "STRING"},
                    },
                    "required": ["source", "fetched_at_utc"],
                },
            },
            "confidence_notes": {"type": "STRING"},
            "headline_for_client": {"type": "STRING"},
        },
        "required": [
            "total_estimated_kgco2e",
            "emissions_by_category",
            "calculation_trace",
            "data_sources",
            "confidence_notes",
            "headline_for_client",
        ],
    },
    "communicator": {
        "type": "OBJECT",
        "properties": {
            "client_summary": {"type": "STRING"},
            "public_disclosure_snippet": {"type": "STRING"},
            "marketing_angle": {"type": "STRING"},
            "caveats_to_retain": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": [
            "client_summary",
            "public_disclosure_snippet",
            "marketing_angle",
            "caveats_to_retain",
        ],
    },
    "manager": {
        "type": "OBJECT",
        "properties": {
            "engagement_summary": {"type": "STRING"},
            "consistency_check": {"type": "STRING"},
            "strategic_alignment": {"type": "STRING"},
            "assurance_verdict": {
                "type": "STRING",
                "enum": ["Certified", "Certified with caveats", "Not ready for release"],
            },
            "next_steps": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": [
            "engagement_summary",
            "consistency_check",
            "strategic_alignment",
            "assurance_verdict",
            "next_steps",
        ],
    },
}


def load_prompt(filename: str) -> str:
    """Load an agent's system prompt from its markdown file.
    Only the content under '## System Prompt' is sent to the model."""
    path = os.path.join(PROMPTS_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    marker = "## System Prompt"
    if marker in text:
        text = text.split(marker, 1)[1]
    return text.strip()


def fetch_live_carbon_intensity() -> dict:
    """LIVE call — queried at the moment of use, never cached or hardcoded."""
    resp = requests.get(CARBON_INTENSITY_URL, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    return {
        "source": CARBON_INTENSITY_URL,
        "fetched_at_utc": datetime.datetime.utcnow().isoformat() + "Z",
        "raw": data,
    }


def fetch_live_client_activity_data() -> dict:
    """LIVE call — reads the client's synthetic activity data from a published
    Google Sheet CSV export at query time. The sheet is the source of truth;
    nothing here is copied into code."""
    sheet_url = os.environ.get("CLIENT_SHEET_CSV_URL")
    if not sheet_url:
        raise RuntimeError(
            "CLIENT_SHEET_CSV_URL is not set. Publish your Google Sheet to the "
            "web (File > Share > Publish to web > CSV) and set the env var."
        )
    resp = requests.get(sheet_url, timeout=15)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    rows = list(reader)
    return {
        "source": sheet_url,
        "fetched_at_utc": datetime.datetime.utcnow().isoformat() + "Z",
        "rows": rows,
    }


def call_agent(api_key: str, system_prompt: str, user_payload: dict, schema: dict) -> dict:
    """Call one agent with its system prompt and the prior agent's structured
    output (or the initial live data), and parse its JSON response.

    Uses Gemini's responseSchema (grammar-constrained JSON generation) so the
    model cannot produce syntactically invalid JSON, plus responseMimeType
    as a belt-and-suspenders instruction."""
    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": (
                            "Here is your input for this engagement, as JSON.\n\n"
                            + json.dumps(user_payload, indent=2)
                        )
                    }
                ],
            }
        ],
        "generationConfig": {
            "maxOutputTokens": 4000,
            "responseMimeType": "application/json",
            "responseSchema": schema,
            "thinkingConfig": {"thinkingLevel": "low"},
        },
    }
    resp = requests.post(
        GEMINI_URL,
        params={"key": api_key},
        json=body,
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    raw_text = data["candidates"][0]["content"]["parts"][0]["text"]
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError as parse_err:
        raise RuntimeError(
            f"JSON parse failed ({parse_err}). Raw model output (first 1500 chars): "
            f"{raw_text[:1500]}"
        ) from parse_err


def run_pipeline() -> dict:
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GOOGLE_API_KEY is not set. Get a free key at "
            "https://aistudio.google.com/apikey and add it to your .env file."
        )
    run_started = datetime.datetime.utcnow().isoformat() + "Z"

    print("Fetching live data sources...")
    grid_intensity = fetch_live_carbon_intensity()
    client_activity = fetch_live_client_activity_data()

    transcript = {"run_started_utc": run_started, "steps": []}

    # 1. Researcher
    print("Agent 1/5 — Researcher (Vera Sonnet)...")
    researcher_prompt = load_prompt("01_researcher.md")
    researcher_input = {
        "client_activity_data": client_activity,
        "live_grid_carbon_intensity": grid_intensity,
    }
    researcher_output = call_agent(api_key, researcher_prompt, researcher_input, SCHEMAS["researcher"])
    transcript["steps"].append(
        {"agent": "Researcher", "input": researcher_input, "output": researcher_output}
    )

    # 2. Designer
    print("Agent 2/5 — Designer (Idris Halden)...")
    designer_prompt = load_prompt("02_designer.md")
    designer_output = call_agent(api_key, designer_prompt, researcher_output, SCHEMAS["designer"])
    transcript["steps"].append(
        {"agent": "Designer", "input": researcher_output, "output": designer_output}
    )

    # 3. Maker
    print("Agent 3/5 — Maker (Priya Okafor)...")
    maker_prompt = load_prompt("03_maker.md")
    maker_input = {
        "solution_specification": designer_output,
        "client_activity_data": client_activity,
        "live_grid_carbon_intensity": grid_intensity,
    }
    maker_output = call_agent(api_key, maker_prompt, maker_input, SCHEMAS["maker"])
    transcript["steps"].append(
        {"agent": "Maker", "input": maker_input, "output": maker_output}
    )

    # 4. Communicator
    print("Agent 4/5 — Communicator (Sam Rourke)...")
    communicator_prompt = load_prompt("04_communicator.md")
    communicator_output = call_agent(api_key, communicator_prompt, maker_output, SCHEMAS["communicator"])
    transcript["steps"].append(
        {"agent": "Communicator", "input": maker_output, "output": communicator_output}
    )

    # 5. Manager
    print("Agent 5/5 — Manager (Odalys Fenn)...")
    manager_prompt = load_prompt("05_manager.md")
    manager_input = {
        "opportunity_brief": researcher_output,
        "solution_specification": designer_output,
        "calculation_result": maker_output,
        "disclosure_and_messaging_package": communicator_output,
    }
    manager_output = call_agent(api_key, manager_prompt, manager_input, SCHEMAS["manager"])
    transcript["steps"].append(
        {"agent": "Manager", "input": manager_input, "output": manager_output}
    )

    transcript["run_finished_utc"] = datetime.datetime.utcnow().isoformat() + "Z"
    transcript["final_output"] = manager_output

    return transcript


def save_outputs(transcript: dict) -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    ts = transcript["run_started_utc"].replace(":", "-")
    run_path = os.path.join(OUTPUT_DIR, f"run_{ts}.json")
    with open(run_path, "w", encoding="utf-8") as f:
        json.dump(transcript, f, indent=2)
    print(f"Saved full transcript to {run_path}")

    # Copy the latest run to docs/results.json so the GitHub Pages site
    # can display a real, previously-executed run even without the
    # "Run live" button being pressed.
    with open(DOCS_RESULTS_PATH, "w", encoding="utf-8") as f:
        json.dump(transcript, f, indent=2)
    print(f"Updated {DOCS_RESULTS_PATH} for the GitHub Pages demo")


if __name__ == "__main__":
    result = run_pipeline()
    save_outputs(result)
    print("\nFinal Manager verdict:")
    print(json.dumps(result["final_output"], indent=2))
