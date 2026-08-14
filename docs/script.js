// ---------------------------------------------------------------------------
// Verdant Ledger — dashboard + concierge chat
//
// SETUP: after deploying the Cloudflare Worker (see repo root README.md),
// paste its base URL below. The worker exposes:
//   POST {WORKER_URL}         -> runs the real five-agent pipeline live
//   POST {WORKER_URL}/chat    -> concierge Q&A / run-trigger classification
// Until configured, the dashboard still shows the last committed
// docs/results.json (a real, previously executed run) and the chat panel
// explains that live mode isn't wired up yet.
// ---------------------------------------------------------------------------

const WORKER_URL = ""; // e.g. "https://verdant-ledger-pipeline.YOUR_SUBDOMAIN.workers.dev"

let currentTranscript = null;
let chatHistory = [];

// ---- DOM refs ----
const el = {
  liveDot: document.getElementById("liveDot"),
  topbarStatusText: document.getElementById("topbarStatusText"),
  metricTotal: document.getElementById("metricTotal"),
  metricVerdict: document.getElementById("metricVerdict"),
  metricVerdictSub: document.getElementById("metricVerdictSub"),
  metricGrid: document.getElementById("metricGrid"),
  chartArea: document.getElementById("chartArea"),
  stepper: document.getElementById("stepper"),
  runButton: document.getElementById("runButton"),
  detailPanel: document.getElementById("detailPanel"),
  detailArea: document.getElementById("detailArea"),
  chatLog: document.getElementById("chatLog"),
  chatForm: document.getElementById("chatForm"),
  chatInput: document.getElementById("chatInput"),
};

// ---------------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------------

function resetStepper() {
  el.stepper.querySelectorAll(".stepper__step").forEach((step) => {
    step.classList.remove("is-active", "is-done");
  });
}

function setStepState(agentName, state) {
  const step = el.stepper.querySelector(`[data-agent="${agentName}"]`);
  if (!step) return;
  step.classList.remove("is-active", "is-done");
  if (state) step.classList.add(state);
}

function markAllStepsDone() {
  el.stepper.querySelectorAll(".stepper__step").forEach((step) => {
    step.classList.remove("is-active");
    step.classList.add("is-done");
  });
}

function findStepOutput(transcript, agentName) {
  const step = transcript.steps.find((s) => s.agent === agentName);
  return step ? step.output : null;
}

function renderChart(categories) {
  el.chartArea.innerHTML = "";
  if (!categories || !categories.length) {
    el.chartArea.innerHTML =
      '<p class="empty-note">No calculation yet — run the pipeline to populate this chart.</p>';
    return;
  }
  const max = Math.max(...categories.map((c) => c.kgco2e || 0), 1);
  categories.forEach((c) => {
    const row = document.createElement("div");
    row.className = "chart-bar-row";
    row.innerHTML = `
      <span class="chart-bar-row__label">${escapeHtml(c.category)}</span>
      <span class="chart-bar-row__track"><span class="chart-bar-row__fill"></span></span>
      <span class="chart-bar-row__value">${formatNumber(c.kgco2e)} kg</span>
    `;
    el.chartArea.appendChild(row);
    requestAnimationFrame(() => {
      const pct = Math.max(4, Math.round(((c.kgco2e || 0) / max) * 100));
      row.querySelector(".chart-bar-row__fill").style.width = pct + "%";
    });
  });
}

function renderDetails(transcript) {
  el.detailArea.innerHTML = "";
  el.detailPanel.hidden = false;
  transcript.steps.forEach((step) => {
    const item = document.createElement("details");
    item.className = "detail-item";
    item.innerHTML = `
      <summary>${step.agent} — output</summary>
      <pre>${escapeHtml(JSON.stringify(step.output, null, 2))}</pre>
    `;
    el.detailArea.appendChild(item);
  });
}

function renderTranscript(transcript) {
  currentTranscript = transcript;

  const makerOutput = findStepOutput(transcript, "Maker");
  const managerOutput = findStepOutput(transcript, "Manager");
  const researcherOutput = findStepOutput(transcript, "Researcher");

  el.metricTotal.textContent = makerOutput
    ? formatNumber(makerOutput.total_estimated_kgco2e)
    : "—";

  el.metricVerdict.textContent = managerOutput ? managerOutput.assurance_verdict : "—";
  el.metricVerdictSub.textContent = transcript.run_finished_utc
    ? `as of ${new Date(transcript.run_finished_utc).toLocaleString()}`
    : "awaiting first run";

  const gridValue =
    researcherOutput?.grid_context?.actual_intensity ??
    researcherOutput?.grid_context?.forecast_intensity ??
    null;
  el.metricGrid.textContent = gridValue !== null && gridValue !== undefined ? gridValue : "see detail";

  renderChart(makerOutput?.emissions_by_category);
  renderDetails(transcript);
  markAllStepsDone();

  el.topbarStatusText.textContent = `Certified run · ${new Date(
    transcript.run_finished_utc
  ).toLocaleString()}`;
  el.liveDot.classList.remove("is-live");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatNumber(n) {
  if (typeof n !== "number") return String(n ?? "—");
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

// ---------------------------------------------------------------------------
// Live pipeline run (button OR chat-triggered)
// ---------------------------------------------------------------------------

async function runPipelineLive({ silent } = { silent: false }) {
  if (!WORKER_URL) {
    if (!silent) addChatMessage("bot", "Live runs aren't wired up yet — set WORKER_URL in docs/script.js once the Cloudflare Worker is deployed (see README).");
    return null;
  }

  el.runButton.disabled = true;
  el.runButton.classList.add("is-running");
  el.liveDot.classList.add("is-live");
  el.topbarStatusText.textContent = "Running live...";
  resetStepper();

  const agentOrder = ["Researcher", "Designer", "Maker", "Communicator", "Manager"];
  let stepIndex = 0;
  setStepState(agentOrder[0], "is-active");
  const stepTimer = setInterval(() => {
    if (stepIndex < agentOrder.length - 1) {
      setStepState(agentOrder[stepIndex], "is-done");
      stepIndex++;
      setStepState(agentOrder[stepIndex], "is-active");
    }
  }, 3200); // approximate pacing while we wait for the real response

  try {
    const resp = await fetch(WORKER_URL, { method: "POST" });
    if (!resp.ok) throw new Error(`Worker returned ${resp.status}`);
    const transcript = await resp.json();
    clearInterval(stepTimer);
    renderTranscript(transcript);
    return transcript;
  } catch (err) {
    clearInterval(stepTimer);
    el.topbarStatusText.textContent = `Run failed: ${err.message}`;
    if (!silent) addChatMessage("bot", `The live run failed: ${err.message}`);
    return null;
  } finally {
    el.runButton.disabled = false;
    el.runButton.classList.remove("is-running");
  }
}

el.runButton.addEventListener("click", () => runPipelineLive({ silent: false }));

// ---------------------------------------------------------------------------
// Chat / concierge
// ---------------------------------------------------------------------------

function addChatMessage(role, text) {
  const div = document.createElement("div");
  div.className = `chat__msg chat__msg--${role}`;
  div.textContent = text;
  el.chatLog.appendChild(div);
  el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

async function sendChatMessage(message) {
  addChatMessage("user", message);
  chatHistory.push({ role: "user", content: message });
  el.chatInput.value = "";
  el.chatInput.disabled = true;

  if (!WORKER_URL) {
    addChatMessage(
      "bot",
      "Live chat isn't wired up yet — set WORKER_URL in docs/script.js once the Cloudflare Worker is deployed (see README). Until then, I can only show you the last committed run in the dashboard."
    );
    el.chatInput.disabled = false;
    el.chatInput.focus();
    return;
  }

  try {
    const resp = await fetch(WORKER_URL + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: currentTranscript,
        message,
        history: chatHistory.slice(-10),
      }),
    });
    if (!resp.ok) throw new Error(`Worker returned ${resp.status}`);
    const reply = await resp.json();

    addChatMessage("bot", reply.message);
    chatHistory.push({ role: "assistant", content: reply.message });

    if (reply.action === "run_pipeline") {
      addChatMessage("system", "Starting a live pipeline run...");
      const transcript = await runPipelineLive({ silent: true });
      if (transcript) {
        addChatMessage(
          "bot",
          `Done — total footprint came out to ${formatNumber(
            findStepOutput(transcript, "Maker")?.total_estimated_kgco2e
          )} kg CO₂e, verdict: ${findStepOutput(transcript, "Manager")?.assurance_verdict}. Ask me anything about it.`
        );
      } else {
        addChatMessage("bot", "The live run didn't complete — check the dashboard status above.");
      }
    }
  } catch (err) {
    addChatMessage("bot", `Something went wrong: ${err.message}`);
  } finally {
    el.chatInput.disabled = false;
    el.chatInput.focus();
  }
}

el.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = el.chatInput.value.trim();
  if (!value) return;
  sendChatMessage(value);
});

// ---------------------------------------------------------------------------
// Initial load — show last committed run, if any
// ---------------------------------------------------------------------------

async function loadCachedResults() {
  try {
    const resp = await fetch("results.json", { cache: "no-store" });
    if (!resp.ok) throw new Error("no cached results yet");
    const transcript = await resp.json();
    renderTranscript(transcript);
  } catch (err) {
    el.topbarStatusText.textContent = "No run yet — press \u201cRun pipeline live\u201d";
  }
}

loadCachedResults();
