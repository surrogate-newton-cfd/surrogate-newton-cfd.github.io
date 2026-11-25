"use strict";

document.documentElement.classList.toggle("is-embedded", window.self !== window.top);

const COLORS = { surrogate: "#447693", recovery: "#aa6b47", reference: "#56616a" };
const STAGE_LABELS = { surrogate: "Surrogate", recovery: "Surrogate + NK", reference: "Cold-start CFD" };
const NS = "http://www.w3.org/2000/svg";
const DEFAULT_REYNOLDS_PER_MACH = 22132436.863567192;
const JOB_POLL_INTERVAL_MS = 1000;
const FIELD_BINARY_TYPE = "application/vnd.surrogate-newton.fields+binary";
const DEFAULT_HANDLE_COUNT = 6;
const MIN_HANDLE_COUNT = 3;
const MAX_HANDLE_COUNT = 16;
const ACTIVE_JOB_STORAGE_KEY = "surrogate-newton-active-job";
const CASE_INPUTS = ["mach", "aoa", "surrogate-steps", "nk-stop-exponent"];
const JOB_LABELS = {
  mesh: "Mesh generation and solver preparation",
  predict: "Surrogate prediction",
  recover: "NK correction",
  reference: "Cold-start ADflow reference",
};

const state = {
  presets: {}, geometry: null, editorGeometry: null,
  uploadedGeometry: null, customGeometry: null, geometryMode: "existing",
  existingGeometry: null, selectedAirfoil: "local:rae2822", uiucCatalog: [], uiucSource: null,
  mesh: null, case: null, stages: {}, surrogateOnline: false, solverReady: false,
  busy: false, caseRun: null, drag: null, handleCount: DEFAULT_HANDLE_COUNT,
  activeJobId: null, activeJobAction: null,
  reynoldsPerMach: DEFAULT_REYNOLDS_PER_MACH,
  mpiRanks: 8,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function svgElement(name, attrs = {}) {
  const element = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function decodeFieldResponse(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== 0x31464e53) throw new Error("Invalid field response.");
  const headerLength = view.getUint32(4, true);
  const start = 8 + Math.ceil(headerLength / 4) * 4;
  if (start > buffer.byteLength) throw new Error("Incomplete field response.");
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)));
  if (!Array.isArray(header.arrays)) throw new Error("Invalid field metadata.");
  const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  for (const item of header.arrays) {
    if (!Array.isArray(item.path) || !item.path.length || item.path.some((key) => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
      || !Number.isSafeInteger(item.offset) || item.offset < 0 || item.offset % 4
      || !Number.isSafeInteger(item.count) || item.count < 0 || start + item.offset + item.count * 4 > buffer.byteLength) {
      throw new Error("Invalid field array bounds.");
    }
    let target = header.payload;
    for (const key of item.path.slice(0, -1)) {
      if (!target || !Object.prototype.hasOwnProperty.call(target, key)) throw new Error("Invalid field path.");
      target = target[key];
    }
    const key = item.path[item.path.length - 1];
    if (!target || !Object.prototype.hasOwnProperty.call(target, key)) throw new Error("Invalid field path.");
    target[key] = littleEndian ? Array.from(new Float32Array(buffer, start + item.offset, item.count))
      : Array.from({ length: item.count }, (_, index) => view.getFloat32(start + item.offset + index * 4, true));
  }
  return header.payload;
}

const API_BASE = document.querySelector('meta[name="cfd-api-base"]')?.getAttribute?.("content") || "";
let frontendSession = null;
async function sessionCredential() {
  if (!frontendSession) frontendSession = (async () => {
    const key = "cfd-session:" + API_BASE;
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(key)); } catch (_error) {}
    if (saved?.expires_at > Date.now() / 1000 + 60) return saved.token;
    const response = await fetch(API_BASE + "/api/session", {credentials: "omit", headers: {"ngrok-skip-browser-warning": "1"}});
    const payload = await response.json();
    if (!response.ok || !payload.token) throw new Error("Unable to connect to the compute service.");
    try { sessionStorage.setItem(key, JSON.stringify(payload)); } catch (_error) {}
    return payload.token;
  })().catch((error) => { frontendSession = null; throw error; });
  return frontendSession;
}

async function api(path, options = {}) {
  const headers = { Accept: `${FIELD_BINARY_TYPE}, application/json`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  let requestPath = path;
  if (API_BASE) {
    const url = new URL(path, API_BASE);
    if (url.origin !== new URL(API_BASE).origin || !url.pathname.startsWith("/api/")) throw new Error("Invalid compute API address.");
    requestPath = url.href;
    headers.Authorization = "Bearer " + await sessionCredential();
    headers["ngrok-skip-browser-warning"] = "1";
  }
  const response = await fetch(requestPath, { ...options, headers, ...(API_BASE ? {credentials: "omit"} : {}) });
  let payload;
  if ((response.headers.get("Content-Type") || "").includes(FIELD_BINARY_TYPE)) {
    payload = decodeFieldResponse(await response.arrayBuffer());
  } else {
    try { payload = await response.json(); }
    catch {
      if (response.ok) throw new Error("Invalid JSON response.");
      payload = {};
    }
  }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    const retryAfter = Number(response.headers.get("Retry-After"));
    error.retryAfterMs = Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 0;
    throw error;
  }
  return payload;
}

const delay = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const clone = (value) => JSON.parse(JSON.stringify(value));

function formatNumber(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  if (number !== 0 && (Math.abs(number) < 1e-3 || Math.abs(number) >= 1e4)) return number.toExponential(2);
  return number.toFixed(digits);
}

function syncReferenceState() {
  const reynolds = state.reynoldsPerMach * Number($("#mach").value);
  const exponent = Math.floor(Math.log10(reynolds));
  $("#reynolds-value").innerHTML = `${(reynolds / (10 ** exponent)).toFixed(3)} × 10<sup>${exponent}</sup>`;
}

function setMessage(message, error = false) {
  const element = $("#case-message");
  element.textContent = message;
  element.classList.toggle("error", error);
}

function setStageCard(stage, message, className) {
  const card = $(`#stage-${stage}`);
  card.className = `stage-card ${className}`.trim();
  card.querySelector(".stage-state").textContent = message;
}

function rememberActiveJob(job) {
  state.activeJobId = job.job_id;
  state.activeJobAction = job.action;
  const saved = {jobId: job.job_id, action: job.action};
  if (state.caseRun) {
    const {geometry, geometryMode, existingGeometry, customGeometry, uploadedGeometry, selectedAirfoil, mesh, handleCount} = state;
    const inputs = Object.fromEntries(CASE_INPUTS.map((id) => [id, $(`#${id}`).value]));
    saved.caseRun = {...state.caseRun, draft: {geometry, geometryMode, existingGeometry, customGeometry, uploadedGeometry, selectedAirfoil, mesh, handleCount, inputs}};
  }
  try { window.sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, JSON.stringify(saved)); } catch { /* The open page can still poll. */ }
}

function forgetActiveJob() {
  state.activeJobId = null;
  state.activeJobAction = null;
  try { window.sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY); } catch { /* No browser storage. */ }
}

function updateJobPanel(job) {
  const panel = $("#active-job");
  panel.hidden = false;
  panel.dataset.state = job.state;
  $("#active-job-title").textContent = JOB_LABELS[job.action] || "Compute job";
  const cancelButton = $("#cancel-job");
  cancelButton.disabled = !["queued", "running"].includes(job.state) || job.cancel_requested;
  cancelButton.textContent = job.cancel_requested ? "Cancellation requested" : (state.caseRun ? "Cancel run" : "Cancel job");
  if (job.state === "queued") {
    $("#active-job-detail").textContent = "Waiting for the single compute worker.";
    $("#active-job-position").textContent = job.queue_position
      ? `Queue position ${job.queue_position}`
      : "Queued";
  } else if (job.state === "running") {
    $("#active-job-detail").textContent = job.cancel_requested
      ? "Finishing the current solver call before cancellation."
      : "The server is executing this job now.";
    $("#active-job-position").textContent = "Running · concurrency 1";
  } else {
    $("#active-job-detail").textContent = job.error || `Job ${job.state}.`;
    $("#active-job-position").textContent = job.state;
  }
}

async function waitForJob(jobId) {
  let connectionFailures = 0;
  let resultFailures = 0;
  while (true) {
    let job;
    try {
      const payload = await api(`/api/jobs/${jobId}`);
      job = payload.job;
      connectionFailures = 0;
    } catch (error) {
      connectionFailures += 1;
      $("#active-job-detail").textContent = "Temporarily unable to reach the scheduler; retrying…";
      if (connectionFailures >= 8) throw error;
      if (error.status && ![429, 502, 503, 504].includes(error.status)) throw error;
      await delay(Math.max(error.retryAfterMs || 0, Math.min(8000, JOB_POLL_INTERVAL_MS * 2 ** (connectionFailures - 1))) + Math.random() * 300);
      continue;
    }
    updateJobPanel(job);
    if (job.state === "succeeded") {
      let payload;
      try { payload = await api(job.result_url || `/api/jobs/${jobId}/result`); }
      catch (error) {
        resultFailures += 1;
        if (resultFailures >= 8 || (error.status && ![429, 502, 503, 504].includes(error.status))) throw error;
        await delay(Math.max(error.retryAfterMs || 0, Math.min(8000, JOB_POLL_INTERVAL_MS * 2 ** (resultFailures - 1))) + Math.random() * 300);
        continue;
      }
      forgetActiveJob();
      $("#active-job").hidden = true;
      return payload.result;
    }
    if (["failed", "cancelled", "expired"].includes(job.state)) {
      forgetActiveJob();
      const error = new Error(job.error || `Compute job ${job.state}.`);
      error.jobState = job.state;
      throw error;
    }
    await delay(JOB_POLL_INTERVAL_MS + Math.random() * 300);
  }
}

async function runQueuedJob(action, payload) {
  const submitted = await api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ action, payload }),
  });
  rememberActiveJob(submitted.job);
  updateJobPanel(submitted.job);
  return waitForJob(submitted.job.job_id);
}

async function cancelActiveJob() {
  if (!state.activeJobId) return;
  if (state.caseRun) {
    state.caseRun.stopRequested = true;
    rememberActiveJob({job_id: state.activeJobId, action: state.activeJobAction});
  }
  const button = $("#cancel-job");
  button.disabled = true;
  try {
    const payload = await api(`/api/jobs/${state.activeJobId}`, { method: "DELETE" });
    updateJobPanel(payload.job);
  } catch (error) {
    button.disabled = false;
    setMessage(error.message, true);
  }
}

function clearCase() {
  state.case = null;
  state.stages = {};
  setStageCard("surrogate", "Ready", "active");
  setStageCard("recovery", "Awaiting Surrogate", "");
  setStageCard("reference", "Optional", "");
  $("#recover-button").disabled = true;
  $("#reference-button").disabled = true;
  renderResults();
}

function invalidateMesh() {
  state.mesh = null;
  $("#mesh-status").textContent = "Mesh not generated.";
  $("#mesh-status").classList.remove("ready");
  updateEnabledState();
}

function activateMode(mode, { loadGeometry = true } = {}) {
  state.geometryMode = mode;
  $$(".mode-tab").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $$(".mode-panel").forEach((panel) => { panel.hidden = panel.dataset.panel !== mode; });
  if (loadGeometry) {
    if (mode === "existing") {
      if (state.existingGeometry) setGeometry(state.existingGeometry);
    } else if (mode === "upload" && state.uploadedGeometry) {
      setGeometry(state.uploadedGeometry);
    } else if (mode === "custom" && state.customGeometry) {
      setGeometry(state.customGeometry);
    } else {
      drawGeometry();
    }
  } else {
    drawGeometry();
  }
}

function setGeometry(geometry) {
  state.geometry = clone(geometry);
  state.editorGeometry = clone(geometry);
  const tail = Number(state.editorGeometry.geometry27[26]);
  state.editorGeometry.upper = state.editorGeometry.upper.map((value, index) => Number(value) - 0.5 * tail * Number(state.editorGeometry.x[index]));
  state.editorGeometry.lower = state.editorGeometry.lower.map((value, index) => Number(value) + 0.5 * tail * Number(state.editorGeometry.x[index]));
  state.editorGeometry.upper[0] = 0; state.editorGeometry.lower[0] = 0;
  state.editorGeometry.upper[state.editorGeometry.upper.length - 1] = 0;
  state.editorGeometry.lower[state.editorGeometry.lower.length - 1] = 0;
  $("#geometry-name").textContent = geometry.name;
  $("#editor-title").textContent = `${geometry.name} geometry`;
  $("#thickness-value").textContent = `t/c ${(100 * geometry.metrics.max_thickness).toFixed(2)}%`;
  const badge = $("#ood-badge");
  const ood = geometry.ood;
  badge.textContent = ood ? `${ood.is_ood ? "OOD" : "ID"} · P${(100 * ood.percentile).toFixed(1)}` : "OOD —";
  badge.className = "";
  if (ood) badge.classList.add(ood.is_ood ? "out" : "id");
  badge.title = ood ? `${ood.scope || "Geometry-only warning"}: ${ood.definition}` : "";
  $("#d5-value").innerHTML = ood ? `d<sub>5</sub> ${formatNumber(ood.distance_k5, 6)} c` : "d<sub>5</sub> —";
  $("#fit-note").textContent = ood
    ? "Geometry-only warning: d₅ is the mean surface-RMS distance to the five nearest training geometries. P99 is the ID/OOD threshold; the percentile is a rank, not a failure probability."
    : "Optional offline geometry-distance assets are not mounted; geometry editing and computation remain available.";
  drawGeometry();
  clearCase();
  invalidateMesh();
}

const mapEditorX = (x) => 70 + 860 * x;
const mapEditorY = (y) => 180 - 900 * y;

function pathFromSurface(x, y) {
  return x.map((value, index) => `${index === 0 ? "M" : "L"}${mapEditorX(value).toFixed(2)},${mapEditorY(y[index]).toFixed(2)}`).join(" ");
}

function drawEditorGrid() {
  const group = $(".editor-grid");
  group.replaceChildren();
  for (let index = 0; index <= 10; index += 1) {
    group.appendChild(svgElement("line", { x1: mapEditorX(index / 10), x2: mapEditorX(index / 10), y1: 45, y2: 315, class: index % 5 === 0 ? "major" : "" }));
  }
  [-0.1, -0.05, 0, 0.05, 0.1].forEach((y) => {
    group.appendChild(svgElement("line", { x1: 70, x2: 930, y1: mapEditorY(y), y2: mapEditorY(y), class: y === 0 ? "major" : "" }));
    const label = svgElement("text", { x: 59, y: mapEditorY(y) + 4, "text-anchor": "end" });
    label.textContent = y === 0 ? "0" : y.toFixed(2); group.appendChild(label);
  });
}

function interpolate(x, y, target) {
  let index = 1;
  while (index < x.length && x[index] < target) index += 1;
  if (index >= x.length) return y[y.length - 1];
  const ratio = (target - x[index - 1]) / (x[index] - x[index - 1]);
  return y[index - 1] + ratio * (y[index] - y[index - 1]);
}

function handleLocations(count) {
  return Array.from({ length: count }, (_, index) => 0.5 * (1 - Math.cos(Math.PI * (index + 1) / (count + 1))));
}

function smoothstep(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function handleInfluence(x, handleIndex, count) {
  const locations = handleLocations(count);
  const center = locations[handleIndex];
  const leftSpacing = center - (handleIndex === 0 ? 0 : locations[handleIndex - 1]);
  const rightSpacing = (handleIndex === count - 1 ? 1 : locations[handleIndex + 1]) - center;
  const sigma = 0.275 * (leftSpacing + rightSpacing);
  const leftWindow = x < center ? smoothstep(x / center) : 1;
  const rightWindow = x > center ? smoothstep((1 - x) / (1 - center)) : 1;
  return Math.exp(-0.5 * ((x - center) / sigma) ** 2) * leftWindow * rightWindow;
}

function drawGeometry() {
  if (!state.editorGeometry) return;
  const { x, upper, lower } = state.editorGeometry;
  $("#upper-path").setAttribute("d", pathFromSurface(x, upper));
  $("#lower-path").setAttribute("d", pathFromSurface(x, lower));
  const fill = [pathFromSurface(x, upper), ...lower.slice().reverse().map((value, reverseIndex) => {
    const index = lower.length - 1 - reverseIndex;
    return `L${mapEditorX(x[index]).toFixed(2)},${mapEditorY(value).toFixed(2)}`;
  }), "Z"].join(" ");
  $("#airfoil-fill").setAttribute("d", fill);

  const lines = $("#handle-lines");
  const upperGroup = $("#upper-handles");
  const lowerGroup = $("#lower-handles");
  lines.replaceChildren(); upperGroup.replaceChildren(); lowerGroup.replaceChildren();
  if (state.geometryMode !== "custom") return;
  handleLocations(state.handleCount).forEach((handleX, index) => {
    const upperY = interpolate(x, upper, handleX);
    const lowerY = interpolate(x, lower, handleX);
    lines.appendChild(svgElement("line", { x1: mapEditorX(handleX), x2: mapEditorX(handleX), y1: mapEditorY(upperY), y2: mapEditorY(lowerY) }));
    [["upper", upperY, upperGroup], ["lower", lowerY, lowerGroup]].forEach(([side, value, group]) => {
      const handle = svgElement("g");
      const hit = svgElement("circle", { cx: mapEditorX(handleX), cy: mapEditorY(value), r: 18, class: "handle-hit", tabindex: 0, "data-side": side, "data-index": index, "aria-label": `${side} deformation handle ${index + 1}` });
      hit.addEventListener("pointerdown", beginDrag);
      handle.append(hit, svgElement("circle", { cx: mapEditorX(handleX), cy: mapEditorY(value), r: 7, class: "handle-dot" }));
      group.appendChild(handle);
    });
  });
}

function beginDrag(event) {
  if (state.busy || !state.editorGeometry) return;
  event.preventDefault();
  const source = event.currentTarget;
  const captureTarget = $("#airfoil-svg");
  captureTarget.setPointerCapture?.(event.pointerId);
  state.drag = { pointerId: event.pointerId, target: captureTarget, side: source.dataset.side, index: Number(source.dataset.index), startClientY: event.clientY, originalUpper: state.editorGeometry.upper.slice(), originalLower: state.editorGeometry.lower.slice(), moved: false };
  clearCase(); invalidateMesh();
  window.addEventListener("pointermove", continueDrag);
  window.addEventListener("pointerup", finishDrag);
  window.addEventListener("pointercancel", cancelDrag);
}

function continueDrag(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  event.preventDefault();
  const rect = $("#airfoil-svg").getBoundingClientRect();
  const clientDelta = event.clientY - state.drag.startClientY;
  if (Math.abs(clientDelta) > 1) state.drag.moved = true;
  const requestedDelta = -(clientDelta / rect.height) * 0.4;
  const original = state.drag.side === "upper" ? state.drag.originalUpper : state.drag.originalLower;
  const other = state.drag.side === "upper" ? state.drag.originalLower : state.drag.originalUpper;
  const isUpper = state.drag.side === "upper";
  const deltaLimits = state.editorGeometry.x.map((xValue, index) => {
    const influence = handleInfluence(xValue, state.drag.index, state.handleCount);
    if (influence < 1.0e-6 || xValue <= 1.0e-3 || xValue >= 0.995) return null;
    const lowerBound = isUpper ? other[index] + 3.0e-4 : -0.25;
    const upperBound = isUpper ? 0.25 : other[index] - 3.0e-4;
    return [(lowerBound - original[index]) / influence, (upperBound - original[index]) / influence];
  }).filter(Boolean);
  const minDelta = Math.max(-0.18, ...deltaLimits.map(([minimum]) => minimum));
  const maxDelta = Math.min(0.18, ...deltaLimits.map(([, maximum]) => maximum));
  const delta = Math.max(minDelta, Math.min(maxDelta, requestedDelta));
  const deformed = original.map((value, index) => value + delta * handleInfluence(state.editorGeometry.x[index], state.drag.index, state.handleCount));
  state.editorGeometry.upper = state.drag.side === "upper" ? deformed : state.drag.originalUpper.slice();
  state.editorGeometry.lower = state.drag.side === "lower" ? deformed : state.drag.originalLower.slice();
  drawGeometry();
}

function removeDragListeners() {
  window.removeEventListener("pointermove", continueDrag);
  window.removeEventListener("pointerup", finishDrag);
  window.removeEventListener("pointercancel", cancelDrag);
}

function releaseDragPointer(drag) {
  if (drag?.target?.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
}

async function finishDrag(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) return;
  removeDragListeners();
  const drag = state.drag; state.drag = null;
  releaseDragPointer(drag);
  if (!drag.moved) return;
  setBusy(true, "Projecting the edited surface to CST…");
  try {
    const geometry = await api("/api/geometry/project", { method: "POST", body: JSON.stringify({ x: state.editorGeometry.x, upper: state.editorGeometry.upper, lower: state.editorGeometry.lower, name: "Custom airfoil" }) });
    state.customGeometry = clone(geometry);
    activateMode("custom", { loadGeometry: false });
    setGeometry(geometry);
    setMessage("Custom geometry accepted. Generate its mesh before prediction.");
  } catch (error) {
    state.editorGeometry.upper = drag.originalUpper; state.editorGeometry.lower = drag.originalLower;
    drawGeometry(); setMessage(error.message, true);
  } finally { setBusy(false); }
}

function cancelDrag() {
  if (!state.drag) return;
  const drag = state.drag;
  state.editorGeometry.upper = drag.originalUpper; state.editorGeometry.lower = drag.originalLower;
  state.drag = null; removeDragListeners(); releaseDragPointer(drag); drawGeometry();
}

function updateEnabledState() {
  $$(".mode-tab").forEach((button) => { button.disabled = state.busy; });
  $("#airfoil-preset").disabled = state.busy || Object.keys(state.presets).length === 0;
  $("#airfoil-search").disabled = state.busy || Object.keys(state.presets).length === 0;
  $("#coordinate-file").disabled = state.busy;
  $("#handle-count").disabled = state.busy;
  $("#reset-geometry").disabled = state.busy;
  for (const id of [...CASE_INPUTS, "mach-range", "aoa-range"]) $(`#${id}`).disabled = state.busy;
  $("#run-case").disabled = state.busy || !state.geometry || !state.solverReady || !state.surrogateOnline;
  $("#run-case").textContent = state.caseRun ? "Running case…" : "Run case";
  $("#mesh-button").disabled = state.busy || !state.geometry || !state.solverReady;
  $("#predict-button").disabled = state.busy || !state.geometry || !state.mesh || !state.surrogateOnline;
  $("#recover-button").disabled = state.busy || !state.case?.stage;
  $("#reference-button").disabled = state.busy || !state.case?.stage;
}

function setBusy(busy, message = "") {
  state.busy = busy; updateEnabledState();
  if (message) setMessage(message);
}

function powerOfTenLabel(exponent) {
  const digits = String(Math.abs(exponent)).replace(/\d/g, (digit) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[digit]);
  return `10${exponent < 0 ? "⁻" : ""}${digits}`;
}

function syncMethodLabels() {
  const surrogateSteps = Number($("#surrogate-steps").value);
  const stopExponent = Number($("#nk-stop-exponent").value);
  $("#surrogate-stage-detail").textContent = `${surrogateSteps} prediction steps`;
  $("#nk-stage-detail").textContent = `Target ${powerOfTenLabel(-stopExponent)} · fixed compute budget`;
  $("#recover-button").textContent = "Run Surrogate + NK";
}

function mergeStage(existing, incoming) {
  if (!existing) return incoming ? { ...incoming } : null;
  if (!incoming) return existing;
  if (incoming.field && (!existing.revision || !incoming.revision || existing.revision !== incoming.revision)) {
    return { ...incoming, field: { ...incoming.field, channels: { ...(incoming.field.channels || {}) } } };
  }
  const merged = { ...existing, ...incoming };
  if (incoming.field) {
    merged.field = {
      ...(existing.field || {}),
      ...(incoming.field || {}),
      channels: {
        ...(existing.field?.channels || {}),
        ...(incoming.field?.channels || {}),
      },
    };
  }
  return merged;
}

function attachSharedFieldGrid() {
  const grid = state.case?.field_grid;
  if (!grid) return;
  Object.values(state.stages).forEach((stage) => {
    if (!stage?.field) return;
    stage.field.x = grid.x;
    stage.field.y = grid.y;
  });
}

function syncCase(payload, { replace = false } = {}) {
  const sameCase = state.case?.case_id && state.case.case_id === payload.case_id;
  const previous = !replace && sameCase ? state.case : {};
  const merged = { ...previous, ...payload };
  merged.stage = mergeStage(previous.stage, payload.stage);
  merged.recovery = mergeStage(previous.recovery, payload.recovery);
  merged.reference = mergeStage(previous.reference, payload.reference);
  state.case = merged;
  state.stages = {};
  if (merged.stage) state.stages.surrogate = merged.stage;
  if (merged.recovery) state.stages.recovery = merged.recovery;
  if (merged.reference) state.stages.reference = merged.reference;
  attachSharedFieldGrid();
  setStageCard("surrogate", merged.stage ? "Complete" : "Ready", merged.stage ? "complete" : "active");
  const recoveryState = merged.recovery
    ? (merged.recovery.converged
      ? "Converged"
      : `Stopped · ${merged.recovery.termination}`)
    : "Ready to run";
  setStageCard("recovery", recoveryState, merged.recovery ? (merged.recovery.converged ? "complete" : "stopped") : "active");
  setStageCard("reference", merged.reference ? (merged.reference.converged ? "Converged" : `Stopped · ${merged.reference.termination || "target not reached"}`) : "Optional", merged.reference ? (merged.reference.converged ? "complete" : "stopped") : "");
  updateEnabledState(); renderResults();
  if (!["cp", "pressure"].includes($("#field-channel").value)) void ensureFieldChannel();
}

async function ensureFieldChannel(channelKey = $("#field-channel").value) {
  if (!state.case?.case_id || channelKey === "pressure" || channelKey === "cp") {
    renderFields();
    return;
  }
  const missing = Object.entries(state.stages).filter(([, stage]) => (
    stage?.field && !stage.field.channels?.[channelKey]
  ));
  if (!missing.length) {
    renderFields();
    return;
  }
  const selector = $("#field-channel");
  selector.disabled = true;
  const requestedCaseId = state.case.case_id;
  try {
    await Promise.all(missing.map(async ([stageKey, requestedStage]) => {
      const requestedField = requestedStage.field;
      const requestedRevision = requestedStage.revision ?? null;
      const payload = await api(`/api/cases/${requestedCaseId}/fields/${stageKey}/${channelKey}`);
      if (state.case?.case_id !== requestedCaseId) return;
      const activeStage = state.stages[stageKey];
      if (activeStage?.field !== requestedField || (activeStage.revision ?? null) !== requestedRevision
        || (payload.revision ?? null) !== requestedRevision) return;
      activeStage.field.channels[channelKey] = payload.channel;
    }));
    renderFields();
  } catch (error) {
    setMessage(`Unable to load the selected field: ${error.message}`, true);
  } finally {
    selector.disabled = false;
  }
}

function plotPath(xValues, yValues, mapX, mapY) {
  return xValues.map((value, index) => `${index === 0 ? "M" : "L"}${mapX(Number(value)).toFixed(2)},${mapY(Number(yValues[index])).toFixed(2)}`).join(" ");
}

function drawSurfaceAxes(svg, { yMin, yMax, yTicks, yLabel, yFormatter, inverted = false }) {
  const { width, height } = svg.viewBox.baseVal;
  const left = 100, right = width - 26, top = 25, bottom = height - 83;
  const mapX = (value) => left + value * (right - left);
  const mapY = (value) => top + (inverted ? value - yMin : yMax - value) / (yMax - yMin) * (bottom - top);
  const grid = svg.querySelector(".chart-grid"); const labels = svg.querySelector(".chart-labels");
  grid.replaceChildren(); labels.replaceChildren();
  for (const tick of [0, 0.25, 0.5, 0.75, 1]) {
    const x = mapX(tick);
    grid.appendChild(svgElement("line", { x1: x, x2: x, y1: top, y2: bottom, class: tick === 0 ? "axis" : "" }));
    const label = svgElement("text", { x, y: bottom + 42, "text-anchor": "middle" });
    label.textContent = formatNumber(tick, 2);
    labels.appendChild(label);
  }
  for (const tick of yTicks) {
    const y = mapY(tick);
    grid.appendChild(svgElement("line", { x1: left, x2: right, y1: y, y2: y, class: tick === 0 ? "axis" : "" }));
    const label = svgElement("text", { x: left - 12, y, "dominant-baseline": "central", "text-anchor": "end" });
    label.textContent = yFormatter(tick);
    labels.appendChild(label);
  }
  const xTitle = svgElement("text", { x: (left + right) / 2, y: height - 8, "text-anchor": "middle" });
  xTitle.textContent = "x / c";
  const yTitleX = 23, yTitleY = (top + bottom) / 2;
  const yTitle = svgElement("text", { x: yTitleX, y: yTitleY, transform: `rotate(-90 ${yTitleX} ${yTitleY})`, "text-anchor": "middle" });
  yTitle.textContent = yLabel;
  labels.append(xTitle, yTitle);
  return { mapX, mapY };
}

function niceStep(span, targetCount = 6) {
  const raw = Math.max(Math.abs(span), 1e-12) / targetCount;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * power;
}

function niceTicks(minimum, maximum, { include = [], targetCount = 6 } = {}) {
  const step = niceStep(maximum - minimum, targetCount);
  const start = Math.ceil((minimum - 1e-12) / step) * step;
  const ticks = [];
  for (let value = start; value <= maximum + 1e-12; value += step) ticks.push(Number(value.toPrecision(12)));
  include.forEach((value) => { if (value >= minimum && value <= maximum && !ticks.some((tick) => Math.abs(tick - value) < 1e-10)) ticks.push(value); });
  return ticks.sort((a, b) => a - b);
}

function legendItem(label, color, { dashed = false, marker = "", wide = false } = {}) {
  const item = document.createElement("span"); item.className = "legend-item";
  const swatch = document.createElement("i"); swatch.style.borderColor = color; swatch.classList.toggle("dashed", dashed); swatch.classList.toggle("marked-circle", marker === "circle"); swatch.classList.toggle("marked-square", marker === "square"); swatch.classList.toggle("wide", wide);
  item.append(swatch, document.createTextNode(label)); return item;
}

function cpMarkerIndices(length, key) {
  const closureIndex = Math.max(0, length - 1);
  const stride = Math.max(2, Math.floor(closureIndex / 12));
  const phase = key === "surrogate" ? Math.floor(stride / 2) : 0;
  const indices = [];
  for (let index = phase; index < closureIndex; index += stride) indices.push(index);
  return indices;
}

function renderCp() {
  const svg = $("#cp-chart"); const series = svg.querySelector(".chart-series"); const legend = $("#cp-legend");
  series.replaceChildren(); legend.replaceChildren();
  const available = Object.entries(state.stages).filter(([, stage]) => stage.cp);
  $("#cp-empty").hidden = available.length > 0; svg.hidden = available.length === 0;
  if (!available.length) return;
  const allCp = available.flatMap(([, stage]) => [...stage.cp.upper.cp, ...stage.cp.lower.cp]).map(Number).filter(Number.isFinite);
  const actualMin = Math.min(...allCp); const actualMax = Math.max(...allCp);
  const margin = Math.max(0.08, 0.05 * (actualMax - actualMin));
  const yMin = actualMin - margin;
  const yMax = actualMax > 1.05 ? actualMax + margin : 1.12;
  const { mapX, mapY } = drawSurfaceAxes(svg, {
    yMin, yMax, yTicks: niceTicks(yMin, yMax, { include: [0, 1] }),
    yLabel: "Cp", yFormatter: (tick) => tick.toFixed(1), inverted: true,
  });
  const byKey = Object.fromEntries(available);
  const drawOrder = ["reference", "recovery", "surrogate"].filter((key) => byKey[key]);
  drawOrder.forEach((key) => {
    const stage = byKey[key];
    ["upper", "lower"].forEach((side) => {
      const values = stage.cp[side];
      series.appendChild(svgElement("path", {
        d: plotPath(values.x, values.cp, mapX, mapY), fill: "none", stroke: COLORS[key],
        "stroke-width": key === "reference" ? 5.5 : 2.4,
        "stroke-opacity": key === "reference" ? 0.72 : 0.96,
        "stroke-dasharray": side === "lower" ? "7 5" : "",
        "stroke-linecap": "round", "stroke-linejoin": "round",
      }));
    });
  });
  ["recovery", "surrogate"].filter((key) => byKey[key]).forEach((key) => {
    ["upper", "lower"].forEach((side) => {
      const values = byKey[key].cp[side];
      cpMarkerIndices(values.x.length, key).forEach((index) => {
        const x = values.x[index];
        const cx = mapX(Number(x)); const cy = mapY(Number(values.cp[index]));
        if (key === "recovery") {
          series.appendChild(svgElement("circle", { cx, cy, r: 4, fill: "#fff", stroke: COLORS[key], "stroke-width": 2 }));
        } else {
          series.appendChild(svgElement("rect", { x: cx - 2.6, y: cy - 2.6, width: 5.2, height: 5.2, fill: "#fff", stroke: COLORS[key], "stroke-width": 1.8 }));
        }
      });
    });
  });
  drawOrder.forEach((key) => {
    legend.appendChild(legendItem(STAGE_LABELS[key], COLORS[key], {
      marker: key === "recovery" ? "circle" : key === "surrogate" ? "square" : "",
      wide: key === "reference",
    }));
  });
  const separator = document.createElement("span"); separator.className = "legend-separator";
  legend.append(separator, legendItem("Upper surface", "#65717c"), legendItem("Lower surface", "#65717c", { dashed: true }));
}

function renderCf() {
  const svg = $("#cf-chart"); const series = svg.querySelector(".chart-series"); const legend = $("#cf-legend");
  series.replaceChildren(); legend.replaceChildren();
  const available = Object.entries(state.stages).filter(([, stage]) => stage.cf);
  $("#cf-empty").hidden = available.length > 0; svg.hidden = available.length === 0;
  if (!available.length) return;
  const allCf = available.flatMap(([, stage]) => [...stage.cf.upper.cf, ...stage.cf.lower.cf]).map(Number).filter(Number.isFinite);
  const actualMin = Math.min(...allCf, 0); const actualMax = Math.max(...allCf, 0);
  const margin = Math.max(5e-5, 0.08 * (actualMax - actualMin || 1e-3));
  const yMin = actualMax > 0 && actualMin >= 0 ? 0 : actualMin - margin;
  const yMax = actualMax + margin;
  const exponent = Math.floor(Math.log10(Math.max(-yMin, yMax)));
  const scale = 10 ** exponent;
  const decimals = Math.max(0, exponent - Math.floor(Math.log10(niceStep(yMax - yMin))));
  const { mapX, mapY } = drawSurfaceAxes(svg, {
    yMin, yMax, yTicks: niceTicks(yMin, yMax, { include: [0] }),
    yLabel: exponent === 0 ? "Cf" : `Cf (×${powerOfTenLabel(exponent)})`,
    yFormatter: (tick) => String(Number((tick / scale).toFixed(decimals))).replace("-", "−"),
  });
  const byKey = Object.fromEntries(available);
  const drawOrder = ["reference", "recovery", "surrogate"].filter((key) => byKey[key]);
  drawOrder.forEach((key) => {
    ["upper", "lower"].forEach((side) => {
      const values = byKey[key].cf[side];
      series.appendChild(svgElement("path", {
        d: plotPath(values.x, values.cf, mapX, mapY), fill: "none", stroke: COLORS[key],
        "stroke-width": key === "reference" ? 5.5 : 2.4,
        "stroke-opacity": key === "reference" ? 0.72 : 0.96,
        "stroke-dasharray": side === "lower" ? "7 5" : "",
        "stroke-linecap": "round", "stroke-linejoin": "round",
      }));
    });
  });
  ["recovery", "surrogate"].filter((key) => byKey[key]).forEach((key) => {
    ["upper", "lower"].forEach((side) => {
      const values = byKey[key].cf[side];
      cpMarkerIndices(values.x.length, key).forEach((index) => {
        const cx = mapX(Number(values.x[index])); const cy = mapY(Number(values.cf[index]));
        if (key === "recovery") series.appendChild(svgElement("circle", { cx, cy, r: 4, fill: "#fff", stroke: COLORS[key], "stroke-width": 2 }));
        else series.appendChild(svgElement("rect", { x: cx - 2.6, y: cy - 2.6, width: 5.2, height: 5.2, fill: "#fff", stroke: COLORS[key], "stroke-width": 1.8 }));
      });
    });
  });
  drawOrder.forEach((key) => legend.appendChild(legendItem(STAGE_LABELS[key], COLORS[key], { marker: key === "recovery" ? "circle" : key === "surrogate" ? "square" : "", wide: key === "reference" })));
  const separator = document.createElement("span"); separator.className = "legend-separator";
  legend.append(separator, legendItem("Upper surface", "#65717c"), legendItem("Lower surface", "#65717c", { dashed: true }));
}

const FIELD_COLOR_STOPS = [[24, 62, 115], [65, 142, 183], [107, 184, 213], [238, 228, 185], [232, 119, 60], [158, 38, 53]];
const ERROR_COLOR_STOPS = [[255, 252, 245], [254, 224, 168], [245, 150, 99], [206, 73, 112], [111, 31, 123]];

function drawAirfoil(context, mapX, mapY) {
  if (!state.geometry) return;
  context.beginPath(); state.geometry.x.forEach((x, index) => index === 0 ? context.moveTo(mapX(x), mapY(state.geometry.upper[index])) : context.lineTo(mapX(x), mapY(state.geometry.upper[index])));
  for (let index = state.geometry.x.length - 1; index >= 0; index -= 1) context.lineTo(mapX(state.geometry.x[index]), mapY(state.geometry.lower[index]));
  context.closePath(); context.fillStyle = "#ffffff"; context.strokeStyle = "#1d1d1f"; context.lineWidth = 1.1; context.fill(); context.stroke();
}

function compileFieldShader(gl, type, source) {
  const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Field shader compilation failed");
  return shader;
}

const fieldRenderers = new WeakMap();
const fieldPrograms = new WeakMap();
const fieldNodes = new WeakMap();
let fieldFramePending = false;
function scheduleFields() {
  if (fieldFramePending) return;
  fieldFramePending = true;
  window.requestAnimationFrame(() => { fieldFramePending = false; renderFields(); });
}

function fieldNodeValues(field, values) {
  const cached = fieldNodes.get(values);
  if (cached) return cached;
  const result = new Float64Array(field.x.length);
  const weights = new Uint8Array(result.length);
  const stride = field.node_width;
  for (let row = 0; row < field.height; row += 1) {
    for (let column = 0; column < field.width; column += 1) {
      const value = Number(values[row * field.width + column]);
      const node = row * stride + column;
      for (const index of [node, node + 1, node + stride, node + stride + 1]) {
        result[index] += value;
        weights[index] += 1;
      }
    }
  }
  for (let index = 0; index < result.length; index += 1) result[index] /= Math.max(1, weights[index]);
  fieldNodes.set(values, result);
  return result;
}

function drawContinuousField(fieldLayer, field, range, values, stops, contourPixelScale) {
  const gl = fieldLayer.getContext("webgl", {antialias: true, alpha: false, preserveDrawingBuffer: true});
  if (!gl || gl.isContextLost()) return false;
  let renderer = fieldPrograms.get(fieldLayer);
  if (!renderer) {
    const contoursSupported = !!gl.getExtension("OES_standard_derivatives");
    const vertexShader = compileFieldShader(gl, gl.VERTEX_SHADER, `
      attribute vec2 a_position;
      attribute float a_value;
      varying float value;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        value = a_value;
      }`);
    const fragmentShader = compileFieldShader(gl, gl.FRAGMENT_SHADER, `${contoursSupported ? "#extension GL_OES_standard_derivatives : enable" : ""}
      precision highp float;
      varying float value;
      uniform sampler2D palette;
      uniform float whiteAnchor;
      uniform vec2 limits;
      uniform float contourPixelScale;
      ${contoursSupported ? FIELD_DISPLAY.contourShader : ""}
      void main() {
        float u = (clamp(value, 0.0, 1.0) * 1023.0 + 0.5) / 1024.0;
        vec3 fill = abs(value - whiteAnchor) < 1e-7 ? vec3(1.0) : texture2D(palette, vec2(u, 0.5)).rgb;
        ${contoursSupported ? "if (contourPixelScale > 0.0) fill = withCpContours(fill, mix(limits.x, limits.y, value), contourPixelScale);" : ""}
        gl_FragColor = vec4(fill, 1.0);
      }`);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return false;
    }
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    renderer = {
      program, texture, buffer: gl.createBuffer(),
      position: gl.getAttribLocation(program, "a_position"),
      value: gl.getAttribLocation(program, "a_value"),
      palette: gl.getUniformLocation(program, "palette"),
      whiteAnchor: gl.getUniformLocation(program, "whiteAnchor"),
      contoursSupported, limits: gl.getUniformLocation(program, "limits"),
      contourPixelScale: gl.getUniformLocation(program, "contourPixelScale"),
    };
    fieldPrograms.set(fieldLayer, renderer);
  }
  if (contourPixelScale && !renderer.contoursSupported) return false;
  const {program, buffer, position, value, texture, palette, whiteAnchor} = renderer;
  const [low, high] = range;
  const rangeChanged = renderer.minimum !== low || renderer.maximum !== high;
  gl.useProgram(program);
  if (renderer.contoursSupported) {
    gl.uniform2f(renderer.limits, low, high);
    gl.uniform1f(renderer.contourPixelScale, contourPixelScale);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (rangeChanged || renderer.stops !== stops) {
    const table = new Uint8ClampedArray(1024 * 4);
    for (let index = 0; index < 1024; index += 1) {
      const rgb = FIELD_DISPLAY.colour(low + (high - low) * index / 1023, stops);
      table.set([...rgb, 255], 4 * index);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(table.buffer));
    gl.uniform1i(palette, 0);
    const hasWhiteZero = stops.some(([anchor, r, g, b]) => anchor === 0 && r === 255 && g === 255 && b === 255);
    gl.uniform1f(whiteAnchor, hasWhiteZero && low <= 0 && high >= 0 ? -low / (high - low) : -1e20);
    renderer.stops = stops;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  if (renderer.field !== field || renderer.values !== values || rangeChanged) {
    const nodeAt = (i, j) => i * field.node_width + j;
    const nodeValues = fieldNodeValues(field, values);

    const {xMin, xMax, yMin, yMax} = FIELD_DISPLAY.bounds;
    const vertices = new Float32Array(field.height * field.width * 18);
    let offset = 0;
    const appendNode = (index) => {
      vertices[offset++] = 2 * (field.x[index] - xMin) / (xMax - xMin) - 1;
      vertices[offset++] = 2 * (field.y[index] - yMin) / (yMax - yMin) - 1;
      vertices[offset++] = (nodeValues[index] - low) / (high - low);
    };
    for (let i = 0; i < field.height; i += 1) {
      for (let j = 0; j < field.width; j += 1) {
        const n0 = nodeAt(i, j);
        const n1 = nodeAt(i, j + 1);
        const n2 = nodeAt(i + 1, j + 1);
        const n3 = nodeAt(i + 1, j);
        [n0, n1, n2, n0, n2, n3].forEach(appendNode);
      }
    }
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    Object.assign(renderer, {field, values, minimum: low, maximum: high, count: vertices.length / 3});
  }
  gl.viewport(0, 0, fieldLayer.width, fieldLayer.height);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(value);
  gl.vertexAttribPointer(value, 1, gl.FLOAT, false, 12, 8);
  gl.drawArrays(gl.TRIANGLES, 0, renderer.count);
  return true;
}

function drawFlatFieldFallback(context, field, limits, values, stops, mapX, mapY) {
  const [low, high] = limits;
  const nodeAt = (i, j) => i * field.node_width + j;
  const cellAt = (i, j) => i * field.width + j;
  for (let i = field.height - 1; i >= 0; i -= 1) for (let j = 0; j < field.width; j += 1) {
    const indices = [nodeAt(i, j), nodeAt(i, j + 1), nodeAt(i + 1, j + 1), nodeAt(i + 1, j)];
    context.beginPath();
    context.moveTo(mapX(field.x[indices[0]]), mapY(field.y[indices[0]]));
    for (const index of indices.slice(1)) context.lineTo(mapX(field.x[index]), mapY(field.y[index]));
    context.closePath();
    const value = Math.min(high, Math.max(low, values[cellAt(i, j)]));
    context.fillStyle = `rgb(${FIELD_DISPLAY.colour(value, stops).map(Math.round).join(",")})`;
    context.fill();
  }
}

function drawCpContours(context, field, values, mapX, mapY) {
  const {interval, rgb, opacity} = FIELD_DISPLAY.cpContours;
  const nodes = fieldNodeValues(field, values);
  const stride = field.node_width;

  function traceTriangle(triangle) {
    const levels = triangle.map((index) => nodes[index] / interval);
    const first = Math.floor(Math.min(...levels)) + 1;
    const last = Math.floor(Math.max(...levels));
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first > 64) return;
    for (let contour = first; contour <= last; contour += 1) {
      let count = 0;
      for (let edge = 0; edge < 3; edge += 1) {
        const following = (edge + 1) % 3;
        const from = levels[edge];
        const to = levels[following];
        if ((from < contour) === (to < contour)) continue;
        const weight = (contour - from) / (to - from);
        const a = triangle[edge];
        const b = triangle[following];
        const x = mapX(field.x[a] + (field.x[b] - field.x[a]) * weight);
        const y = mapY(field.y[a] + (field.y[b] - field.y[a]) * weight);
        if (count === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
        count += 1;
      }
    }
  }

  context.save();
  context.strokeStyle = `rgba(${rgb.join(",")}, ${opacity})`;
  context.lineWidth = 0.8;
  context.beginPath();
  for (let row = 0; row < field.height; row += 1) {
    for (let column = 0; column < field.width; column += 1) {
      const node = row * stride + column;
      traceTriangle([node, node + 1, node + stride + 1]);
      traceTriangle([node, node + stride + 1, node + stride]);
    }
  }
  context.stroke();
  context.restore();
}

function drawFlowField(canvas, field, {limits, stops, paletteKey}, values) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  let renderer = fieldRenderers.get(canvas);
  if (!renderer) {
    const layer = document.createElement("canvas");
    renderer = {layer};
    fieldRenderers.set(canvas, renderer);
    layer.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      renderer.values = null;
      fieldPrograms.delete(layer);
      scheduleFields();
    });
    layer.addEventListener("webglcontextrestored", () => { renderer.values = null; scheduleFields(); });
  }
  const [minimum, maximum] = limits;
  if (renderer.values === values && renderer.field === field && renderer.minimum === minimum && renderer.maximum === maximum
      && renderer.paletteKey === paletteKey && renderer.geometry === state.geometry && canvas.width === width && canvas.height === height) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, rect.width, rect.height);
  const fieldLayer = renderer.layer;
  if (fieldLayer.width !== width) fieldLayer.width = width;
  if (fieldLayer.height !== height) fieldLayer.height = height;
  const {xMin, xMax, yMin, yMax} = FIELD_DISPLAY.bounds;
  const mapX = (value) => ((value - xMin) / (xMax - xMin)) * rect.width;
  const mapY = (value) => rect.height - ((value - yMin) / (yMax - yMin)) * rect.height;
  const showContours = paletteKey === "cp";
  let continuous = false;
  try { continuous = drawContinuousField(fieldLayer, field, limits, values, stops, showContours ? ratio : 0); } catch { /* Use the 2D fallback. */ }
  if (continuous) {
    context.drawImage(fieldLayer, 0, 0, rect.width, rect.height);
  } else {
    drawFlatFieldFallback(context, field, limits, values, stops, mapX, mapY);
    if (showContours) drawCpContours(context, field, values, mapX, mapY);
  }
  Object.assign(renderer, {values, field, minimum, maximum, paletteKey, geometry: state.geometry});
  drawAirfoil(context, mapX, mapY);
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

const cpChannels = new WeakMap();
function displayedChannel(field, key) {
  const source = field?.channels?.[key === "cp" ? "pressure" : key];
  if (!source || key !== "cp") return source;
  const q = FIELD_DISPLAY.dynamicPressureScale(Number(state.case?.flow?.mach));
  if (!Number.isFinite(q) || q <= 0) return undefined;
  if (cpChannels.get(source)?.q !== q) {
    cpChannels.set(source, {q, values: source.values.map((pressure) => (pressure - 1) / q)});
  }
  return cpChannels.get(source);
}

function scaleInputs(prefix) {
  return [$(`#${prefix}-scale-min`), $(`#${prefix}-scale-max`)];
}

const savedScaleInputs = new Map();
function scaleInputKey(prefix) {
  const channel = $("#field-channel").value;
  if (prefix !== "error" || channel !== "cp") return `${prefix}:${channel}`;
  return `error:cp:${$("#cp-error-mode").value}`;
}

function rememberScaleInputs(prefix) {
  savedScaleInputs.set(scaleInputKey(prefix), scaleInputs(prefix).map((input) => input.value));
}

function restoreScaleInputs(prefix) {
  const values = savedScaleInputs.get(scaleInputKey(prefix)) ?? ["", ""];
  scaleInputs(prefix).forEach((input, index) => { input.value = values[index]; });
}

function configuredRange(defaultRange, prefix) {
  const inputs = scaleInputs(prefix);
  const range = inputs.map((input, index) => input.value === "" ? defaultRange[index] : Number(input.value));
  const valid = range.every(Number.isFinite) && range[0] < range[1];
  inputs[0].setCustomValidity(valid ? "" : "Minimum must be smaller than maximum.");
  inputs[1].setCustomValidity(valid ? "" : "Maximum must be larger than minimum.");
  return valid ? range : defaultRange;
}

function configureScaleControls(prefix, standardScale, automaticMinimum = "Auto") {
  const [low, high] = scaleInputs(prefix);
  low.placeholder = standardScale ? String(standardScale.limits[0]).replace("-", "−") : automaticMinimum;
  high.placeholder = standardScale ? String(standardScale.limits[1]) : "Auto";
  $(`#${prefix}-scale-auto`).textContent = standardScale ? "Use standard scale" : "Use automatic limits";
}

function fieldDisplay(prefix, defaultRange, title, paletteKey, standardScale, colors) {
  const limits = configuredRange(defaultRange, prefix);
  const stops = standardScale ? FIELD_DISPLAY.signedStops(standardScale, limits) : FIELD_DISPLAY.uniformStops(colors, limits);
  const ticks = standardScale ? FIELD_DISPLAY.rangeTicks(standardScale, limits) : limits;
  return {title, limits, stops, ticks, paletteKey};
}

function updateColorbar(selector, display) {
  const legend = $(selector);
  legend.hidden = !display;
  if (display) FIELD_DISPLAY.drawColorbar(legend, display);
}

function meanSquaredError(values) {
  return values.reduce((sum, value) => sum + value ** 2, 0) / values.length;
}

let fieldErrorCache = null;
function renderFieldErrors(channels, channelKey, channelLabel) {
  const surrogate = channels.surrogate?.values;
  const reference = channels.reference?.values;
  const recovery = channels.recovery?.values;
  $("#error-section").hidden = !(reference && surrogate);
  if (!reference || !surrogate) {
    fieldErrorCache = null;
    return;
  }

  const isCp = channelKey === "cp";
  const signed = isCp && $("#cp-error-mode").value === "signed";
  const standardScale = signed ? FIELD_DISPLAY.cpError : null;
  $("#cp-error-options").hidden = !isCp;
  $("#error-title").textContent = signed ? "Signed pressure coefficient error" : "Absolute error";
  $("#error-description").textContent = signed
    ? "Field minus cold-start CFD."
    : `Magnitude of the difference in ${channelLabel.toLowerCase()} from cold-start CFD.`;
  configureScaleControls("error", null, signed ? "Auto" : "0");

  if (!fieldErrorCache || fieldErrorCache.reference !== reference || fieldErrorCache.surrogate !== surrogate
      || fieldErrorCache.recovery !== recovery || fieldErrorCache.signed !== signed) {
    const differences = (values) => values?.map((value, index) => {
      const delta = value - reference[index];
      return signed ? delta : Math.abs(delta);
    });
    const surrogateError = differences(surrogate);
    const recoveryError = differences(recovery);
    const combined = recoveryError ? surrogateError.concat(recoveryError) : surrogateError;
    const halfRange = Math.max(1e-12, percentile(signed ? combined.map(Math.abs) : combined, 0.99));
    const defaultRange = [signed ? -halfRange : 0, halfRange];
    fieldErrorCache = {reference, surrogate, recovery, signed, surrogateError, recoveryError, defaultRange};
  }

  const {surrogateError, recoveryError, defaultRange} = fieldErrorCache;
  const title = standardScale?.title ?? (isCp ? "Absolute error, |ΔCₚ|" : "Absolute error");
  const display = fieldDisplay("error", defaultRange, title, signed ? "signed-cp" : "absolute", standardScale, ERROR_COLOR_STOPS);
  drawFlowField($("#error-surrogate"), state.stages.surrogate.field, display, surrogateError);
  $("#surrogate-error-mse").textContent = `(MSE ${formatNumber(meanSquaredError(surrogateError), 6)})`;
  const recoveryCanvas = $("#error-recovery");
  recoveryCanvas.closest("figure").hidden = !recoveryError;
  if (recoveryError) {
    drawFlowField(recoveryCanvas, state.stages.recovery.field, display, recoveryError);
    $("#recovery-error-mse").textContent = `(MSE ${formatNumber(meanSquaredError(recoveryError), 6)})`;
  }
  updateColorbar("#error-colorbar", display);
}

function renderFields() {
  const selector = $("#field-channel");
  const channelKey = selector.value;
  const name = selector.selectedOptions[0].textContent;
  const cpView = channelKey === "cp";
  const channelLabel = cpView ? "Pressure coefficient" : channelKey === "pressure" ? "Pressure ratio" : name;
  const standardScale = cpView ? FIELD_DISPLAY.cp : null;
  $("#field-title").textContent = `${channelLabel} fields`;
  configureScaleControls("field", standardScale);

  const channels = Object.fromEntries(Object.entries(state.stages).map(([key, stage]) => [key, displayedChannel(stage.field, channelKey)]));
  const available = Object.values(channels).filter(Boolean);
  let display;
  if (available.length) {
    const defaultRange = standardScale?.limits ?? [
      Math.min(...available.map(({range}) => range[0])),
      Math.max(...available.map(({range}) => range[1])),
    ];
    const [low, high] = defaultRange;
    const limits = high > low ? defaultRange : [low, low + Math.max(1, Math.abs(low)) * 1e-6];
    display = fieldDisplay("field", limits, name, cpView ? "cp" : "sequential", standardScale, FIELD_COLOR_STOPS);
  }
  for (const key of Object.keys(STAGE_LABELS)) {
    const canvas = $(`#field-${key}`);
    const channel = channels[key];
    canvas.hidden = !channel;
    $(`#field-${key}-empty`).hidden = !!channel;
    if (channel) drawFlowField(canvas, state.stages[key].field, display, channel.values);
  }
  updateColorbar("#shared-colorbar", display);
  renderFieldErrors(channels, channelKey, channelLabel);
}

function stageWallTime(key, stage) {
  if (!stage) return null;
  return key === "surrogate" ? stage.timing?.inference_wall_sec : stage.timing?.solver_wall_sec;
}

function dragBreakdown(stage) {
  if (!stage?.forces || !Number.isFinite(Number(stage.forces.cd))) return "—";
  const details = document.createElement("details"); details.className = "drag-breakdown";
  const summary = document.createElement("summary"); summary.textContent = formatNumber(stage.forces.cd, 6);
  const values = document.createElement("div");
  [["CDp", stage.forces.cdp], ["CDν", stage.forces.cdv]].forEach(([label, value]) => {
    const name = document.createElement("span"); name.textContent = label;
    const number = document.createElement("span"); number.textContent = formatNumber(value, 6);
    values.append(name, number);
  });
  details.append(summary, values);
  return details;
}

function forceDelta(stage, reference, key, digits) {
  const value = Number(stage?.forces?.[key]); const referenceValue = Number(reference?.forces?.[key]);
  if (!Number.isFinite(value) || !Number.isFinite(referenceValue)) return "—";
  const delta = value - referenceValue;
  const percent = Math.abs(referenceValue) < 1e-10 ? "—" : `${(100 * Math.abs(delta) / Math.abs(referenceValue)).toFixed(2)}%`;
  return `${formatNumber(delta, digits)} (${percent})`;
}

function renderMetrics() {
  const reference = state.stages.reference;
  const rows = [
    ["Lift coefficient, CL", (key, stage) => formatNumber(stage?.forces?.cl, 5)],
    ["Drag coefficient, CD", (_key, stage) => dragBreakdown(stage)],
    ["Moment coefficient, Cm", (key, stage) => formatNumber(stage?.forces?.cm, 5)],
    ["Residual L2 ratio", (key, stage) => formatNumber(stage?.residual?.final, 4)],
    ["Full-field MSE vs ADflow", (key, stage) => formatNumber(stage?.reference_mse, 6)],
    ["ΔCL vs ADflow", (_key, stage) => forceDelta(stage, reference, "cl", 5)],
    ["ΔCD vs ADflow", (_key, stage) => forceDelta(stage, reference, "cd", 6)],
    ["Model / solver wall time", (key, stage) => { const seconds = stageWallTime(key, stage); return seconds === null || seconds === undefined ? "—" : `${formatNumber(seconds, 3)} s`; }],
    ["Backend execution time (excludes queue / transfer)", (key, stage) => { const seconds = key === "surrogate" ? stage?.timing?.inference_wall_sec : stage?.timing?.request_wall_sec; return seconds === null || seconds === undefined ? "—" : `${formatNumber(seconds, 3)} s`; }],
  ];
  const body = $("#comparison-body"); body.replaceChildren();
  rows.forEach(([label, formatter]) => {
    const row = document.createElement("tr"); const heading = document.createElement("th"); heading.scope = "row"; heading.textContent = label; row.appendChild(heading);
    ["surrogate", "recovery", "reference"].forEach((key) => {
      const cell = document.createElement("td"); const content = formatter(key, state.stages[key]);
      if (content instanceof Node) cell.appendChild(content); else cell.textContent = content;
      row.appendChild(cell);
    }); body.appendChild(row);
  });
}

function renderResults() { renderCp(); renderCf(); renderMetrics(); renderFields(); }

async function loadRuntime() {
  const element = $("#system-status");
  const label = element.querySelector("span:last-child");
  try {
    const status = await api("/api/status"); state.surrogateOnline = Boolean(status.surrogate_online); state.solverReady = Boolean(status.solver_ready); state.mpiRanks = Number(status.resources?.cpu_ranks_per_case || 8);
    state.reynoldsPerMach = Number(status.resources?.reference_state?.reynolds) || DEFAULT_REYNOLDS_PER_MACH;
    syncReferenceState();
    syncMethodLabels();
    const online = state.surrogateOnline && state.solverReady;
    element.dataset.state = online ? "online" : "offline";
    const queued = Number(status.scheduler?.queue_depth || 0);
    label.textContent = online
      ? `Surrogate ready${status.prewarm ? " · runtime prewarmed" : ""}${queued ? ` · ${queued} queued` : ""}`
      : "Demo offline";
    if (!online) setMessage("Demo offline", true);
    updateEnabledState();
    return true;
  } catch {
    state.surrogateOnline = false;
    state.solverReady = false;
    element.dataset.state = "offline";
    label.textContent = "Demo offline";
    setMessage("Demo offline", true);
    updateEnabledState();
    return false;
  }
}

async function loadPresets() {
  const payload = await api("/api/presets"); payload.presets.forEach((preset) => { state.presets[preset.name.toLowerCase()] = preset; });
  state.existingGeometry = clone(state.presets.rae2822);
  renderAirfoilOptions();
  showAirfoilSource(null);
  setGeometry(state.existingGeometry); activateMode("existing", { loadGeometry: false }); updateEnabledState();
}

function appendAirfoilGroup(select, label, entries) {
  if (!entries.length) return;
  const group = document.createElement("optgroup"); group.label = label;
  entries.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.label;
    group.appendChild(option);
  });
  select.appendChild(group);
}

function renderAirfoilOptions() {
  const select = $("#airfoil-preset");
  const query = $("#airfoil-search").value.trim().toLowerCase();
  const matches = (entry) => !query || `${entry.name} ${entry.filename || ""} ${entry.description || ""}`.toLowerCase().includes(query);
  const localEntries = [
    { key: "local:rae2822", name: "RAE2822", label: "RAE2822", description: "Project preset" },
    { key: "local:oat15a", name: "OAT15A", label: "OAT15A", description: "Project preset" },
  ].filter(matches);
  const uiucEntries = state.uiucCatalog.filter(matches).map((entry) => ({
    ...entry,
    label: `${entry.name} — ${entry.description}`,
  }));
  select.replaceChildren();
  appendAirfoilGroup(select, "Project presets", localEntries);
  appendAirfoilGroup(select, "UIUC Airfoil Data Site", uiucEntries);
  if (Array.from(select.options).some((option) => option.value === state.selectedAirfoil)) {
    select.value = state.selectedAirfoil;
  } else {
    const placeholder = document.createElement("option");
    placeholder.value = ""; placeholder.textContent = "Choose a matching airfoil…";
    placeholder.selected = true; placeholder.disabled = true;
    select.prepend(placeholder);
  }
  if (state.uiucCatalog.length) {
    $("#airfoil-catalog-status").textContent = query
      ? `${uiucEntries.length} of ${state.uiucCatalog.length} UIUC airfoils match this search.`
      : `${state.uiucCatalog.length} locally stored UIUC airfoils passed the geometry and CST reconstruction checks.`;
  }
}

function showAirfoilSource(entry) {
  const description = $("#airfoil-description");
  const source = $("#airfoil-source");
  if (!entry) {
    description.textContent = "Project preset.";
    source.hidden = true;
    return;
  }
  description.textContent = entry.description;
  source.href = entry.coordinate_url;
  source.textContent = `UIUC source · ${entry.filename} ↗`;
  source.hidden = false;
}

async function selectExistingAirfoil(key) {
  if (!key) return;
  state.selectedAirfoil = key;
  if (key.startsWith("local:")) {
    const presetKey = key.slice("local:".length);
    state.existingGeometry = clone(state.presets[presetKey]);
    showAirfoilSource(null);
    setGeometry(state.existingGeometry);
    setMessage(`${state.existingGeometry.name} loaded.`);
    return;
  }
  const filename = key.slice("uiuc:".length);
  const entry = state.uiucCatalog.find((candidate) => candidate.filename.toLowerCase() === filename);
  setBusy(true, `Loading ${entry.name} from the local UIUC airfoil library…`);
  try {
    const payload = await api(`/api/uiuc/airfoil/${encodeURIComponent(entry.filename)}`);
    state.existingGeometry = clone(payload.geometry);
    showAirfoilSource(entry);
    setGeometry(state.existingGeometry);
    setMessage(`${entry.name} loaded from the local UIUC library.`);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function loadUiucCatalog() {
  try {
    const payload = await api("/api/uiuc/catalog");
    state.uiucCatalog = payload.airfoils;
    state.uiucSource = payload.source;
    renderAirfoilOptions();
  } catch (error) {
    $("#airfoil-catalog-status").textContent = `Local UIUC catalog unavailable: ${error.message}`;
    renderAirfoilOptions();
  }
}

function applyMeshResult(payload) {
  state.mesh = payload;
  $("#mesh-status").classList.add("ready");
  const shape = Array.isArray(payload.mesh_shape) ? `${payload.mesh_shape[0]} × ${payload.mesh_shape[1]} cells` : "84 × 304 cells";
  $("#mesh-status").textContent = `${shape} · ${Number(payload.cell_count || 25536).toLocaleString()} cells · mesh ${payload.mesh_wall_sec.toFixed(2)} s · ADflow preparation ${payload.adflow_prepare_wall_sec.toFixed(2)} s · MPI ${payload.mpi_ranks}`;
}

function storedActiveJob() {
  try { return JSON.parse(window.sessionStorage.getItem(ACTIVE_JOB_STORAGE_KEY) || "null"); }
  catch { return null; }
}

function restoreCaseRunDraft(draft) {
  if (!draft?.geometry) return;
  const {geometry, geometryMode, existingGeometry, customGeometry, uploadedGeometry, selectedAirfoil, mesh, handleCount, inputs} = draft;
  Object.assign(state, {existingGeometry, customGeometry, uploadedGeometry, selectedAirfoil, handleCount});
  for (const id of CASE_INPUTS) $(`#${id}`).value = inputs[id];
  $("#mach-range").value = $("#mach").value;
  $("#aoa-range").value = $("#aoa").value;
  $("#handle-count").value = String(handleCount);
  syncReferenceState();
  syncMethodLabels();
  renderAirfoilOptions();
  showAirfoilSource(state.uiucCatalog.find((entry) => entry.key === selectedAirfoil));
  activateMode(geometryMode, {loadGeometry: false});
  setGeometry(geometry);
  if (mesh) applyMeshResult(mesh);
}

async function withSolverLock(work, caseRun = null) {
  if (state.busy) return;
  state.caseRun = caseRun;
  setBusy(true);
  try { await work(); }
  catch (error) { setMessage(error.message, error.jobState !== "cancelled"); }
  finally {
    state.caseRun = null;
    setBusy(false);
  }
}

function resumeActiveJob(saved) {
  if (!saved?.jobId || !saved?.action) return;
  const caseRun = saved.caseRun ? {stopRequested: Boolean(saved.caseRun.stopRequested)} : null;
  return withSolverLock(async () => {
    restoreCaseRunDraft(saved.caseRun?.draft);
    state.activeJobId = saved.jobId;
    state.activeJobAction = saved.action;
    setMessage(`Restoring ${JOB_LABELS[saved.action] || "compute job"} status…`);
    const result = await waitForJob(saved.jobId);
    if (saved.action === "mesh") {
      applyMeshResult(result);
      setMessage("Mesh generation complete.");
    } else {
      const restored = result.payload_mode === "delta" && result.case_id
        ? await api(`/api/cases/${result.case_id}`)
        : result;
      syncCase(restored, {replace: true});
      setMessage(`${JOB_LABELS[saved.action] || "Compute job"} complete.`);
    }
    if (caseRun) await finishCaseRun(saved.action);
  }, caseRun);
}

async function generateMesh() {
  setMessage(`Generating the pyHyp O-grid and preparing the resident ${state.mpiRanks}-rank ADflow solver…`);
  const payload = await runQueuedJob("mesh", {geometry27: state.geometry.geometry27, name: state.geometry.name});
  applyMeshResult(payload);
  setMessage("Mesh generated and the geometry-matched ADflow solver is resident. Surrogate prediction is ready.");
}

async function runPrediction() {
  setMessage("Evaluating the Surrogate and formal force/residual metrics…");
  setStageCard("surrogate", "Running", "running");
  try {
    const steps = Number($("#surrogate-steps").value);
    const payload = await runQueuedJob("predict", {
      geometry27: state.geometry.geometry27,
      name: state.geometry.name,
      mach: Number($("#mach").value),
      aoa: Number($("#aoa").value),
      n_inference_steps: steps,
    });
    syncCase(payload);
    setMessage(`Surrogate complete in ${payload.stage.timing.inference_wall_sec.toFixed(2)} s using ${steps} prediction steps.`);
  } catch (error) {
    setStageCard("surrogate", error.jobState === "cancelled" ? "Ready" : "Failed", "active");
    throw error;
  }
}

async function runRecovery() {
  if (!state.case) return;
  const residualExponent = Number($("#nk-stop-exponent").value);
  const thresholdLabel = powerOfTenLabel(-residualExponent);
  setMessage(`Running NK correction toward residual L2 ratio ${thresholdLabel} with a fixed compute budget…`);
  setStageCard("recovery", "Running", "running");
  try {
    const payload = await runQueuedJob("recover", {case_id: state.case.case_id, residual_exponent: residualExponent});
    syncCase(payload);
    const recovery = payload.recovery;
    setMessage(recovery.converged
      ? `Surrogate + NK converged to the requested target (MPI ${state.mpiRanks}).`
      : `Surrogate + NK used its fixed compute budget and stopped with ${recovery.termination}; target ${thresholdLabel} (MPI ${state.mpiRanks}).`);
  } catch (error) {
    setStageCard("recovery", error.jobState === "cancelled" ? "Awaiting request" : "Failed", "active");
    throw error;
  }
}

async function finishCaseRun(completedAction) {
  const stages = {mesh: generateMesh, predict: runPrediction, recover: runRecovery, reference: runReference};
  const sequence = Object.keys(stages);
  const start = completedAction ? sequence.indexOf(completedAction) + 1 : (state.mesh ? 1 : 0);
  for (const action of sequence.slice(start)) {
    if (state.caseRun.stopRequested) {
      setMessage("Case run stopped.");
      return;
    }
    await stages[action]();
  }
}

function runCase() {
  if (!CASE_INPUTS.every((id) => $(`#${id}`).reportValidity())) return;
  return withSolverLock(() => finishCaseRun(), {stopRequested: false});
}

async function runReference() {
  if (!state.case) return;
  setMessage(`Running cold-start ADflow from uniform flow on ${state.mpiRanks} MPI ranks…`);
  setStageCard("reference", "Running", "running");
  try {
    const payload = await runQueuedJob("reference", { case_id: state.case.case_id, max_cycles: 3000 });
    syncCase(payload); setMessage(payload.reference.converged
      ? "ADflow reached its residual target. Field-error maps and all three comparisons are now available."
      : `ADflow stopped: ${payload.reference.termination || "target not reached"}. Comparisons use this unconverged result.`);
  } catch (error) {
    setStageCard("reference", error.jobState === "cancelled" ? "Optional" : "Failed", "");
    throw error;
  }
}

function runReferenceManually() {
  if (!window.confirm(`Cold-start ADflow uses ${state.mpiRanks} MPI ranks and may take several minutes. Run the reference solve now?`)) return;
  return withSolverLock(runReference);
}

function bindRange(rangeSelector, numberSelector, callback = null) {
  const range = $(rangeSelector); const number = $(numberSelector);
  range.addEventListener("input", () => { number.value = range.value; if (callback) callback(); clearCase(); });
  number.addEventListener("input", () => { range.value = number.value; if (callback) callback(); clearCase(); });
}

function updateHandleCount(rawValue, { commit = false } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return;
  if (!commit && (parsed < MIN_HANDLE_COUNT || parsed > MAX_HANDLE_COUNT)) return;
  const count = Math.max(MIN_HANDLE_COUNT, Math.min(MAX_HANDLE_COUNT, Math.round(parsed)));
  state.handleCount = count;
  if (commit) $("#handle-count").value = String(count);
  drawGeometry();
}

function wireEvents() {
  $("#run-case").addEventListener("click", runCase);
  $("#mesh-button").addEventListener("click", () => withSolverLock(generateMesh));
  $("#predict-button").addEventListener("click", () => withSolverLock(runPrediction));
  $("#recover-button").addEventListener("click", () => withSolverLock(runRecovery));
  $("#reference-button").addEventListener("click", runReferenceManually);
  $("#cancel-job").addEventListener("click", cancelActiveJob);
  $$(".mode-tab").forEach((button) => button.addEventListener("click", () => activateMode(button.dataset.mode)));
  $("#airfoil-search").addEventListener("input", renderAirfoilOptions);
  $("#airfoil-preset").addEventListener("change", (event) => selectExistingAirfoil(event.target.value));
  $("#handle-count").addEventListener("input", (event) => updateHandleCount(event.target.value));
  $("#handle-count").addEventListener("change", (event) => updateHandleCount(event.target.value, { commit: true }));
  $("#reset-geometry").addEventListener("click", () => {
    const baseGeometry = state.uploadedGeometry || state.existingGeometry;
    if (!baseGeometry) return;
    state.handleCount = DEFAULT_HANDLE_COUNT;
    $("#handle-count").value = String(DEFAULT_HANDLE_COUNT);
    state.customGeometry = clone(baseGeometry);
    activateMode("custom", { loadGeometry: false });
    setGeometry(baseGeometry);
    setMessage(state.uploadedGeometry
      ? "Custom geometry reset to the latest uploaded airfoil."
      : `Custom geometry reset to the current Existing airfoil (${state.existingGeometry.name}).`);
  });
  $("#coordinate-file").addEventListener("change", async (event) => {
    const [file] = event.target.files; if (!file) return; setBusy(true, `Importing ${file.name}…`);
    try {
      const geometry = await api("/api/geometry/import", { method: "POST", body: JSON.stringify({ filename: file.name, content: await file.text() }) });
      state.uploadedGeometry = clone(geometry); activateMode("upload", { loadGeometry: false }); setGeometry(geometry); setMessage(`${file.name} imported. Generate its mesh before prediction.`);
    } catch (error) { setMessage(error.message, true); } finally { event.target.value = ""; setBusy(false); }
  });
  bindRange("#mach-range", "#mach", syncReferenceState); bindRange("#aoa-range", "#aoa");
  $("#surrogate-steps").addEventListener("input", () => { syncMethodLabels(); clearCase(); });
  $("#nk-stop-exponent").addEventListener("input", syncMethodLabels);
  $("#field-channel").addEventListener("change", () => {
    restoreScaleInputs("field");
    restoreScaleInputs("error");
    void ensureFieldChannel();
  });
  $("#cp-error-mode").addEventListener("change", () => {
    restoreScaleInputs("error");
    renderFields();
  });
  for (const prefix of ["field", "error"]) {
    for (const input of scaleInputs(prefix)) {
      input.addEventListener("input", () => { rememberScaleInputs(prefix); scheduleFields(); });
    }
    $(`#${prefix}-scale-auto`).addEventListener("click", () => {
      savedScaleInputs.delete(scaleInputKey(prefix));
      restoreScaleInputs(prefix);
      renderFields();
    });
  }
  window.addEventListener("resize", () => { if (Object.values(state.stages).some((stage) => stage.field)) scheduleFields(); });
}

async function init() {
  drawEditorGrid(); wireEvents(); syncMethodLabels(); syncReferenceState();
  if (!await loadRuntime()) return;
  await Promise.all([loadPresets(), loadUiucCatalog()]);
  updateEnabledState();
  const saved = storedActiveJob();
  if (saved) {
    await resumeActiveJob(saved);
  } else if (state.surrogateOnline && state.solverReady) {
    setMessage("Choose a geometry and flow conditions, then run the case.");
  }
}

init().catch((error) => {
  if ($("#system-status").dataset.state !== "offline") setMessage(error.message, true);
});
