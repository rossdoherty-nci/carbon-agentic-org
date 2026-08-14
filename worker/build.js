/**
 * Build step: injects the five agent system prompts (from
 * ../agents/prompts/*.md) into src/index.js as string literals, producing
 * dist/index.js. Cloudflare Workers have no filesystem access at runtime,
 * so the prompts must be bundled in at build time.
 *
 * Run with: npm run build   (then: npm run deploy)
 */

const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = path.join(__dirname, "..", "agents", "prompts");
const SRC_PATH = path.join(__dirname, "src", "index.js");
const DIST_DIR = path.join(__dirname, "dist");
const DIST_PATH = path.join(DIST_DIR, "index.js");

function loadPrompt(filename) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, filename), "utf-8");
  const marker = "## System Prompt";
  const body = text.includes(marker) ? text.split(marker)[1] : text;
  return body.trim();
}

function jsStringLiteral(str) {
  return JSON.stringify(str);
}

const replacements = {
  __RESEARCHER_PROMPT__: loadPrompt("01_researcher.md"),
  __DESIGNER_PROMPT__: loadPrompt("02_designer.md"),
  __MAKER_PROMPT__: loadPrompt("03_maker.md"),
  __COMMUNICATOR_PROMPT__: loadPrompt("04_communicator.md"),
  __MANAGER_PROMPT__: loadPrompt("05_manager.md"),
  // Interface layer only — not one of the five archetype agents.
  __CONCIERGE_PROMPT__: loadPrompt("interface_concierge.md"),
};

let source = fs.readFileSync(SRC_PATH, "utf-8");
for (const [placeholder, promptText] of Object.entries(replacements)) {
  source = source.replace(placeholder, jsStringLiteral(promptText));
}

fs.mkdirSync(DIST_DIR, { recursive: true });
fs.writeFileSync(DIST_PATH, source, "utf-8");
console.log(`Built ${DIST_PATH} with embedded agent prompts.`);
