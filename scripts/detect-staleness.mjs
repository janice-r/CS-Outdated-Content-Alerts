#!/usr/bin/env node
// Docs Staleness Checker — detection pass.
//
// Fetches the live Contentstack docs corpus, scans every docs page for three
// evidence-based signals, and writes the flagged inventory the Launch app reads.
//
// Signals (v1 — only what the data can actually support):
//   1. content_age            — page not updated in a long time (weighted by doc_type)
//   2. deprecated_reference    — page body still mentions deprecated / EOL / removed features
//   3. broken_link / orphan    — page appears in the known link-health snapshot (data/known-issues.json)
//
// Outputs:
//   functions/generated-inventory.js  — inventory the report function imports
//   reports/freshness_report.json      — full machine-readable record of this run
//   reports/freshness_report.md        — human-readable summary
//
// Run:  node scripts/detect-staleness.mjs
// Env:  CORPUS_URL (optional) overrides the docs corpus location.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { routeOwners } from "../functions/owners.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CORPUS_URL = process.env.CORPUS_URL || "https://www.contentstack.com/llms-full.txt";
const NOW = new Date();

// AI review config. Analysis is cached in data/ai-analysis.json so it persists
// across runs and is served without a key. When ANTHROPIC_API_KEY is set, newly
// flagged pages (not yet in the cache) are reviewed live via the Anthropic API.
const AI_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "claude-sonnet-5";
const AI_LIMIT = Number(process.env.AI_LIMIT || 25); // max pages to review per run
const AI_CACHE_FILE = path.join(ROOT, "data", "ai-analysis.json");

// Doc types whose accuracy decays faster, so we flag them sooner.
const FAST_DECAY = new Set([
  "api", "api-reference", "reference", "api-guide",
  "sdk-guide", "sdk-reference", "sdk-overview", "sdk-download",
  "cli-guide", "reference",
]);

// Content-age thresholds (days). Fast-decay types use the lower band.
const AGE = {
  standard: { flag: 180, medium: 270, high: 365 },
  fast: { flag: 150, medium: 210, high: 300 },
};

// Deprecation / removal language. Word-boundary anchored to limit noise.
const STRONG_DEPRECATION =
  /\b(deprecated|deprecation|no longer supported|will be removed|has been removed|end of life|end-of-life|\bEOL\b|has been retired|is retired|being sunset|sunsetting)\b/gi;
// Softer "aging promise" language — weaker evidence.
const WEAK_FRESHNESS =
  /\b(coming soon|will be available soon|currently in beta|planned for a future release|to be announced|\bTBA\b)\b/gi;

function log(...args) {
  console.log(...args);
}

async function loadCorpus() {
  if (CORPUS_URL.startsWith("http")) {
    log(`Fetching corpus: ${CORPUS_URL}`);
    const res = await fetch(CORPUS_URL);
    if (!res.ok) throw new Error(`Corpus fetch failed: HTTP ${res.status}`);
    return res.text();
  }
  log(`Reading corpus from disk: ${CORPUS_URL}`);
  return fs.readFileSync(CORPUS_URL, "utf8");
}

function loadKnownIssues() {
  const file = path.join(ROOT, "data", "known-issues.json");
  if (!fs.existsSync(file)) {
    log("WARN: data/known-issues.json not found — broken-link/orphan signal disabled.");
    return { broken: new Set(), orphan: new Set(), details: {} };
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const norm = (u) => String(u || "").split("#")[0].replace(/\/+$/, "");
  return {
    broken: new Set((raw.broken_link_pages || []).map(norm)),
    orphan: new Set((raw.orphan_pages || []).map(norm)),
    details: raw.broken_link_details || {},
  };
}

// Parse the llms-full.txt corpus into page records.
function parseCorpus(text) {
  const blocks = text.split(/\n## URL: /).slice(1);
  const pages = [];
  for (const block of blocks) {
    const url = (block.split("\n")[0] || "").trim();
    if (!url.includes("/docs")) continue;
    const fmMatch = block.match(/\n---\n([\s\S]*?)\n---\n/);
    const meta = {};
    if (fmMatch) {
      for (const line of fmMatch[1].split("\n")) {
        const kv = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
        if (kv) meta[kv[1]] = kv[2];
      }
    }
    // Body = everything after the frontmatter block.
    const body = fmMatch ? block.slice(block.indexOf(fmMatch[0]) + fmMatch[0].length) : block;
    pages.push({
      url: url.replace(/\/+$/, ""),
      title: meta.title || url,
      docType: meta.doc_type || "(none)",
      product: meta.product || "",
      lastUpdated: meta.last_updated || null,
      body,
    });
  }
  return pages;
}

function ageInDays(lastUpdated) {
  if (!lastUpdated) return null;
  const then = new Date(lastUpdated);
  if (Number.isNaN(then.getTime())) return null;
  return Math.round((NOW - then) / 86400000);
}

function excerpt(body, regex) {
  regex.lastIndex = 0;
  const m = regex.exec(body);
  if (!m) return null;
  const start = Math.max(0, m.index - 40);
  const end = Math.min(body.length, m.index + 80);
  return body.slice(start, end).replace(/\s+/g, " ").trim();
}

function countMatches(body, regex) {
  regex.lastIndex = 0;
  let n = 0;
  while (regex.exec(body)) n++;
  return n;
}

function slugId(url) {
  return url
    .replace(/^https?:\/\/[^/]+\/docs\/?/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "docs-home";
}

function detectSignals(page, known) {
  const signals = [];
  const runDate = NOW.toISOString().slice(0, 10);
  const age = ageInDays(page.lastUpdated);

  // 1. content_age
  const band = FAST_DECAY.has(page.docType) ? AGE.fast : AGE.standard;
  if (age != null && age > band.flag) {
    const strength = age > band.high ? "high" : age > band.medium ? "medium" : "low";
    signals.push({
      type: "content_age",
      strength,
      detectedAt: page.lastUpdated,
      detail: `Not updated in ${age} days (last updated ${page.lastUpdated}; ${page.docType} content).`,
    });
  }

  // 2. deprecated_reference / version_reference
  const strongCount = countMatches(page.body, STRONG_DEPRECATION);
  if (strongCount > 0) {
    signals.push({
      type: "deprecated_reference",
      strength: "medium",
      detectedAt: runDate,
      detail: `Body references deprecated/removed functionality ${strongCount}x. e.g. "${excerpt(page.body, STRONG_DEPRECATION)}"`,
    });
  }
  const weakCount = countMatches(page.body, WEAK_FRESHNESS);
  if (weakCount > 0) {
    signals.push({
      type: "version_reference",
      strength: "low",
      detectedAt: runDate,
      detail: `Body contains aging "coming soon / beta" language ${weakCount}x. e.g. "${excerpt(page.body, WEAK_FRESHNESS)}"`,
    });
  }

  // 3. broken_link / orphan (from known-issues snapshot)
  if (known.broken.has(page.url)) {
    const targets = (known.details[page.url] || []).map((d) => d.broken_target).filter(Boolean);
    signals.push({
      type: "broken_link",
      strength: "high",
      detectedAt: runDate,
      detail: `Page contains ${targets.length || "known"} broken link(s) from the last link-health scan${targets[0] ? ` (e.g. ${targets[0]})` : ""}.`,
    });
  }
  if (known.orphan.has(page.url)) {
    signals.push({
      type: "orphan",
      strength: "medium",
      detectedAt: runDate,
      detail: "Page is orphaned/stale in the navigation per the last redirect audit.",
    });
  }

  return signals;
}

// Priority proxy matching functions/report.js: 0=Critical .. 3=Low.
function priorityRank(signals) {
  const has = (t) => signals.some((s) => s.type === t);
  const highs = signals.filter((s) => s.strength === "high").length;
  const mediums = signals.filter((s) => s.strength === "medium").length;
  if ((has("broken_link") && (has("deprecated_reference") || has("content_age"))) || highs >= 2) return 0;
  if (has("broken_link") || signals.some((s) => s.type === "content_age" && s.strength === "high") || mediums >= 2) return 1;
  if (mediums >= 1) return 2;
  return 3;
}

// ---- AI review layer ---------------------------------------------------

function loadAiCache() {
  if (!fs.existsSync(AI_CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(AI_CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function contentFingerprint(page) {
  // Invalidate a cached review when the page's substance changes.
  return crypto
    .createHash("sha1")
    .update(`${page.lastUpdated || ""}|${page.body.length}`)
    .digest("hex")
    .slice(0, 12);
}

function buildAiPrompt(page, signals) {
  const body = page.body.slice(0, 6000);
  const signalList = signals.map((s) => `- ${s.type} (${s.strength}): ${s.detail}`).join("\n");
  return `You are a documentation QA reviewer for Contentstack. A rule-based scan flagged this docs page as possibly outdated. Read the page and decide whether it genuinely needs updating.

PAGE
Title: ${page.title}
URL: ${page.url}
Type: ${page.docType}
Last updated: ${page.lastUpdated}

AUTOMATED SIGNALS
${signalList}

PAGE CONTENT (truncated)
"""
${body}
"""

Respond with ONLY a JSON object, no prose, in this exact shape:
{"verdict":"outdated"|"needs-review"|"likely-current","confidence":"high"|"medium"|"low","summary":"<=200 chars on what is or isn't out of date","suggested_fix":"<=200 chars, concrete next action for the writer"}`;
}

async function analyzeWithClaude(page, signals) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": AI_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: buildAiPrompt(page, signals) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json);
  return { ...parsed, model: AI_MODEL, analyzed_at: NOW.toISOString() };
}

// Attach ai_analysis to the top AI_LIMIT flagged items, using the cache first
// and the live API only for cache misses (and only if a key is configured).
async function enrichWithAi(inventory, pageById) {
  const cache = loadAiCache();
  let reused = 0;
  let fresh = 0;
  let skipped = 0;

  // Cached reviews attach to every matching page (free). Only live API calls
  // for cache misses are capped at AI_LIMIT, and inventory is priority-ordered
  // so the budget is spent on the highest-priority unreviewed pages first.
  for (const item of inventory) {
    const page = pageById.get(item.id);
    if (!page) continue;
    const fp = contentFingerprint(page);
    const cached = cache[item.id];
    if (cached) {
      const stale = cached.fingerprint && cached.fingerprint !== fp;
      if (!stale || !AI_KEY) {
        item.aiAnalysis = stripMeta(cached);
        reused++;
        continue;
      }
    }
    if (!AI_KEY || fresh >= AI_LIMIT) {
      skipped++;
      continue;
    }
    try {
      const analysis = await analyzeWithClaude(page, item.productSignals);
      cache[item.id] = { ...analysis, fingerprint: fp };
      item.aiAnalysis = stripMeta(cache[item.id]);
      fresh++;
    } catch (err) {
      log(`  AI review failed for ${item.id}: ${err.message}`);
      skipped++;
    }
  }

  fs.mkdirSync(path.dirname(AI_CACHE_FILE), { recursive: true });
  fs.writeFileSync(AI_CACHE_FILE, JSON.stringify(cache, null, 2));
  log(`AI review: ${reused} cached, ${fresh} newly analyzed, ${skipped} skipped${AI_KEY ? "" : " (no ANTHROPIC_API_KEY — using cache only)"}.`);
}

function stripMeta(entry) {
  const { fingerprint, ...rest } = entry;
  return rest;
}

async function main() {
  const known = loadKnownIssues();
  const corpus = await loadCorpus();
  const pages = parseCorpus(corpus);
  log(`Parsed ${pages.length} docs pages.`);

  const inventory = [];
  const pageById = new Map();
  for (const page of pages) {
    const signals = detectSignals(page, known);
    if (signals.length === 0) continue; // only flag pages with at least one signal
    const { productArea, ownerIds } = routeOwners(page.url);
    const age = ageInDays(page.lastUpdated);
    const id = slugId(page.url);
    pageById.set(id, page);
    inventory.push({
      id,
      docTitle: page.title,
      docUrl: page.url,
      docType: page.docType,
      section: productArea,
      productArea,
      ownerIds,
      lastUpdated: page.lastUpdated,
      contentAgeDays: age == null ? null : age,
      productSignals: signals,
      changelogReference: null,
    });
  }

  // Order by priority (mirrors functions/report.js) so the AI review pass and
  // any top-N slicing cover the pages reviewers see first.
  inventory.sort(
    (a, b) => priorityRank(a.productSignals) - priorityRank(b.productSignals) || (b.contentAgeDays || 0) - (a.contentAgeDays || 0)
  );

  await enrichWithAi(inventory, pageById);

  const generatedAt = NOW.toISOString();
  const byType = {};
  for (const item of inventory) {
    for (const s of item.productSignals) byType[s.type] = (byType[s.type] || 0) + 1;
  }

  // Write the JS module the Launch report function imports.
  const invFile = path.join(ROOT, "functions", "generated-inventory.js");
  const header =
    "// AUTO-GENERATED by scripts/detect-staleness.mjs — do not edit by hand.\n" +
    `// Generated at ${generatedAt}\n\n`;
  fs.writeFileSync(
    invFile,
    header +
      `export const GENERATED_AT = ${JSON.stringify(generatedAt)};\n` +
      `export const SOURCE = ${JSON.stringify({ corpus: CORPUS_URL, pages_scanned: pages.length })};\n` +
      `export const DOC_INVENTORY = ${JSON.stringify(inventory, null, 2)};\n`
  );

  // Write the machine-readable record.
  const reportsDir = path.join(ROOT, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const jsonReport = {
    generated_at: generatedAt,
    source: { corpus: CORPUS_URL, pages_scanned: pages.length },
    summary: {
      pages_scanned: pages.length,
      docs_flagged: inventory.length,
      by_signal: byType,
    },
    flagged: inventory,
  };
  fs.writeFileSync(path.join(reportsDir, "freshness_report.json"), JSON.stringify(jsonReport, null, 2));

  // Write the human-readable summary.
  const md = [
    `# Docs Staleness Report`,
    ``,
    `Generated: ${generatedAt}`,
    `Pages scanned: ${pages.length} · Docs flagged: ${inventory.length}`,
    ``,
    `## Signals`,
    ...Object.entries(byType).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Top flagged pages`,
    ...inventory.slice(0, 25).map((i) => {
      const strongest = i.productSignals[0];
      return `- **${i.docTitle}** (${i.productArea}) — ${strongest.type}: ${strongest.detail}\n  ${i.docUrl}`;
    }),
  ].join("\n");
  fs.writeFileSync(path.join(reportsDir, "freshness_report.md"), md);

  log(`Flagged ${inventory.length} pages.`);
  log(`Signal breakdown:`, byType);
  log(`Wrote functions/generated-inventory.js, reports/freshness_report.json, reports/freshness_report.md`);
}

main().catch((err) => {
  console.error("Detection failed:", err);
  process.exit(1);
});
