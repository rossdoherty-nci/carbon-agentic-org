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

// ---------------------------------------------------------------------------
// Strict output schemas — one per agent. Passing these as responseSchema
// switches Gemini to grammar-constrained JSON generation, which cannot
// produce syntactically invalid JSON (unlike responseMimeType alone, which
// is closer to an instruction than a hard guarantee).
// ---------------------------------------------------------------------------

const SCHEMAS = {
  researcher: {
    type: "OBJECT",
    properties: {
      headline_finding: { type: "STRING" },
      scope_breakdown: { type: "STRING" },
      regulatory_exposure: { type: "STRING" },
      grid_context: {
        type: "OBJECT",
        properties: {
          actual_intensity: { type: "NUMBER" },
          forecast_intensity: { type: "NUMBER" },
          commentary: { type: "STRING" },
        },
        required: ["commentary"],
      },
      opportunity_summary: { type: "STRING" },
    },
    required: [
      "headline_finding",
      "scope_breakdown",
      "regulatory_exposure",
      "grid_context",
      "opportunity_summary",
    ],
  },

  designer: {
    type: "OBJECT",
    properties: {
      chosen_framework: { type: "STRING" },
      product_concept: { type: "STRING" },
      required_inputs: { type: "ARRAY", items: { type: "STRING" } },
      output_requirements: { type: "STRING" },
      ux_principles: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: [
      "chosen_framework",
      "product_concept",
      "required_inputs",
      "output_requirements",
      "ux_principles",
    ],
  },

  maker: {
    type: "OBJECT",
    properties: {
      total_estimated_kgco2e: { type: "NUMBER" },
      emissions_by_category: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            category: { type: "STRING" },
            kgco2e: { type: "NUMBER" },
          },
          required: ["category", "kgco2e"],
        },
      },
      calculation_trace: { type: "ARRAY", items: { type: "STRING" } },
      data_sources: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            source: { type: "STRING" },
            fetched_at_utc: { type: "STRING" },
          },
          required: ["source", "fetched_at_utc"],
        },
      },
      confidence_notes: { type: "STRING" },
      headline_for_client: { type: "STRING" },
    },
    required: [
      "total_estimated_kgco2e",
      "emissions_by_category",
      "calculation_trace",
      "data_sources",
      "confidence_notes",
      "headline_for_client",
    ],
  },

  communicator: {
    type: "OBJECT",
    properties: {
      client_summary: { type: "STRING" },
      public_disclosure_snippet: { type: "STRING" },
      marketing_angle: { type: "STRING" },
      caveats_to_retain: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: [
      "client_summary",
      "public_disclosure_snippet",
      "marketing_angle",
      "caveats_to_retain",
    ],
  },

  manager: {
    type: "OBJECT",
    properties: {
      engagement_summary: { type: "STRING" },
      consistency_check: { type: "STRING" },
      strategic_alignment: { type: "STRING" },
      assurance_verdict: {
        type: "STRING",
        enum: ["Certified", "Certified with caveats", "Not ready for release"],
      },
      next_steps: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: [
      "engagement_summary",
      "consistency_check",
      "strategic_alignment",
      "assurance_verdict",
      "next_steps",
    ],
  },

  concierge: {
    type: "OBJECT",
    properties: {
      action: { type: "STRING", enum: ["answer", "run_pipeline"] },
      message: { type: "STRING" },
    },
    required: ["action", "message"],
  },
};

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

async function callAgent(env, systemPrompt, userPayload, schema) {
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
      generationConfig: {
        maxOutputTokens: 4000,
        responseMimeType: "application/json",
        responseSchema: schema,
        thinkingConfig: { thinkingLevel: "low" },
      },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  const text = data.candidates[0].content.parts[0].text;
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    // Safety net: if parsing ever fails again despite the schema, surface
    // the raw model output so the actual problem is visible immediately
    // instead of needing another round of guesswork.
    throw new Error(
      `JSON parse failed (${parseErr.message}). Raw model output (first 1500 chars): ${text.slice(0, 1500)}`
    );
  }
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
  const researcherOutput = await callAgent(env, PROMPTS.researcher, researcherInput, SCHEMAS.researcher);
  steps.push({ agent: "Researcher", input: researcherInput, output: researcherOutput });

  const designerOutput = await callAgent(env, PROMPTS.designer, researcherOutput, SCHEMAS.designer);
  steps.push({ agent: "Designer", input: researcherOutput, output: designerOutput });

  const makerInput = {
    solution_specification: designerOutput,
    client_activity_data: clientActivity,
    live_grid_carbon_intensity: gridIntensity,
  };
  const makerOutput = await callAgent(env, PROMPTS.maker, makerInput, SCHEMAS.maker);
  steps.push({ agent: "Maker", input: makerInput, output: makerOutput });

  const communicatorOutput = await callAgent(env, PROMPTS.communicator, makerOutput, SCHEMAS.communicator);
  steps.push({ agent: "Communicator", input: makerOutput, output: communicatorOutput });

  const managerInput = {
    opportunity_brief: researcherOutput,
    solution_specification: designerOutput,
    calculation_result: makerOutput,
    disclosure_and_messaging_package: communicatorOutput,
  };
  const managerOutput = await callAgent(env, PROMPTS.manager, managerInput, SCHEMAS.manager);
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
      generationConfig: {
        maxOutputTokens: 800,
        responseMimeType: "application/json",
        responseSchema: SCHEMAS.concierge,
        thinkingConfig: { thinkingLevel: "low" },
      },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  const text = data.candidates[0].content.parts[0].text;
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    throw new Error(
      `JSON parse failed (${parseErr.message}). Raw model output (first 1500 chars): ${text.slice(0, 1500)}`
    );
  }
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
