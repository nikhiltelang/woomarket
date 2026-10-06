import { api, getCsrf, toast, escapeHtml, formatDate, loadUser } from "/assets/common.js";

const STEPS = [
  ["backup", "Backing up current version"],
  ["replace", "Replacing application files"],
  ["dependencies", "Installing dependencies"],
  ["build", "Building application"],
  ["database", "Updating database schema"],
  ["restart", "Restarting application"],
  ["complete", "Complete"],
];
const PROGRESS = { backup: 10, replace: 25, dependencies: 45, build: 65, database: 80, restart: 95, complete: 100 };
const ICONS = { done: "✓", warning: "!", error: "✕" };

const $ = (id) => document.getElementById(id);
let status = null;
let streaming = false;

function renderSteps(states = {}) {
  $("steps").innerHTML = STEPS.map(
    ([key, label]) =>
      `<li class="${states[key] || ""}" data-step="${key}"><span class="icon">${ICONS[states[key]] || ""}</span>${label}</li>`,
  ).join("");
}

function setProgress(pct, state = "") {
  $("progress").className = `progress ${state}`;
  $("progress-bar").style.width = `${pct}%`;
}

function logLine(ev) {
  const time = new Date(ev.at || Date.now()).toLocaleTimeString();
  return `<span class="${escapeHtml(ev.status)}">[${time}] ${escapeHtml(ev.step)}:${escapeHtml(ev.status)}</span> ${escapeHtml(ev.message || "")}`;
}

function renderStatus(s) {
  status = s;
  $("current-version").textContent = `v${s.currentVersion}`;
  $("lock-state").innerHTML = s.updateInProgress
    ? `<span class="badge running"><span class="spinner"></span>${escapeHtml(s.lockKind || "update")} in progress</span>`
    : "No update in progress";

  $("backup-info").innerHTML = s.backup
    ? `<strong>Backup Available</strong>: v${escapeHtml(s.backup.version)}<br><span class="muted">Created ${escapeHtml(formatDate(s.backup.createdAt))}</span>`
    : "No backup available";
  $("rollback-btn").disabled = !s.backup || s.updateInProgress || streaming;

  $("pending").innerHTML = s.pendingUpload
    ? `<span class="badge success">Version ${escapeHtml(s.pendingUpload.newVersion)} ready to install</span>
       <span class="muted">${escapeHtml(s.pendingUpload.originalName || "")} · uploaded ${escapeHtml(formatDate(s.pendingUpload.uploadedAt))}</span>`
    : "";
  $("apply-btn").disabled = !s.pendingUpload || s.updateInProgress || streaming;
  $("upload-btn").disabled = s.updateInProgress || streaming;

  renderLastRun(s.lastRun, s.updateInProgress);
}

function renderLastRun(run, inProgress) {
  if (!run) {
    $("last-run").innerHTML = "No previous runs.";
    return;
  }
  const live = run.status === "running" && inProgress;
  const badge = live
    ? `<span class="badge running"><span class="spinner"></span>running</span>`
    : `<span class="badge ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>`;
  const versions = run.kind === "rollback" ? `rollback v${run.fromVersion} → v${run.toVersion}` : `v${run.fromVersion} → v${run.toVersion}`;
  $("last-run").innerHTML = `
    <div class="row" style="margin-top:0">${badge}<strong>${escapeHtml(versions)}</strong>
      <span class="muted">by ${escapeHtml(run.startedBy)} · ${escapeHtml(formatDate(run.startedAt))}</span></div>
    ${run.message ? `<p>${escapeHtml(run.message)}</p>` : ""}
    ${run.events?.length ? `<pre class="log">${run.events.map(logLine).join("\n")}</pre>` : ""}`;
}

async function refresh() {
  try {
    renderStatus(await api("/api/app-update/status"));
  } catch (err) {
    toast(err.message, "error");
  }
}

async function uploadRelease(e) {
  e.preventDefault();
  const file = $("file-input").files[0];
  if (!file) return toast("Choose a release ZIP first", "warning");
  const form = new FormData();
  form.append("file", file);
  $("upload-btn").disabled = true;
  $("upload-btn").textContent = "Uploading…";
  try {
    const res = await api("/api/app-update/upload", { method: "POST", body: form });
    toast(`Version ${res.newVersion} ready to install`, "success");
    $("upload-form").reset();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("upload-btn").textContent = "Upload";
    await refresh();
  }
}

async function applyUpdate() {
  const target = status?.pendingUpload?.newVersion;
  if (!confirm(`Apply update to v${target}? The application will be backed up, rebuilt, and restarted.`)) return;

  streaming = true;
  const states = {};
  let finalEvent = null;
  renderSteps(states);
  setProgress(2);
  $("log").innerHTML = "";
  renderStatus({ ...status, updateInProgress: true, lockKind: "execute" });

  const handle = (ev) => {
    $("log").innerHTML += `${$("log").innerHTML ? "\n" : ""}${logLine(ev)}`;
    $("log").scrollTop = $("log").scrollHeight;
    if (PROGRESS[ev.step] !== undefined) {
      states[ev.step] = ev.status;
      renderSteps(states);
      if (ev.status !== "error") setProgress(ev.status === "running" ? PROGRESS[ev.step] - 5 : PROGRESS[ev.step]);
    }
    if (ev.status === "error" && ev.step !== "rollback") {
      setProgress(parseFloat($("progress-bar").style.width) || 5, "error");
      finalEvent = ev;
    }
    if (ev.step === "complete" && ev.status === "done") {
      setProgress(100, "success");
      finalEvent = ev;
    }
    if (ev.step === "rollback" && (ev.status === "done" || ev.status === "error")) finalEvent = ev;
  };

  try {
    const res = await fetch("/api/app-update/execute", {
      method: "POST",
      headers: { "X-CSRF-Token": await getCsrf() },
      credentials: "same-origin",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop();
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (line) handle(JSON.parse(line.slice(5).trim()));
      }
    }

    if (!finalEvent) toast("Connection closed before the update reported a result. The server may be restarting; refresh in a moment.", "warning", 10000);
    else if (finalEvent.step === "complete") toast(finalEvent.message, "success", 10000);
    else if (finalEvent.step === "rollback" && finalEvent.status === "done") toast(`Update failed and was rolled back. ${finalEvent.message}`, "error", 10000);
    else toast(finalEvent.message, "error", 10000);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    streaming = false;
    await refresh();
  }
}

async function rollback() {
  const version = status?.backup?.version;
  if (!confirm(`Roll back to v${version}? The current version will be replaced by the backup.`)) return;
  $("rollback-btn").disabled = true;
  $("rollback-btn").textContent = "Rolling back…";
  try {
    const res = await api("/api/app-update/rollback", { method: "POST" });
    toast(`Rolled back to v${res.restoredVersion}`, "success");
    for (const w of res.warnings || []) toast(w, "warning", 10000);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("rollback-btn").textContent = "Rollback to Previous Version";
    await refresh();
  }
}

$("upload-form").addEventListener("submit", uploadRelease);
$("apply-btn").addEventListener("click", applyUpdate);
$("rollback-btn").addEventListener("click", rollback);

renderSteps();
await loadUser();
await refresh();
// Keep the panel in sync with updates started from another tab/session.
setInterval(() => !streaming && refresh(), 10000);
