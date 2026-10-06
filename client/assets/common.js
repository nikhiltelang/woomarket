let csrfToken = null;

export async function getCsrf(force = false) {
  if (csrfToken && !force) return csrfToken;
  const res = await fetch("/api/csrf-token", { credentials: "same-origin" });
  csrfToken = (await res.json()).token;
  return csrfToken;
}

export async function api(url, { method = "GET", body } = {}) {
  const headers = {};
  if (method !== "GET") headers["X-CSRF-Token"] = await getCsrf();
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: "same-origin" });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && !url.startsWith("/api/auth/login")) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  }
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(message, type = "info", ms = 6000) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : "unknown time";
}

export async function loadUser() {
  const { user } = await api("/api/auth/me");
  const el = document.getElementById("user-name");
  if (el) el.textContent = `${user.username} (${user.role})`;
  document.getElementById("logout-btn")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/login";
  });
  return user;
}
