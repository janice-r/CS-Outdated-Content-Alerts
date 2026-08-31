#!/usr/bin/env node
// Build the weekly digest for Slack delivery.
// Reads reports/freshness_report.json (flagged + AI reviews) and, if present,
// reports/fixes-proposal.md counts. Writes:
//   - reports/weekly-digest.md            (human-readable)
//   - reports/weekly-digest.slack.json    ({ text } for Slack send_message / webhook)
//
// Wording follows data/style-guide.md (plain, present tense, no hype).
// Run: node scripts/build-digest.mjs   Env: DASHBOARD_URL (optional override)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOwners } from "../functions/owners.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPORT = path.join(ROOT, "reports", "freshness_report.json");
const FIXES = path.join(ROOT, "reports", "fixes-proposal.md");
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://cs-outdated-content-alerts.contentstackapps.com";

const PRIORITY = { broken_link: 0 };
function rank(signals) {
  const has = (t) => signals.some((s) => s.type === t);
  const highs = signals.filter((s) => s.strength === "high").length;
  const mediums = signals.filter((s) => s.strength === "medium").length;
  if ((has("broken_link") && (has("deprecated_reference") || has("content_age"))) || highs >= 2) return 0;
  if (has("broken_link") || signals.some((s) => s.type === "content_age" && s.strength === "high") || mediums >= 2) return 1;
  if (mediums >= 1) return 2;
  return 3;
}
const LABEL = ["Critical", "High", "Normal", "Low"];

function shortName(full) {
  const parts = String(full).trim().split(/\s+/);
  return parts.length < 2 ? full : `${parts[0]} ${parts[parts.length - 1][0]}`;
}

function fixesCount() {
  if (!fs.existsSync(FIXES)) return null;
  const m = fs.readFileSync(FIXES, "utf8").match(/(\d+) pages with a proposed action/);
  return m ? Number(m[1]) : null;
}

function main() {
  if (!fs.existsSync(REPORT)) throw new Error("reports/freshness_report.json not found — run detect-staleness first.");
  const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  const flagged = report.flagged;
  const counts = { Critical: 0, High: 0, Normal: 0, Low: 0 };
  for (const it of flagged) counts[LABEL[rank(it.productSignals)]]++;
  const proposed = fixesCount();
  const date = report.generated_at.slice(0, 10);

  const top = flagged.slice(0, 5).map((it) => {
    const owner = resolveOwners(it.ownerIds)[0];
    const verdict = it.aiAnalysis ? ` — AI: ${it.aiAnalysis.verdict}` : "";
    return { title: it.docTitle, area: it.productArea, owner: owner ? shortName(owner.name) : "Unassigned", verdict, url: it.docUrl };
  });

  // Markdown version
  const md = [
    `# Weekly docs staleness digest — ${date}`,
    ``,
    `${flagged.length} pages flagged for review: ${counts.Critical} Critical, ${counts.High} High, ${counts.Normal} Normal, ${counts.Low} Low.`,
    proposed != null ? `${proposed} pages have a proposed fix ready for review.` : ``,
    ``,
    `## Top pages to look at`,
    ...top.map((t) => `- **${t.title}** (${t.area}, ${t.owner})${t.verdict}\n  ${t.url}`),
    ``,
    `Full list and AI reviews: ${DASHBOARD_URL}`,
  ]
    .filter((l) => l !== ``)
    .join("\n");

  // Slack version (mrkdwn)
  const slackText = [
    `*Weekly docs staleness digest — ${date}*`,
    `${flagged.length} pages flagged: ${counts.Critical} Critical · ${counts.High} High · ${counts.Normal} Normal · ${counts.Low} Low.`,
    proposed != null ? `${proposed} pages have a proposed fix ready for review.` : ``,
    ``,
    `*Top pages:*`,
    ...top.map((t) => `• <${t.url}|${t.title}> (${t.area}, ${t.owner})${t.verdict}`),
    ``,
    `Full list + AI reviews: ${DASHBOARD_URL}`,
  ]
    .filter((l) => l !== ``)
    .join("\n");

  fs.mkdirSync(path.join(ROOT, "reports"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "reports", "weekly-digest.md"), md);
  fs.writeFileSync(path.join(ROOT, "reports", "weekly-digest.slack.json"), JSON.stringify({ text: slackText }, null, 2));
  console.log(`Wrote reports/weekly-digest.md and reports/weekly-digest.slack.json (${flagged.length} flagged, ${proposed ?? 0} proposed fixes).`);
}

main();
