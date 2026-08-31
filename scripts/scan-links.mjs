#!/usr/bin/env node
// Live link-health scan — "refresh inputs" step of the agent.
//
// Finds broken internal /docs links from the corpus, then VERIFIES each candidate
// over HTTP so we don't false-flag API-reference section links (which are real
// pages/anchors, not separate corpus entries). A link is broken only if its target
// actually returns >= 400. For each broken link we suggest the closest valid page
// (used, propose-only, by build-fixes-report).
//
// Orphan pages need the site's navigation tree, which the corpus doesn't carry, so
// we PRESERVE the curated orphan snapshot already in data/known-issues.json rather
// than degrade it with a noisy in-body-link heuristic.
//
// Writes data/known-issues.json in the shape detect-staleness.mjs consumes.
// Run: node scripts/scan-links.mjs
// Env: CORPUS_URL (override corpus), LINK_CONCURRENCY (default 12), SKIP_HTTP=1 (skip verification)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CORPUS_URL = process.env.CORPUS_URL || "https://www.contentstack.com/llms-full.txt";
const KNOWN_FILE = path.join(ROOT, "data", "known-issues.json");
const DOCS_BASE = "https://www.contentstack.com/docs";
const CONCURRENCY = Number(process.env.LINK_CONCURRENCY || 12);
const SKIP_HTTP = process.env.SKIP_HTTP === "1";

// Reused from Routines/scripts/resolve-404.mjs: normalize any href to a docs-space path.
const norm = (u) => u.replace(/^https?:\/\/[^/]+/, "").replace(/^\/docs/, "").replace(/[#?].*$/, "").replace(/\/+$/, "");

async function loadCorpus() {
  if (CORPUS_URL.startsWith("http")) {
    const res = await fetch(CORPUS_URL);
    if (!res.ok) throw new Error(`Corpus fetch failed: HTTP ${res.status}`);
    return res.text();
  }
  return fs.readFileSync(CORPUS_URL, "utf8");
}

function parseCorpus(text) {
  const blocks = text.split(/\n## URL: /).slice(1);
  const pages = [];
  for (const block of blocks) {
    const url = (block.split("\n")[0] || "").trim();
    if (!url.includes("/docs")) continue;
    const fm = block.match(/\n---\n([\s\S]*?)\n---\n/);
    const body = fm ? block.slice(block.indexOf(fm[0]) + fm[0].length) : block;
    pages.push({ url: url.replace(/\/+$/, ""), body });
  }
  return pages;
}

// Is this href a link into the Contentstack /docs space?
function isInternalDoc(href) {
  if (href.startsWith("/docs")) return true;
  return /^https?:\/\/(www\.)?contentstack\.com\/docs(\/|$|#|\?)/i.test(href);
}

function extractDocLinks(body) {
  const links = new Set();
  for (const m of body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/gis)) links.add(m[1]);
  for (const m of body.matchAll(/\[[^\]]+\]\((\/[^)]+|https?:\/\/[^)]+)\)/g)) links.add(m[1]);
  // Strip markdown title suffix (`](url "title")`) and angle brackets, keep the URL.
  return [...links]
    .map((h) => h.trim().replace(/^<|>$/g, "").split(/\s+/)[0])
    .filter(isInternalDoc);
}

// Closest valid page for a broken target: prefer same last segment, then trailing overlap.
function suggestCorrection(brokenPath, validPaths) {
  const seg = brokenPath.split("/").filter(Boolean);
  const last = seg[seg.length - 1] || "";
  let best = null;
  let bestScore = 0;
  for (const v of validPaths) {
    const vseg = v.split("/").filter(Boolean);
    if (!vseg.length) continue;
    let score = vseg[vseg.length - 1] === last ? 10 : 0;
    let i = seg.length - 1;
    let j = vseg.length - 1;
    while (i >= 0 && j >= 0 && seg[i] === vseg[j]) {
      score++;
      i--;
      j--;
    }
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return bestScore >= 1 ? `${DOCS_BASE}${best}` : null;
}

// HTTP status for a URL: HEAD, falling back to GET. Returns 0 on network error.
async function httpStatus(url) {
  for (const method of ["HEAD", "GET"]) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { method, redirect: "follow", signal: ctrl.signal });
      clearTimeout(t);
      if (method === "HEAD" && (res.status === 405 || res.status === 501)) continue; // retry with GET
      return res.status;
    } catch {
      if (method === "GET") return 0;
    }
  }
  return 0;
}

// Verify a list of unique URLs concurrently → Map(url -> status).
async function verifyUrls(urls) {
  const status = new Map();
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      status.set(url, await httpStatus(url));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return status;
}

async function main() {
  console.log(`Fetching corpus: ${CORPUS_URL}`);
  const pages = parseCorpus(await loadCorpus());
  const validSet = new Set(pages.map((p) => norm(p.url)).filter(Boolean));
  const validPaths = [...validSet];
  console.log(`Parsed ${pages.length} docs pages (${validPaths.length} valid paths).`);

  // Collect candidate broken links per page (internal /docs links not in the corpus set).
  const candidatesByPage = new Map();
  const uniqueTargets = new Set();
  for (const page of pages) {
    const cands = [];
    for (const href of extractDocLinks(page.body)) {
      const p = norm(href);
      if (!p || validSet.has(p)) continue; // root or known-valid → fine
      const target = `${DOCS_BASE}${p}`;
      cands.push({ target, path: p });
      uniqueTargets.add(target);
    }
    if (cands.length) candidatesByPage.set(page.url, cands);
  }
  console.log(`Candidate links to verify: ${uniqueTargets.size} unique (across ${candidatesByPage.size} pages).`);

  // Verify over HTTP — a link is broken only if its target actually returns >= 400.
  let brokenTargets;
  if (SKIP_HTTP) {
    brokenTargets = uniqueTargets; // treat all candidates as broken (offline mode)
    console.log("SKIP_HTTP=1 — skipping verification; treating all candidates as broken.");
  } else {
    const status = await verifyUrls([...uniqueTargets]);
    brokenTargets = new Set([...uniqueTargets].filter((u) => status.get(u) >= 400 || status.get(u) === 0));
    console.log(`Verified: ${brokenTargets.size} of ${uniqueTargets.size} candidates actually broken.`);
  }

  const brokenPages = [];
  const details = {};
  let totalBroken = 0;
  for (const [pageUrl, cands] of candidatesByPage) {
    const seen = new Set();
    const broken = cands
      .filter((c) => brokenTargets.has(c.target) && !seen.has(c.target) && seen.add(c.target))
      .map((c) => ({ broken_target: c.target, suggested_fix: suggestCorrection(c.path, validPaths) }));
    if (broken.length) {
      brokenPages.push(pageUrl);
      details[pageUrl] = broken;
      totalBroken += broken.length;
    }
  }

  // Preserve curated orphan data (needs nav tree the corpus lacks).
  let orphanPages = [];
  let priorNote = "";
  if (fs.existsSync(KNOWN_FILE)) {
    try {
      const prior = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8"));
      orphanPages = prior.orphan_pages || [];
      priorNote = " Orphan pages carried forward from the curated snapshot (nav-tree scan pending).";
    } catch {
      /* ignore */
    }
  }

  const out = {
    generated_note: `Broken links scanned live from the corpus.${priorNote}`,
    broken_link_pages: brokenPages.sort(),
    orphan_pages: orphanPages,
    broken_link_details: Object.fromEntries(Object.entries(details).sort()),
  };
  fs.mkdirSync(path.dirname(KNOWN_FILE), { recursive: true });
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(out, null, 2));

  console.log(`Broken-link pages: ${brokenPages.length} (${totalBroken} links). Orphan pages (carried): ${orphanPages.length}.`);
  console.log(`Wrote ${KNOWN_FILE}`);
}

main().catch((err) => {
  console.error("scan-links failed:", err);
  process.exit(1);
});
