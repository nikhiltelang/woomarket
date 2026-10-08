/**
 * The embeddable chat widget (served as /widget.js). Plain ES2017, no dependencies, rendered
 * inside a shadow root so the host page's CSS can't leak in or out. All text is set with
 * textContent: nothing from the server or the visitor is ever parsed as HTML.
 *
 * <script src="https://app.example.com/widget.js" data-widget="WIDGET_ID" async></script>
 */
export const WIDGET_JS = String.raw`(function () {
  "use strict";
  var script = document.currentScript || document.querySelector("script[data-widget]");
  if (!script) return;
  var widgetId = script.getAttribute("data-widget");
  var preview = script.getAttribute("data-preview") === "true";
  if (!widgetId || window["__wm360_" + widgetId]) return;
  window["__wm360_" + widgetId] = true;
  var base = new URL(script.src, location.href).origin;
  var api = base + "/api/widget/" + encodeURIComponent(widgetId);
  var storeKey = "wm360-chat-" + widgetId;

  function load() { try { return JSON.parse(localStorage.getItem(storeKey) || "{}"); } catch (e) { return {}; } }
  function save(v) { try { localStorage.setItem(storeKey, JSON.stringify(v)); } catch (e) {} }
  var state = load();
  var messages = [];
  var lastId = null;
  var open = false;
  var unread = 0;
  var timer = null;
  var cfg = null;

  function request(method, path, body) {
    var headers = { "Content-Type": "application/json" };
    if (state.token) headers["X-Widget-Token"] = state.token;
    return fetch(api + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "omit" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || "Something went wrong"); e.status = r.status; e.code = j.code; throw e; }
        return j;
      });
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var ICON_CHAT = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_WA = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M17.5 14.4c-.3-.1-1.8-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1-.3-.1-1.3-.5-2.4-1.5-.9-.8-1.5-1.8-1.7-2.1-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.1 3.2 5.1 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.8-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.3zM12 21.8c-1.8 0-3.5-.5-5-1.4l-.4-.2-3.7 1 1-3.6-.2-.4c-1-1.6-1.5-3.4-1.5-5.2C2.2 6.6 6.6 2.2 12 2.2c2.6 0 5.1 1 6.9 2.9 1.8 1.8 2.9 4.3 2.9 6.9 0 5.4-4.4 9.8-9.8 9.8zm8.3-18.1C18.1 1.5 15.1.2 12 .2 5.5.2.2 5.5.2 12c0 2.1.5 4.1 1.6 5.9L.1 24l6.3-1.7c1.7.9 3.7 1.4 5.6 1.4 6.5 0 11.8-5.3 11.8-11.8 0-3.2-1.2-6.1-3.5-8.2z"/></svg>';

  function css(c, pos) {
    return ":host{all:initial}[hidden]{display:none!important}" +
      "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}" +
      ".wrap{position:fixed;bottom:20px;" + pos + ":20px;z-index:2147483000;display:flex;flex-direction:column;align-items:" + (pos === "left" ? "flex-start" : "flex-end") + ";gap:12px}" +
      ".launcher{width:58px;height:58px;border-radius:50%;border:0;background:" + c + ";color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);position:relative}" +
      ".launcher:focus-visible,button:focus-visible,textarea:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid " + c + ";outline-offset:2px}" +
      ".badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#dc2626;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px}" +
      ".panel{width:min(370px,calc(100vw - 32px));height:min(560px,calc(100vh - 110px));background:#fff;color:#111827;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:flex;flex-direction:column;overflow:hidden}" +
      ".head{background:" + c + ";color:#fff;padding:16px 16px 14px;display:flex;gap:8px;align-items:flex-start}" +
      ".head h2{margin:0;font-size:16px;font-weight:700;line-height:1.3}.head p{margin:2px 0 0;font-size:13px;opacity:.9}" +
      ".head .x{margin-left:auto;background:transparent;border:0;color:#fff;cursor:pointer;padding:2px;border-radius:6px}" +
      ".body{flex:1;overflow-y:auto;padding:14px;background:#f5f6f8;display:flex;flex-direction:column;gap:8px}" +
      ".msg{max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}" +
      ".agent{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}" +
      ".visitor{align-self:flex-end;background:" + c + ";color:#fff;border-bottom-right-radius:4px}" +
      ".who{font-size:11px;color:#6b7280;margin:0 0 2px 4px}" +
      ".foot{border-top:1px solid #e5e7eb;padding:10px;display:flex;flex-direction:column;gap:8px;background:#fff}" +
      ".row{display:flex;gap:8px;align-items:flex-end}" +
      "textarea,input{width:100%;border:1px solid #d1d5db;border-radius:10px;padding:9px 11px;font-size:14px;color:#111827;background:#fff;resize:none}" +
      "textarea{min-height:40px;max-height:110px}" +
      ".send{border:0;background:" + c + ";color:#fff;border-radius:10px;padding:0 14px;height:40px;font-size:14px;font-weight:600;cursor:pointer;flex-shrink:0}" +
      ".send:disabled{opacity:.5;cursor:default}" +
      ".wa{display:flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;background:#25d366;color:#fff;border-radius:10px;padding:10px;font-size:14px;font-weight:600}" +
      ".err{color:#b91c1c;font-size:12px;margin:0}.note{color:#6b7280;font-size:12px;text-align:center;margin:0}" +
      ".hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}" +
      "@media (max-width:480px){.wrap{bottom:12px;" + pos + ":12px}.panel{height:calc(100vh - 96px)}}";
  }

  function build() {
    var s = cfg.settings;
    var host = el("div");
    host.setAttribute("data-wm360-widget", widgetId);
    document.body.appendChild(host);
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = el("style");
    style.textContent = css(/^#[0-9a-f]{6}$/i.test(s.color) ? s.color : "#16a34a", s.position === "left" ? "left" : "right");
    root.appendChild(style);
    var wrap = el("div", "wrap");
    root.appendChild(wrap);

    var panel = el("div", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", s.title);
    panel.hidden = true;
    var head = el("div", "head");
    var titles = el("div");
    titles.appendChild(el("h2", null, s.title));
    if (s.subtitle) titles.appendChild(el("p", null, s.subtitle));
    head.appendChild(titles);
    var x = el("button", "x");
    x.setAttribute("aria-label", "Close chat");
    x.innerHTML = ICON_CLOSE;
    head.appendChild(x);
    panel.appendChild(head);

    var body = el("div", "body");
    body.setAttribute("aria-live", "polite");
    panel.appendChild(body);
    var foot = el("div", "foot");
    panel.appendChild(foot);

    var launcher = el("button", "launcher");
    launcher.setAttribute("aria-label", "Open chat");
    launcher.innerHTML = ICON_CHAT;
    var badge = el("span", "badge");
    badge.hidden = true;
    launcher.appendChild(badge);
    wrap.appendChild(panel);
    wrap.appendChild(launcher);

    var err = el("p", "err");
    err.hidden = true;
    function showError(m) { err.textContent = m; err.hidden = !m; }

    function render() {
      body.textContent = "";
      if (s.greeting) { var g = el("div", "msg agent", s.greeting); body.appendChild(g); }
      messages.forEach(function (m) {
        if (m.from === "agent" && m.agentName) body.appendChild(el("p", "who", m.agentName));
        body.appendChild(el("div", "msg " + (m.from === "visitor" ? "visitor" : "agent"), m.text));
      });
      body.scrollTop = body.scrollHeight;
    }

    // Footer: WhatsApp button and/or the composer (with pre-chat fields before the first message).
    var fields = {};
    var composer = el("div", "row");
    var ta = el("textarea");
    ta.setAttribute("rows", "1");
    ta.setAttribute("aria-label", "Message");
    ta.setAttribute("maxlength", "2000");
    ta.placeholder = "Type your message…";
    var send = el("button", "send", "Send");
    composer.appendChild(ta);
    composer.appendChild(send);
    var hp = el("input", "hp");
    hp.setAttribute("tabindex", "-1");
    hp.setAttribute("autocomplete", "off");
    hp.setAttribute("aria-hidden", "true");

    function addField(key, label, type, ac) {
      var i = el("input");
      i.type = type;
      i.placeholder = label + (cfg.settings.liveChat.requireDetails ? "" : " (optional)");
      i.setAttribute("aria-label", label);
      i.setAttribute("autocomplete", ac);
      fields[key] = i;
      foot.appendChild(i);
    }
    if (cfg.liveChat && !state.token) {
      if (s.liveChat.askName) addField("name", "Your name", "text", "name");
      if (s.liveChat.askEmail) addField("email", "Email", "email", "email");
      if (s.liveChat.askPhone) addField("phone", "Phone (with country code)", "tel", "tel");
    }
    if (cfg.liveChat) {
      foot.appendChild(hp);
      foot.appendChild(composer);
      foot.appendChild(err);
    }
    if (cfg.whatsappUrl) {
      var wa = el("a", "wa");
      wa.href = cfg.whatsappUrl;
      wa.target = "_blank";
      wa.rel = "noopener noreferrer";
      wa.innerHTML = ICON_WA;
      wa.appendChild(document.createTextNode(" " + (s.whatsapp.label || "Chat on WhatsApp")));
      foot.appendChild(wa);
    }

    function clearFields() {
      Object.keys(fields).forEach(function (k) { fields[k].remove(); });
      fields = {};
    }

    function submit() {
      var text = ta.value.trim();
      if (!text || send.disabled) return;
      send.disabled = true;
      showError("");
      var p;
      if (!state.token) {
        p = request("POST", "/chats", {
          message: text,
          name: fields.name ? fields.name.value.trim() : undefined,
          email: fields.email ? fields.email.value.trim() : undefined,
          phone: fields.phone ? fields.phone.value.trim() : undefined,
          page: location.href.slice(0, 500),
          website: hp.value || undefined
        }).then(function (r) {
          state = { token: r.data.token };
          save(state);
          clearFields();
          messages = r.data.messages;
          lastId = messages.length ? messages[messages.length - 1].id : null;
        });
      } else {
        p = request("POST", "/messages", { text: text }).then(function (r) {
          messages.push(r.data);
          lastId = r.data.id;
        });
      }
      p.then(function () { ta.value = ""; render(); schedule(); })
        .catch(function (e) {
          if (e.code === "CHAT_NOT_FOUND") { state = {}; save(state); messages = []; lastId = null; }
          showError(e.message);
        })
        .then(function () { send.disabled = false; ta.focus(); });
    }
    send.addEventListener("click", submit);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    });

    function poll() {
      if (!state.token || !cfg.liveChat) return Promise.resolve();
      return request("GET", "/messages" + (lastId ? "?after=" + encodeURIComponent(lastId) : ""))
        .then(function (r) {
          var fresh = r.data.filter(function (m) { return !messages.some(function (x) { return x.id === m.id; }); });
          if (!fresh.length) return;
          messages = messages.concat(fresh);
          lastId = messages[messages.length - 1].id;
          var replies = fresh.filter(function (m) { return m.from === "agent"; }).length;
          if (!open && replies) { unread += replies; badge.textContent = String(unread); badge.hidden = false; }
          render();
        })
        .catch(function (e) {
          if (e.status === 401) { state = {}; save(state); messages = []; lastId = null; render(); }
        });
    }
    function schedule() {
      clearTimeout(timer);
      if (!state.token || document.hidden) return;
      timer = setTimeout(function () { poll().then(schedule); }, open ? 3000 : 20000);
    }
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { poll(); schedule(); } });

    function toggle(next) {
      open = next;
      panel.hidden = !open;
      launcher.innerHTML = open ? ICON_CLOSE : ICON_CHAT;
      launcher.appendChild(badge);
      launcher.setAttribute("aria-label", open ? "Close chat" : "Open chat");
      launcher.setAttribute("aria-expanded", String(open));
      if (open) { unread = 0; badge.hidden = true; poll(); setTimeout(function () { ta.focus(); }, 50); }
      schedule();
    }
    launcher.addEventListener("click", function () { toggle(!open); });
    x.addEventListener("click", function () { toggle(false); launcher.focus(); });
    root.addEventListener("keydown", function (e) { if (e.key === "Escape" && open) { toggle(false); launcher.focus(); } });

    render();
    if (state.token) poll().then(schedule);
    if (preview) toggle(true);
  }

  request("GET", "/config")
    .then(function (r) {
      cfg = r.data;
      if (!cfg.liveChat && !cfg.whatsappUrl) return;
      var start = function () { setTimeout(build, preview ? 0 : (cfg.settings.delaySeconds || 0) * 1000); };
      if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
    })
    .catch(function () {});
})();
`;
