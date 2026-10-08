"use strict";
/*
 * error_report.js — surface uncaught errors so a hosted beta isn't a black box.
 *
 * On a window error / unhandled rejection, show one small dismissible toast with a
 * "Report" button that opens a prefilled GitHub issue (error, stack, URL, browser, time).
 * Opt-in: nothing is sent unless the tester clicks Report. No network, no logging
 * service. Set REPORT_ISSUES_URL to where feedback should go.
 */
(function () {
  const REPORT_ISSUES_URL = "https://github.com/lucanenni/valeton-gp150-editor/issues/new"; // bug reports land here
  let active = false; // one toast at a time

  const CSS = `
    #err-report { position: fixed; z-index: 10000; left: 50%; bottom: 1.2rem; transform: translateX(-50%);
      display: flex; align-items: center; gap: .6rem; max-width: min(94vw, 30rem);
      background: var(--card, #fff); color: var(--text, #16181d); border: 1px solid var(--border, #e2e4e8);
      border-left: 4px solid #d8434a; border-radius: 10px; padding: .6rem .8rem;
      box-shadow: 0 10px 30px rgba(0,0,0,.28); font: 14px/1.4 system-ui, sans-serif; }
    #err-report .er-msg { flex: 1; min-width: 0; }
    #err-report .er-msg small { color: var(--muted, #6b7280); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #err-report button { font: inherit; font-weight: 600; padding: .35rem .7rem; border-radius: 7px; cursor: pointer; border: 1px solid var(--border, #cbd0d6); background: transparent; color: inherit; }
    #err-report .er-report { background: #d8434a; border-color: #d8434a; color: #fff; }`;

  function detailsOf(e) {
    let msg = "unknown error", stack = "";
    if (e && e.error) { msg = e.error.message || String(e.error); stack = e.error.stack || ""; }
    else if (e && e.reason) { msg = (e.reason.message || String(e.reason)); stack = e.reason.stack || ""; }
    else if (e && e.message) { msg = e.message; }
    if (e && e.filename) stack = stack || `${e.filename}:${e.lineno}:${e.colno}`;
    return { msg: String(msg).slice(0, 300), stack: String(stack).slice(0, 2000) };
  }

  function ensureStyle() {
    if (document.getElementById("err-report-style")) return;
    const s = document.createElement("style"); s.id = "err-report-style"; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function report(e) {
    if (active || !document.body) return;
    active = true;
    ensureStyle();
    const { msg, stack } = detailsOf(e);
    const el = document.createElement("div");
    el.id = "err-report";
    el.innerHTML = `
      <div class="er-msg">⚠️ Something went wrong.<small>${msg.replace(/</g, "&lt;")}</small></div>
      <button class="er-report">Report</button>
      <button class="er-x" aria-label="Dismiss">✕</button>`;
    document.body.appendChild(el);
    const close = () => { el.remove(); active = false; };
    el.querySelector(".er-x").addEventListener("click", close);
    el.querySelector(".er-report").addEventListener("click", () => {
      const body =
        "What I was doing when this happened:\n\n\n" +
        "---- technical details (please keep) ----\n" +
        `${msg}\n${stack}\n\nPage: ${location.href}\nBrowser: ${navigator.userAgent}\nTime: ${new Date().toISOString()}`;
      const href = `${REPORT_ISSUES_URL}?title=${encodeURIComponent("Bug: " + msg.slice(0, 80))}&body=${encodeURIComponent(body)}`;
      window.open(href, "_blank", "noopener");
      close();
    });
    setTimeout(() => { if (document.getElementById("err-report") === el) close(); }, 15000);
  }

  window.addEventListener("error", report);
  window.addEventListener("unhandledrejection", report);
  window.__errorReport = { report }; // for a manual test
})();
