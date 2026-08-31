const REPORT_ENDPOINT = "/report";
const ROW_STATE_KEY = "docs-drift-detector-row-state";
const ROWS_KEY = "docs-drift-detector-rows";
const META_KEY = "docs-drift-detector-meta";
const DEFAULT_STATUS = "To-do";
const TRACKED_STATUSES = new Set(["Archived", "Done"]);
const PRIORITY_RANK = { Critical: 0, High: 1, Normal: 2, Low: 3 };

let currentRows = [];
let activeStaleDays = 0; // 0 = show all; otherwise minimum days since last update

function formatDisplayDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day} ${month}, ${year}`;
}

function getStoredRowState() {
  try {
    return JSON.parse(localStorage.getItem(ROW_STATE_KEY) || "{}");
  } catch {
    return {};
  }
}

function getStoredRows() {
  try {
    return JSON.parse(localStorage.getItem(ROWS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveStoredRows(rows) {
  localStorage.setItem(ROWS_KEY, JSON.stringify(rows));
}

function getStoredMeta() {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveStoredMeta(meta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function saveStoredRowState(state) {
  localStorage.setItem(ROW_STATE_KEY, JSON.stringify(state));
}

function getRowState(row) {
  const storedState = getStoredRowState()[row.id] || {};
  return {
    status: storedState.status || row.default_status || DEFAULT_STATUS,
    owner: storedState.owner || row.selected_owner,
    priority: storedState.priority || row.priority,
  };
}

function toTimestamp(value) {
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortOpenRows(rows) {
  return [...rows].sort((left, right) => {
    const priorityDelta = (PRIORITY_RANK[left.priority] ?? 99) - (PRIORITY_RANK[right.priority] ?? 99);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return toTimestamp(right.first_detected_at || right.signal_detected_at) - toTimestamp(left.first_detected_at || left.signal_detected_at);
  });
}

function sortTrackedRows(rows) {
  return [...rows].sort((left, right) => {
    const leftState = getRowState(left);
    const rightState = getRowState(right);
    return toTimestamp(rightState.trackedAt || right.first_detected_at || right.signal_detected_at) -
      toTimestamp(leftState.trackedAt || left.first_detected_at || left.signal_detected_at);
  });
}

function mergeRows(existingRows, incomingRows, generatedAt) {
  const rowsById = new Map(existingRows.map((row) => [row.id, row]));
  for (const row of incomingRows) {
    const existingRow = rowsById.get(row.id);
    rowsById.set(row.id, {
      ...existingRow,
      ...row,
      first_detected_at: existingRow?.first_detected_at || generatedAt,
      last_detected_at: generatedAt,
    });
  }
  return Array.from(rowsById.values());
}

async function fetchReport(dateFrom, dateTo) {
  const query = new URLSearchParams();
  if (dateFrom) {
    query.set("date_from", dateFrom);
  }
  if (dateTo) {
    query.set("date_to", dateTo);
  }
  const response = await fetch(`${REPORT_ENDPOINT}?${query.toString()}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Unable to fetch report");
  }
  return payload;
}

function renderSignals(row) {
  // Show short signal-type labels (text before the ":"), not the full sentence
  // — the full explanation lives in the Reason column.
  const types = [...new Set(row.signals_detected.map((s) => s.split(":")[0].trim()))];
  const extra = types.filter((t) => t !== row.signal_summary);
  return `
    <div class="row-title">${row.signal_summary}</div>
    ${extra.length ? `<div class="mini">+ ${extra.join(" · ")}</div>` : ""}
  `;
}

function daysSince(value) {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  return Math.round((Date.now() - then) / 86400000);
}

// Keep only rows whose page hasn't been updated in at least activeStaleDays.
function applyStaleFilter(rows) {
  if (!activeStaleDays) return rows;
  return rows.filter((row) => {
    const age = daysSince(row.last_updated);
    return age === null ? true : age >= activeStaleDays;
  });
}

function renderOptions(options, selectedValue) {
  return options
    .map(
      (option) => `<option value="${option}" ${option === selectedValue ? "selected" : ""}>${option}</option>`
    )
    .join("");
}

// "Janice Rodrigues" -> "Janice R"
function shortName(fullName) {
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  return `${parts[0]} ${parts[parts.length - 1][0]}`;
}

// Owner options keep the full name as the value but display the short form.
function renderOwnerOptions(options, selectedValue) {
  return options
    .map(
      (option) => `<option value="${option}" ${option === selectedValue ? "selected" : ""}>${shortName(option)}</option>`
    )
    .join("");
}

const VERDICT_CLASS = { outdated: "high", "needs-review": "medium", "likely-current": "low" };
const VERDICT_LABEL = { outdated: "Outdated", "needs-review": "Needs review", "likely-current": "Likely current" };

function renderVerdictBadge(row) {
  const ai = row.ai_analysis;
  if (!ai) return "";
  const cls = VERDICT_CLASS[ai.verdict] || "low";
  return `<span class="pill verdict ${cls}" title="AI review (${ai.confidence} confidence)">✦ ${VERDICT_LABEL[ai.verdict] || ai.verdict}</span>`;
}

function renderAiDetail(row) {
  const ai = row.ai_analysis;
  const signals = row.signals_detected.map((s) => `<li>${s}</li>`).join("");
  const aiBlock = ai
    ? `<div class="ai-review">
         <div class="ai-head">✦ AI review — <strong>${VERDICT_LABEL[ai.verdict] || ai.verdict}</strong> · ${ai.confidence} confidence</div>
         <p>${ai.summary}</p>
         <p class="ai-fix"><strong>Suggested fix:</strong> ${ai.suggested_fix}</p>
       </div>`
    : `<div class="ai-review ai-none">No AI review yet for this page.</div>`;
  return `
    <tr class="detail-row" data-detail-for="${row.id}" hidden>
      <td colspan="8">
        <div class="detail-grid">
          ${aiBlock}
          <div class="signals-full">
            <div class="ai-head">Signals detected</div>
            <ul>${signals}</ul>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderRow(row) {
  const state = getRowState(row);

  return `
    <tr data-row-id="${row.id}">
      <td>
        <a class="row-title" href="${row.doc_url}" target="_blank" rel="noreferrer">${row.doc_title}</a>
        <div class="mini">${row.doc_type} · ${row.doc_section}</div>
        <button type="button" class="detail-toggle" data-row-id="${row.id}">Details ▸</button>
      </td>
      <td>${row.product_area}</td>
      <td class="signal-cell">${renderSignals(row)}${renderVerdictBadge(row)}</td>
      <td class="reason-cell">${row.reason_flagged}</td>
      <td>
        <select class="owner-select" data-row-id="${row.id}">
          ${renderOwnerOptions(row.owner_options, state.owner)}
        </select>
      </td>
      <td>${formatDisplayDate(row.last_updated)}</td>
      <td>
        <select class="priority-select" data-row-id="${row.id}">
          ${renderOptions(row.priority_options, state.priority)}
        </select>
      </td>
      <td>
        <select class="status-select" data-row-id="${row.id}">
          ${renderOptions(row.status_options, state.status)}
        </select>
      </td>
    </tr>
    ${renderAiDetail(row)}
  `;
}

function renderTables(rows) {
  const visible = applyStaleFilter(rows);
  const openRows = visible.filter((row) => !TRACKED_STATUSES.has(getRowState(row).status));
  const trackedRows = visible.filter((row) => TRACKED_STATUSES.has(getRowState(row).status));
  const openResults = document.getElementById("open-results");
  const doneResults = document.getElementById("done-results");

  openResults.innerHTML = openRows.length
    ? sortOpenRows(openRows).map(renderRow).join("")
    : `<tr><td colspan="8" class="empty-cell">No docs are currently flagged for review in this signal window.</td></tr>`;

  doneResults.innerHTML = trackedRows.length
    ? sortTrackedRows(trackedRows).map(renderRow).join("")
    : `<tr><td colspan="8" class="empty-cell">No archived or completed review items yet.</td></tr>`;
}

const STALE_LABELS = { 30: "1 month", 90: "3 months", 180: "6 months", 365: "1 year" };

function renderCurrentState() {
  const meta = getStoredMeta();
  const visible = applyStaleFilter(currentRows);
  document.getElementById("last-run-text").textContent = meta.last_run_at
    ? formatDisplayDate(meta.last_run_at)
    : "Not run yet";
  document.getElementById("row-count-text").textContent = String(visible.length);
  document.getElementById("open-subtitle").textContent = !currentRows.length
    ? "Run detection to identify pages that may be drifting from the product."
    : activeStaleDays
      ? `Showing ${visible.length} of ${currentRows.length} flagged docs not updated in over ${STALE_LABELS[activeStaleDays]}.`
      : `Showing all ${currentRows.length} flagged docs. Filter by staleness above.`;
  document.getElementById("source-text").textContent =
    `Signals: ${meta.high_confidence || 0} high confidence · ${meta.high_priority || 0} high priority`;
  renderTables(currentRows);
}

function updateStoredField(rowId, field, value) {
  const storedState = getStoredRowState();
  const existingState = storedState[rowId] || {};
  let nextState = {
    ...existingState,
    [field]: value,
  };

  if (field === "status") {
    if (TRACKED_STATUSES.has(value) && !TRACKED_STATUSES.has(existingState.status || DEFAULT_STATUS)) {
      nextState.trackedAt = new Date().toISOString();
    }
    if (!TRACKED_STATUSES.has(value)) {
      delete nextState.trackedAt;
    }
  }

  storedState[rowId] = {
    ...nextState,
  };
  saveStoredRowState(storedState);
}

function handleSelectChange(event) {
  const select = event.target.closest(".status-select, .owner-select, .priority-select");
  if (!select) {
    return;
  }

  if (select.classList.contains("status-select")) {
    updateStoredField(select.dataset.rowId, "status", select.value);
  } else if (select.classList.contains("owner-select")) {
    updateStoredField(select.dataset.rowId, "owner", select.value);
  } else if (select.classList.contains("priority-select")) {
    updateStoredField(select.dataset.rowId, "priority", select.value);
  }

  renderTables(currentRows);
}

function handleDetailToggle(event) {
  const button = event.target.closest(".detail-toggle");
  if (!button) return;
  const detail = document.querySelector(`.detail-row[data-detail-for="${button.dataset.rowId}"]`);
  if (!detail) return;
  const open = detail.hasAttribute("hidden");
  if (open) detail.removeAttribute("hidden");
  else detail.setAttribute("hidden", "");
  button.textContent = open ? "Details ▾" : "Details ▸";
}

async function runChecks(event) {
  event.preventDefault();
  const button = document.getElementById("run-button");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Analyzing...";

  try {
    const payload = await fetchReport();
    currentRows = mergeRows(getStoredRows(), payload.rows || [], payload.generated_at);
    saveStoredRows(currentRows);
    saveStoredMeta({
      last_run_at: payload.generated_at,
      last_filters: payload.filters,
      high_confidence: payload.summary.high_confidence || 0,
      high_priority: payload.summary.high_priority || 0,
    });
    renderCurrentState();
  } catch (error) {
    document.getElementById("open-results").innerHTML = `<tr><td colspan="8" class="empty-cell">${error.message}</td></tr>`;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function setupRangePresets() {
  const group = document.getElementById("range-presets");
  if (!group) return;
  activeStaleDays = getStoredMeta().stale_days || 0;
  for (const chip of group.querySelectorAll(".chip")) {
    chip.classList.toggle("is-active", Number(chip.dataset.days) === activeStaleDays);
  }
  group.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    activeStaleDays = Number(chip.dataset.days) || 0;
    for (const other of group.querySelectorAll(".chip")) {
      other.classList.toggle("is-active", other === chip);
    }
    const meta = getStoredMeta();
    meta.stale_days = activeStaleDays;
    saveStoredMeta(meta);
    renderCurrentState();
  });
}

function initializePage() {
  setupRangePresets();
  currentRows = getStoredRows();
  renderCurrentState();
}

document.getElementById("run-form").addEventListener("submit", runChecks);
document.addEventListener("change", handleSelectChange);
document.addEventListener("click", handleDetailToggle);
initializePage();
