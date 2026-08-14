/**
 * Verdant Ledger — live pipeline runner
 *
 * Deployed as a Cloudflare Worker. Called by the "Run pipeline live" button
 * (and the concierge chat) on the GitHub Pages frontend. Runs the same
 * five-agent pipeline as run_pipeline.py, but on demand, in the browser's
 * request path.
 *
 * LLM backend: Google Gemini API. Get a free key (no credit card) at
 * https://aistudio.google.com/apikey. Note: on the free tier, Google's terms
 * permit using your prompts/responses to improve their models — worth naming
 * in your submission's Regulatory & Ethical section.
 *
 * Secrets (set with `wrangler secret put`, NEVER committed to the repo):
 *   GOOGLE_API_KEY
 *
 * Plain vars (safe to keep in wrangler.toml, not secret):
 *   CLIENT_SHEET_CSV_URL  — published Google Sheet CSV export URL
 *   ALLOWED_ORIGIN        — your GitHub Pages origin, for CORS
 */

const MODEL = "gemini-3.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const CARBON_INTENSITY_URL = "https://api.carbonintensity.org.uk/intensity";

const PROMPTS = {
  researcher: __RESEARCHER_PROMPT__,
  designer: __DESIGNER_PROMPT__,
  maker: __MAKER_PROMPT__,
  communicator: __COMMUNICATOR_PROMPT__,
  manager: __MANAGER_PROMPT__,
  // Interface layer only — not one of the five archetype agents. See
  // agents/prompts/interface_concierge.md for why this is kept separate.
  concierge: __CONCIERGE_PROMPT__,
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function fetchLiveCarbonIntensity() {
  const resp = await fetch(CARBON_INTENSITY_URL);
  if (!resp.ok) throw new Error(`Carbon Intensity API failed: ${resp.status}`);
  const raw = await resp.json();
  return {
    source: CARBON_INTENSITY_URL,
    fetched_at_utc: new Date().toISOString(),
    raw,
  };
}

function parseCsv(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((h, i) => (row[h] = (cells[i] || "").trim()));
    return row;
  });
}

async function fetchLiveClientActivityData(env) {
  const sheetUrl = env.CLIENT_SHEET_CSV_URL;
  if (!sheetUrl) throw new Error("CLIENT_SHEET_CSV_URL is not configured");
  const resp = await fetch(sheetUrl);
  if (!resp.ok) throw new Error(`Client sheet fetch failed: ${resp.status}`);
  const text = await resp.text();
  return {
    source: sheetUrl,
    fetched_at_utc: new Date().toISOString(),
    rows: parseCsv(text),
  };
}

async function callAgent(env, systemPrompt, userPayload) {
  // responseMimeType: "application/json" makes Gemini return clean JSON
  // directly — no markdown fences to strip.
  const resp = await fetch(`${GEMINI_URL}?key=${env.GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Here is your input for this engagement, as JSON.\n\n" +
                JSON.stringify(userPayload, null, 2),
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 2000, responseMimeType: "application/json" },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

async function runPipeline(env) {
  const runStarted = new Date().toISOString();
  const [gridIntensity, clientActivity] = await Promise.all([
    fetchLiveCarbonIntensity(),
    fetchLiveClientActivityData(env),
  ]);

  const steps = [];

  const researcherInput = {
    client_activity_data: clientActivity,
    live_grid_carbon_intensity: gridIntensity,
  };
  const researcherOutput = await callAgent(env, PROMPTS.researcher, researcherInput);
  steps.push({ agent: "Researcher", input: researcherInput, output: researcherOutput });

  const designerOutput = await callAgent(env, PROMPTS.designer, researcherOutput);
  steps.push({ agent: "Designer", input: researcherOutput, output: designerOutput });

  const makerInput = {
    solution_specification: designerOutput,
    client_activity_data: clientActivity,
    live_grid_carbon_intensity: gridIntensity,
  };
  const makerOutput = await callAgent(env, PROMPTS.maker, makerInput);
  steps.push({ agent: "Maker", input: makerInput, output: makerOutput });

  const communicatorOutput = await callAgent(env, PROMPTS.communicator, makerOutput);
  steps.push({ agent: "Communicator", input: makerOutput, output: communicatorOutput });

  const managerInput = {
    opportunity_brief: researcherOutput,
    solution_specification: designerOutput,
    calculation_result: makerOutput,
    disclosure_and_messaging_package: communicatorOutput,
  };
  const managerOutput = await callAgent(env, PROMPTS.manager, managerInput);
  steps.push({ agent: "Manager", input: managerInput, output: managerOutput });

  return {
    run_started_utc: runStarted,
    run_finished_utc: new Date().toISOString(),
    steps,
    final_output: managerOutput,
  };
}

async function runConcierge(env, transcript, visitorMessage, history) {
  const payload = {
    most_recent_pipeline_run: transcript || null,
    visitor_message: visitorMessage,
    recent_chat_history: history || [],
  };
  const resp = await fetch(`${GEMINI_URL}?key=${env.GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: PROMPTS.concierge }] },
      contents: [
        { role: "user", parts: [{ text: JSON.stringify(payload, null, 2) }] },
      ],
      generationConfig: { maxOutputTokens: 400, responseMimeType: "application/json" },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text);
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Use POST /run or POST /chat" }),
        { status: 405, headers: corsHeaders(origin) }
      );
    }

    try {
      if (url.pathname === "/chat") {
        const body = await request.json();
        const conciergeReply = await runConcierge(
          env,
          body.transcript,
          body.message,
          body.history
        );
        return new Response(JSON.stringify(conciergeReply), {
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }

      // Default route ("/", "/run", anything else) runs the real five-agent
      // pipeline. This is the same logic whether triggered by the dashboard
      // button or by the concierge deciding action: "run_pipeline".
      const result = await runPipeline(env);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
  },
};
