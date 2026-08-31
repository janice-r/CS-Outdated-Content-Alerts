#!/usr/bin/env node
// Build a PROPOSE-ONLY fixes report. Makes NO CMS writes and NO network calls —
// it only assembles suggestions from data already produced by the pipeline:
//   - concrete broken-link corrections from data/known-issues.json (scan-links)
//   - the AI reviewer's suggested_fix from reports/freshness_report.json
//
// A writer reviews reports/fixes-proposal.md and applies changes by hand in the CMS.
// Drafted wording follows data/style-guide.md (the AI-review step authors it).
//
// Run: node scripts/build-fixes-report.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOwners } from "../functions/owners.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPORT = path.join(ROOT, "reports", "freshness_report.json");
const KNOWN = path.join(ROOT, "data", "known-issues.json");
const OUT = path.join(ROOT, "reports", "fixes-proposal.md");

function shortName(full) {
  const parts = String(full).trim().split(/\s+/);
  return parts.length < 2 ? full : `${parts[0]} ${parts[parts.length - 1][0]}`;
}

function ownerLabel(ownerIds) {
  const owners = resolveOwners(ownerIds);
  return owners.length ? owners.map((o) => shortName(o.name)).join(", ") : "Unassigned";
}

function main() {
  if (!fs.existsSync(REPORT)) throw new Error("reports/freshness_report.json not found — run detect-staleness first.");
  const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  const known = fs.existsSync(KNOWN) ? JSON.parse(fs.readFileSync(KNOWN, "utf8")) : { broken_link_details: {} };
  const brokenDetails = known.broken_link_details || {};

  // freshness_report.flagged is already priority-ordered.
  const proposals = [];
  for (const item of report.flagged) {
    const linkFixes = (brokenDetails[item.docUrl] || []).map((b) => ({
      broken: b.broken_target,
      fix: b.suggested_fix,
    }));
    const aiFix = item.aiAnalysis?.suggested_fix || null;
    const aiVerdict = item.aiAnalysis?.verdict || null;
    if (!linkFixes.length && !aiFix) continue; // nothing actionable to propose
    proposals.push({ item, linkFixes, aiFix, aiVerdict });
  }

  const withLinks = proposals.filter((p) => p.linkFixes.length);
  const lines = [];
  lines.push(`# Docs fix proposals (propose-only)`);
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`${proposals.length} pages with a proposed action · ${withLinks.length} with concrete link fixes.`);
  lines.push("");
  lines.push(`> These are proposals only. Nothing is changed in the CMS automatically — a writer applies each change after review.`);
  lines.push("");

  if (withLinks.length) {
    lines.push(`## Broken links to fix`);
    lines.push("");
    for (const p of withLinks) {
      lines.push(`### ${p.item.docTitle}`);
      lines.push(`${p.item.docUrl} — owner: ${ownerLabel(p.item.ownerIds)}`);
      for (const lf of p.linkFixes) {
        lines.push(`- Replace \`${lf.broken}\``);
        lines.push(`  ${lf.fix ? `with \`${lf.fix}\`` : "with the correct target (no confident match found — investigate)."}`);
      }
      if (p.aiFix) lines.push(`- AI note: ${p.aiFix}`);
      lines.push("");
    }
  }

  const reviewsOnly = proposals.filter((p) => !p.linkFixes.length && p.aiFix);
  if (reviewsOnly.length) {
    lines.push(`## AI-suggested reviews (no auto-fixable link)`);
    lines.push("");
    for (const p of reviewsOnly) {
      const verdict = p.aiVerdict ? ` _(${p.aiVerdict})_` : "";
      lines.push(`- **${p.item.docTitle}**${verdict} — ${ownerLabel(p.item.ownerIds)}`);
      lines.push(`  ${p.aiFix}`);
      lines.push(`  ${p.item.docUrl}`);
    }
    lines.push("");
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n"));
  console.log(`Wrote ${OUT}: ${proposals.length} proposals (${withLinks.length} with link fixes).`);
}

main();
