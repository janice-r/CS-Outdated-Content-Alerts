// Launch Cloud Function: /report
// Serves the flagged-docs inventory produced by scripts/detect-staleness.mjs.
// All docs data is REAL (scanned from the live corpus) — no mock inventory.

import { OWNER_OPTIONS, resolveOwners } from "./owners.js";
import { DOC_INVENTORY, GENERATED_AT, SOURCE } from "./generated-inventory.js";

const APP_NAME = "Detect outdated documentation using product signals";
const PRIORITY_OPTIONS = ["Low", "Normal", "High", "Critical"];
const STATUS_OPTIONS = ["To-do", "In-progress", "Review", "Blocked", "Archived", "Done"];

const HIGH_TYPES = new Set(["broken_link"]);

function confidenceFromSignals(signals) {
  if (signals.some((s) => s.strength === "high")) return "High";
  if (signals.some((s) => s.strength === "medium")) return "Medium";
  return "Low";
}

function priorityFromSignals(signals) {
  const has = (type) => signals.some((s) => s.type === type);
  const highCount = signals.filter((s) => s.strength === "high").length;
  const mediumCount = signals.filter((s) => s.strength === "medium").length;

  // A broken link on an otherwise-stale page is the worst reader experience.
  if ((has("broken_link") && (has("deprecated_reference") || has("content_age"))) || highCount >= 2) {
    return "Critical";
  }
  if (has("broken_link") || signals.some((s) => s.type === "content_age" && s.strength === "high") || mediumCount >= 2) {
    return "High";
  }
  if (mediumCount >= 1) return "Normal";
  return "Low";
}

function reasonFromDoc(doc) {
  const strongest =
    doc.productSignals.find((s) => HIGH_TYPES.has(s.type)) ||
    doc.productSignals.find((s) => s.strength === "high") ||
    doc.productSignals.find((s) => s.strength === "medium") ||
    doc.productSignals[0];
  if (!strongest) return "Flagged for general freshness review.";

  switch (strongest.type) {
    case "broken_link":
      return `This page links to content that no longer resolves. ${strongest.detail}`;
    case "deprecated_reference":
      return `The page still documents deprecated or removed functionality. ${strongest.detail}`;
    case "orphan":
      return `The page is orphaned or stale in the site structure. ${strongest.detail}`;
    case "content_age":
      return `The page is aging and may have drifted from the product. ${strongest.detail}`;
    case "version_reference":
      return `The page contains aging "coming soon / beta" language that may now be out of date. ${strongest.detail}`;
    default:
      return strongest.detail;
  }
}

function labelType(type) {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function summarizeSignals(doc) {
  return doc.productSignals.map((s) => `${labelType(s.type)}: ${s.detail}`);
}

function buildFlaggedItem(doc) {
  const owners = resolveOwners(doc.ownerIds);
  const confidence = confidenceFromSignals(doc.productSignals);
  const priority = priorityFromSignals(doc.productSignals);
  const primary =
    doc.productSignals.find((s) => HIGH_TYPES.has(s.type)) ||
    doc.productSignals.find((s) => s.strength === "high") ||
    doc.productSignals[0];

  return {
    id: doc.id,
    app_name: APP_NAME,
    doc_title: doc.docTitle,
    doc_url: doc.docUrl,
    doc_type: doc.docType,
    doc_section: doc.section,
    product_area: doc.productArea,
    owner_names: owners.map((o) => o.name).join(", "),
    owners,
    owner_options: OWNER_OPTIONS,
    selected_owner: owners[0]?.name || OWNER_OPTIONS[0],
    last_updated: doc.lastUpdated,
    reason_flagged: reasonFromDoc(doc),
    signals_detected: summarizeSignals(doc),
    signal_summary: primary ? labelType(primary.type) : "Freshness review",
    confidence,
    priority,
    priority_options: PRIORITY_OPTIONS,
    status_options: STATUS_OPTIONS,
    default_status: STATUS_OPTIONS[0],
    optional_changelog_reference: doc.changelogReference || null,
    signal_detected_at: primary ? primary.detectedAt : doc.lastUpdated,
    ai_analysis: doc.aiAnalysis || null,
  };
}

function filterBySignalWindow(items, dateFrom, dateTo) {
  const fromTime = dateFrom ? new Date(dateFrom).getTime() : null;
  const toTime = dateTo ? new Date(dateTo).getTime() : null;
  return items.filter((item) => {
    const t = new Date(item.signal_detected_at).getTime();
    if (Number.isNaN(t)) return true;
    if (fromTime && t < fromTime) return false;
    if (toTime && t > toTime + 24 * 60 * 60 * 1000 - 1) return false;
    return true;
  });
}

const PRIORITY_ORDER = { Critical: 0, High: 1, Normal: 2, Low: 3 };
const CONFIDENCE_ORDER = { High: 0, Medium: 1, Low: 2 };

export default async function handler(request, response) {
  try {
    const url = new URL(request.url, "http://localhost");
    const dateFrom = url.searchParams.get("date_from") || "";
    const dateTo = url.searchParams.get("date_to") || "";

    const flaggedItems = filterBySignalWindow(DOC_INVENTORY.map(buildFlaggedItem), dateFrom, dateTo).sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
        (CONFIDENCE_ORDER[a.confidence] ?? 9) - (CONFIDENCE_ORDER[b.confidence] ?? 9) ||
        new Date(a.last_updated).getTime() - new Date(b.last_updated).getTime()
    );

    response.status(200).send({
      generated_at: GENERATED_AT,
      source: SOURCE,
      filters: { date_from: dateFrom || null, date_to: dateTo || null },
      summary: {
        docs_flagged: flaggedItems.length,
        high_confidence: flaggedItems.filter((i) => i.confidence === "High").length,
        high_priority: flaggedItems.filter((i) => i.priority === "High" || i.priority === "Critical").length,
      },
      rows: flaggedItems,
    });
  } catch (error) {
    response.status(500).send({ error: error instanceof Error ? error.message : "Unknown error" });
  }
}
