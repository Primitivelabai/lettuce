import { mascotSvg } from './mascot.js';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const CSS = String.raw`
:root {
  --bg: #f3eee4; --grid: rgba(31, 27, 22, 0.05); --ink: #1f1b16; --muted: #6b645a; --line: #d9d0c1;
  --card: #fffdf8; --inset: #f7f1e6; --mint: #8fdcae; --green: #2f9e5f; --pill: #e3f6ea;
  --key: #1f1b16; --str: #8a5a2b; --lit: #7a4bb0; --num: #2f6fb0;
  --yes-bg: #1f1b16; --yes-ink: #fffdf8; --warn-bg: #fbe5d0; --warn-line: #e0a46b;
  --ok-bg: #e3f6ea; --ok-line: #2f9e5f;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1915; --grid: rgba(241, 236, 226, 0.045); --ink: #f1ece2; --muted: #a39c90; --line: #4a443b;
    --card: #24201b; --inset: #1a1713; --mint: #7ed9a2; --green: #7ed9a2; --pill: rgba(126, 217, 162, 0.14);
    --key: #f1ece2; --str: #e3b27a; --lit: #c59cf0; --num: #8cc4f5;
    --yes-bg: #7ed9a2; --yes-ink: #13110e; --warn-bg: #3a2a1c; --warn-line: #c98a4e;
    --ok-bg: rgba(126, 217, 162, 0.12); --ok-line: #7ed9a2;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { background: var(--bg); }
body {
  margin: 0; min-height: 100vh; color: var(--ink);
  font: 13px/1.55 ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 24px 24px;
  display: flex; justify-content: center; padding: 20px 16px 40px;
}
main { width: 100%; max-width: 600px; }
header { display: flex; align-items: center; gap: 10px; padding-bottom: 14px; margin-bottom: 18px; border-bottom: 1px solid var(--line); }
.word { font: 700 22px/1 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: -0.02em; }
.slash { color: var(--muted); }
.chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px; font-size: 11px; font-weight: 600; }
.chip i, .status i { width: 8px; height: 8px; border-radius: 2px; background: var(--mint); display: inline-block; }
.status { margin-left: auto; font-size: 11px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
.status.off i { background: transparent; border: 1px solid var(--muted); }
h1, h2 { font-size: 17px; margin: 22px 0 12px; display: flex; align-items: center; gap: 8px; }
h2 { font-size: 14px; }
.count { background: var(--mint); color: #13110e; font-size: 11px; border-radius: 3px; padding: 0 6px; }
.banner { display: flex; gap: 10px; background: var(--warn-bg); border-left: 3px solid var(--warn-line); padding: 10px 12px; border-radius: 3px; }
.banner small { display: block; color: var(--muted); }
.note { border: 1px solid var(--line); background: var(--card); border-radius: 4px; padding: 9px 12px; color: var(--muted); }
.note.ok { border-color: var(--ok-line); background: var(--ok-bg); color: var(--ink); }
.card {
  position: relative; background: var(--card); border: 2px solid var(--ink); border-radius: 6px;
  box-shadow: 4px 4px 0 var(--mint); padding: 16px 14px 14px; margin-bottom: 18px; overflow: hidden;
}
.bar { position: absolute; top: 0; left: 0; height: 3px; background: var(--green); transition: width 1s linear; }
.top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.label { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.left { font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 1px 7px; white-space: nowrap; }
.tool { font-size: 18px; font-weight: 700; margin: 8px 0 2px; overflow-wrap: anywhere; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
pre {
  margin: 0; background: var(--inset); border: 1px solid var(--line); border-radius: 4px; padding: 10px 12px;
  font: inherit; font-size: 12px; overflow: auto; white-space: pre; color: var(--muted);
}
pre.short { max-height: 190px; overflow: hidden; }
pre.long { max-height: 360px; }
.k { color: var(--key); } .s { color: var(--str); } .b { color: var(--lit); } .n { color: var(--num); }
.more { margin-top: 6px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; align-items: center; }
.actions .grow { flex: 1; }
button {
  font: inherit; font-size: 12px; color: var(--ink); background: var(--card); border: 1.5px solid var(--ink);
  border-radius: 4px; padding: 7px 12px; cursor: pointer; line-height: 1.25;
}
button small { display: block; font-size: 10px; color: var(--muted); }
button.quiet { border-color: var(--line); color: var(--muted); }
button.yes { background: var(--yes-bg); color: var(--yes-ink); border-color: var(--yes-bg); font-weight: 700; }
button:hover:not(:disabled) { transform: translate(-1px, -1px); box-shadow: 2px 2px 0 var(--mint); }
button:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
.empty { border: 1.5px dashed var(--line); border-radius: 6px; padding: 14px; color: var(--muted); text-align: center; }
.empty.big { padding: 26px 16px; }
.empty strong { display: block; color: var(--ink); margin: 8px 0 4px; }
.rows { border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 12px; }
.row + .row { border-top: 1px solid var(--line); }
.row b { margin-right: auto; overflow-wrap: anywhere; }
.pill { font-size: 11px; border: 1px solid var(--line); border-radius: 3px; padding: 0 6px; }
.pill.time { border-color: var(--green); background: var(--pill); color: var(--green); }
.head2 { display: flex; justify-content: space-between; align-items: center; }
footer { margin-top: 30px; font-size: 11px; color: var(--muted); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; }
footer b { color: var(--ink); }
.nokey { text-align: center; padding: 80px 0 60px; font-weight: 700; font-size: 14px; }
.nokey p { max-width: 260px; margin: 14px auto 0; }
@media (max-width: 520px) {
  .actions { flex-direction: column; }
  .actions .grow { display: none; }
  .actions button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) { .bar { transition: none; } button:hover:not(:disabled) { transform: none; } }
`;

// Runs in the browser. No backticks or dollar-brace in here: it sits inside String.raw.
const JS = String.raw`
const params = new URLSearchParams(location.search);
// The key lives only in this tab's memory: never in storage, never in the address bar.
const key = params.get("k");
history.replaceState(null, "", "/");
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const SERVER = document.body.dataset.server;
let state = { pending: [], leases: [] };
let online = true;
let flash = null;
let flashTimer = 0;
const open = new Set();

function colourJson(value) {
  const text = esc(JSON.stringify(value, null, 2));
  return text.replace(/(&#34;(?:[^&]|&(?!#34;))*?&#34;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m, str, colon, lit) => {
      if (str) return colon ? '<span class="k">' + str + "</span>" + colon : '<span class="s">' + str + "</span>";
      if (lit) return '<span class="b">' + m + "</span>";
      return '<span class="n">' + m + "</span>";
    });
}

function secsLeft(p) {
  const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}
function share(p) {
  const total = p.expiresAt - p.createdAt;
  return total > 0 ? Math.max(0, Math.min(100, ((p.expiresAt - Date.now()) / total) * 100)) : 0;
}

function card(p, i, n) {
  const id = esc(p.id);
  const dis = online ? "" : " disabled";
  const lines = JSON.stringify(p.args, null, 2).split("\n").length;
  const long = lines > 10;
  const isOpen = open.has(p.id);
  const leases = p.leaseOptions.filter((o) => o !== "once").map((o) =>
    '<button data-id="' + id + '" data-d="lease:' + esc(o) + '"' + dis + ">Allow for " + esc(o) +
    (p.maxCalls ? "<small>up to " + p.maxCalls + (p.maxCalls === 1 ? " call" : " calls") + "</small>" : "") + "</button>").join("");
  const once = p.leaseOptions.includes("once")
    ? '<button class="yes" data-id="' + id + '" data-d="once"' + dis + ">Allow once</button>" : "";
  return '<article class="card" aria-label="' + esc(p.tool) + '">' +
    '<div class="bar" data-bar="' + id + '" style="width:' + share(p) + '%"></div>' +
    '<div class="top"><span class="label">' + (n > 1 ? (i + 1) + " of " + n + " &middot; " : "") + esc(p.server) + " wants to</span>" +
    '<span class="left" data-left="' + id + '">&#9201; ' + secsLeft(p) + " left</span></div>" +
    '<div class="tool">' + esc(p.tool) + "</div>" +
    '<p class="hint">Nothing happens until you answer.</p>' +
    '<pre class="' + (long ? (isOpen ? "long" : "short") : "") + '" tabindex="0">' + colourJson(p.args) + "</pre>" +
    (long ? '<button class="quiet more" data-more="' + id + '">' + (isOpen ? "Show less" : "Show more") + "</button>" : "") +
    '<div class="actions"><button class="quiet" data-id="' + id + '" data-d="deny"' + dis + ">Deny</button>" +
    '<span class="grow"></span>' + leases + once + "</div></article>";
}

function render() {
  const focused = document.activeElement && document.activeElement.dataset
    ? (document.activeElement.dataset.d || "") + "|" + (document.activeElement.dataset.id || document.activeElement.dataset.more || "") + "|" + document.activeElement.id : null;
  $("status").className = online ? "status" : "status off";
  $("status").innerHTML = "<i></i>" + (online ? "connected" : "offline");
  $("lost").hidden = online;
  const n = state.pending.length;
  $("count").textContent = n;
  $("count").hidden = n === 0;
  $("flash").innerHTML = flash ? '<div class="note' + (flash.ok ? " ok" : "") + '" role="status">' + (flash.ok ? "&#10003; " : "&#9432; ") + esc(flash.text) + "</div>" : "";
  $("pending").innerHTML = n > 0
    ? state.pending.map((p, i) => card(p, i, n)).join("")
    : flash ? "" : '<div class="empty big">' + document.getElementById("ghost").innerHTML +
      "<strong>Nothing waiting.</strong>Reading runs on its own. Anything that would change " + esc(SERVER) + " waits here for a yes.</div>";
  $("revoke").hidden = state.leases.length === 0;
  $("leases").innerHTML = state.leases.length === 0
    ? '<div class="empty">Nothing allowed right now. Every change asks first.</div>'
    : '<div class="rows">' + state.leases.map((l) => {
        const mins = Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 60000));
        const calls = l.remainingCalls === null ? "" :
          '<span class="pill">' + l.remainingCalls + (l.remainingCalls === 1 ? " call" : " calls") + " left</span>";
        return '<div class="row"><b>' + esc(l.tool) + '</b><span class="pill time">' + mins + "m left</span>" + calls + "</div>";
      }).join("") + "</div>";
  if (focused) {
    const [d, ref, elId] = focused.split("|");
    const back = elId ? $(elId) : document.querySelector(d ? '[data-d="' + d + '"][data-id="' + ref + '"]' : '[data-more="' + ref + '"]');
    if (back && back.focus) back.focus();
  }
}

function tick() {
  for (const p of state.pending) {
    const left = document.querySelector('[data-left="' + p.id + '"]');
    if (left) left.innerHTML = "&#9201; " + secsLeft(p) + " left";
    const bar = document.querySelector('[data-bar="' + p.id + '"]');
    if (bar) bar.style.width = share(p) + "%";
  }
}

function showFlash(text, ok) {
  flash = { text: text, ok: ok };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = null; render(); }, 6000);
  render();
}

function said(d, tool) {
  if (d === "deny") return "Denied " + tool + ".";
  if (d === "once") return "Allowed " + tool + " once.";
  return "Allowed " + tool + " for " + d.slice(6) + ".";
}

document.addEventListener("click", async (e) => {
  const more = e.target.closest("button[data-more]");
  if (more) {
    const id = more.dataset.more;
    if (open.has(id)) open.delete(id); else open.add(id);
    return render();
  }
  const b = e.target.closest("button[data-d]");
  if (!b || b.disabled) return;
  const p = state.pending.find((x) => x.id === b.dataset.id);
  const tool = p ? p.tool : "that";
  let res;
  try {
    res = await fetch("/api/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Lettuce-Key": key || "" },
      body: JSON.stringify({ id: b.dataset.id, decision: b.dataset.d }),
    });
  } catch {
    return showFlash("That did not go through. Is the agent still running?", false);
  }
  if (res.ok) showFlash(said(b.dataset.d, tool), true);
  else showFlash((await res.json().catch(() => ({}))).error || "That did not go through.", false);
});

$("revoke").addEventListener("click", async () => {
  const res = await fetch("/api/revoke", { method: "POST", headers: { "X-Lettuce": "revoke" } }).catch(() => null);
  if (res && res.ok) showFlash("Revoked everything. Every change asks first again.", true);
});

if (!key) {
  $("app").hidden = true;
  $("chip").hidden = true;
  $("status").hidden = true;
  $("nokey").hidden = false;
} else {
  const events = new EventSource("/api/events?k=" + encodeURIComponent(key));
  events.onmessage = (e) => { state = JSON.parse(e.data); online = true; render(); };
  events.onerror = () => { online = false; render(); };
  events.onopen = () => { online = true; render(); };
  setInterval(tick, 1000);
  render();
}
`;

export function renderHtml(nonce: string, serverName: string): string {
  const server = escapeHtml(serverName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>lettuce · ${server}</title>
<style>${CSS}</style>
</head>
<body data-server="${server}">
<template id="ghost">${mascotSvg(44, '')}</template>
<main>
  <header>
    ${mascotSvg(22)}<span class="word">lettuce</span>
    <span id="chip"><span class="slash">/</span> <span class="chip"><i></i>${server}</span></span>
    <span id="status" class="status"><i></i>connected</span>
  </header>
  <div id="app">
    <div id="lost" class="banner" role="alert" hidden><span>&#9873;</span><div>Lost touch with lettuce. Is the agent still running?<small>Answers are paused until it is back.</small></div></div>
    <h1>Waiting for you <span id="count" class="count" hidden>0</span></h1>
    <div id="flash" aria-live="polite"></div>
    <div id="pending"></div>
    <div class="head2"><h2>Allowed right now</h2><button id="revoke" class="quiet" hidden>Revoke all</button></div>
    <div id="leases"></div>
  </div>
  <div id="nokey" class="nokey" hidden>${mascotSvg(56, '')}<p>Open this page from the link lettuce opened.</p></div>
  <footer>
    <span><b>reads</b> run on their own · <b>changes</b> wait for a yes · some things <b>never</b> happen</span>
    <span>lettuce · a punnet tool by primitive</span>
  </footer>
</main>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}
