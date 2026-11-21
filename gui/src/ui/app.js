'use strict';
/* global lw */
// Linuxwolf UI. Plain DOM, no framework: the main process owns all state,
// this page asks for a snapshot whenever something changes and redraws.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = null; // last state snapshot
let page = 'library';
let selectedProc = null;
let gameFilter = { q: '', onlyApps: false };
const logCache = new Map();
let logStick = true; // keep the log scrolled to the end until the user scrolls up

// Replace a node's content only when it really changed, so a redraw never
// swaps the element under the mouse pointer for an identical copy.
function setHTML(el, html) {
  if (el.__html === html) return false;
  el.__html = html;
  el.innerHTML = html;
  return true;
}

function toast(msg, ok = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${ok ? ' ok' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4500);
}

async function act(ch, ...args) {
  try {
    return await lw.call(ch, ...args);
  } catch (e) {
    toast(e.message);
    return undefined;
  }
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function initials(name) {
  return name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

const KIND = { 'ow-electron': 'Overwolf Electron app · Linuxwolf runtime', opk: 'Classic Overwolf app · Linuxwolf runtime', appimage: 'Native Linux app' };

// ---------- Library ----------

function appCard(a) {
  const proc = S.processes.find((p) => p.key === `app:${a.id}`);
  const task = S.processes.find((p) => p.running && (p.key === `install:${a.id}` || p.key === `check:${a.id}`));
  const gameChips = a.games.map((id, i) => {
    const live = S.games.running.some((g) => g.appId === id);
    const inst = a.gamesInstalled.includes(id);
    return `<span class="chip ${live ? 'live' : inst ? 'on' : ''}" title="${live ? 'running now' : inst ? 'installed' : typeof id === 'number' ? 'not installed in Steam' : 'not found in a Wine prefix'}">${live ? '● ' : ''}${esc(a.gameNames[i])}</span>`;
  }).join('');
  let status;
  if (task) status = `<span class="dot busy"></span><span class="last">${esc(task.label)}: ${esc(task.lastLine)}</span>`;
  else if (a.running) status = `<span class="dot ok"></span><span class="last">Running${a.pid ? ` · pid ${a.pid}` : ''}${proc?.meta?.autoFor ? ' · started with game' : ''}</span>`;
  else if (proc && !proc.running && proc.exitCode !== 0 && proc.exitCode !== 'SIGTERM' && proc.exitCode !== 'gone') status = `<span class="dot bad"></span><span class="last">Stopped (${esc(proc.exitCode)}) ${ago(proc.endedAt)}. See Activity.</span>`;
  else if (a.installed) status = `<span class="dot"></span><span class="last">Installed${a.version ? ` · ${esc(a.version)}` : ''}</span>`;
  else status = `<span class="dot"></span><span class="last">Not installed · from ${esc(a.source || 'its developer')}</span>`;
  const missing = (a.needs || []).filter((t) => S.system.tools[t] === false);

  const buttons = [];
  if (!a.installed) {
    buttons.push(`<button class="btn primary" data-act="app:install" data-id="${esc(a.id)}" ${task ? 'disabled' : ''}>Install</button>`);
  } else if (a.running) {
    buttons.push(`<button class="btn stop" data-act="app:stop" data-id="${esc(a.id)}">Stop</button>`);
  } else {
    buttons.push(`<button class="btn primary" data-act="app:launch" data-id="${esc(a.id)}" ${task ? 'disabled' : ''}>Start</button>`);
  }
  if (a.check) buttons.push(`<button class="btn" data-act="app:check" data-id="${esc(a.id)}" ${task ? 'disabled' : ''}>Setup check</button>`);
  if (a.installed && (a.kind === 'ow-electron' || a.kind === 'opk') && !a.running) buttons.push(`<button class="btn" data-act="app:install" data-id="${esc(a.id)}" title="Look for a newer version at Overwolf" ${task ? 'disabled' : ''}>Update</button>`);
  if (a.installed) buttons.push(`<button class="btn" data-act="app:openFolder" data-id="${esc(a.id)}">Folder</button>`);
  if (a.installed && !a.running) buttons.push(`<button class="btn danger" data-act="app:remove" data-id="${esc(a.id)}">Remove</button>`);

  return `<article class="card ${a.running ? 'running' : ''}">
    <div class="card-head">
      <div class="avatar">${esc(initials(a.name))}</div>
      <div><div class="title">${esc(a.name)}</div><div class="meta">${esc(KIND[a.kind] || a.kind)}</div></div>
      <span class="spacer"></span>
      ${a.homepage ? `<a href="#" data-url="${esc(a.homepage)}" class="hint">Website</a>` : ''}
    </div>
    <p class="desc">${esc(a.description)}</p>
    ${a.games.length ? `<div class="chips">${gameChips}</div>` : ''}
    <div class="status">${status}</div>
    ${missing.length && !a.installed ? `<div class="hint">Install needs: ${missing.map((t) => `<code>${esc(t)}</code>`).join(' ')} (not found)</div>` : ''}
    <div class="actions">${buttons.join('')}
      <span class="spacer"></span>
      ${a.games.length ? `<label class="toggle" title="Start ${esc(a.name)} when ${esc(a.gameNames.join(' or '))} starts"><input type="checkbox" data-auto="${esc(a.id)}" ${a.autoStart ? 'checked' : ''} ${a.installed ? '' : 'disabled'}>With game</label>` : ''}
    </div>
  </article>`;
}

function renderLibrary() {
  const el = $('#page-library');
  const known = S.apps.filter((a) => !a.custom);
  const custom = S.apps.filter((a) => a.custom);
  setHTML(el, `
    <h1>Library</h1>
    <p class="sub">Overwolf apps that run on Linux, next to your games under Proton.</p>
    <div class="grid">${known.map(appCard).join('')}</div>
    ${custom.length ? `<h2>Other installed apps</h2><div class="grid">${custom.map(appCard).join('')}</div>` : ''}
    <h2>Add an Overwolf app</h2>
    <div class="hint">Paste the app id (40 letters) of an Overwolf app: classic apps (.opk) come from Overwolf's store catalog, ow-electron apps from their update feed. Apps that need Overwolf's game events or native plugins will miss those features.</div>
    <form class="add" id="add-form"><input id="add-uid" placeholder="e.g. iopjffpkfkhnkacicapeebfaicmffbekflfbfkmf" spellcheck="false" autocomplete="off"><button class="btn">Install</button></form>`);
  $('#add-form').onsubmit = async (e) => {
    e.preventDefault();
    const v = $('#add-uid').value;
    if ((await act('app:add', v)) !== undefined) {
      $('#add-uid').value = '';
      toast('Installing. Progress is in Activity.', true);
    }
  };
}

// ---------- Games ----------

function renderGames() {
  const el = $('#page-games');
  const q = gameFilter.q.toLowerCase();
  const list = S.games.installed.filter((g) => (!gameFilter.onlyApps || g.apps.length) && (!q || g.name.toLowerCase().includes(q) || String(g.appId).includes(q)));
  const appName = (id) => S.apps.find((a) => a.id === id)?.name || id;
  const steamAppIds = new Set(S.games.installed.map((g) => g.appId));
  const otherRunning = S.games.running.filter((g) => !g.appId || !steamAppIds.has(g.appId));
  const focus = document.activeElement?.id;
  setHTML(el, `
    <h1>Games</h1>
    <p class="sub">Steam games on this computer. Linuxwolf sees a game as running when its Proton/Wine process is up.</p>
    ${S.system.steamRoots.length ? '' : '<div class="callout">No Steam installation found. Linuxwolf looks in ~/.local/share/Steam, ~/.steam and the Flatpak folder.</div>'}
    <div class="toolbar">
      <input class="search" id="game-q" placeholder="Search games" value="${esc(gameFilter.q)}">
      <label class="toggle"><input type="checkbox" id="game-only" ${gameFilter.onlyApps ? 'checked' : ''}>Only games with Linuxwolf apps</label>
      <span class="spacer"></span>
      <button class="btn" data-act="games:rescan">Rescan</button>
    </div>
    ${list.length ? `<table><thead><tr><th>Game</th><th>Status</th><th>Linuxwolf apps</th><th class="right"></th></tr></thead><tbody>
      ${list.map((g) => `<tr>
        <td><div><b>${esc(g.name)}</b></div><div class="hint mono">Steam ${g.appId}</div></td>
        <td>${g.running ? `<span class="status"><span class="dot ok"></span>Running · pid ${g.pid}</span>` : '<span class="hint">Not running</span>'}</td>
        <td>${g.apps.length ? `<div class="chips">${g.apps.map((id) => {
          const a = S.apps.find((x) => x.id === id);
          return `<span class="chip ${a?.running ? 'live' : a?.installed ? 'on' : ''}">${a?.running ? '● ' : ''}${esc(appName(id))}${a && !a.installed ? ' (not installed)' : ''}</span>`;
        }).join('')}</div>` : '<span class="hint">–</span>'}</td>
        <td class="right">${g.running ? '' : `<button class="btn small primary" data-act="game:play" data-id="${g.appId}">Play</button>`}</td>
      </tr>`).join('')}
    </tbody></table>` : `<div class="empty">${S.games.installed.length ? 'No game matches.' : 'No Steam games found.'}</div>`}
    ${otherRunning.length ? `<h2>Other games and Wine/Proton processes</h2><table><thead><tr><th>Program</th><th>Runner</th><th>Prefix</th></tr></thead><tbody>
      ${otherRunning.map((g) => `<tr><td><b>${esc(g.name || g.exe)}</b><div class="hint mono">pid ${g.pid}${typeof g.appId === 'number' ? ` · Steam ${g.appId}` : ''}</div></td><td>${esc(g.runner)}</td><td class="mono hint">${esc(g.winePrefix || '–')}</td></tr>`).join('')}
    </tbody></table>` : ''}`);
  const qi = $('#game-q');
  qi.oninput = () => {
    gameFilter.q = qi.value;
    renderGames();
  };
  if (focus === 'game-q') {
    qi.focus();
    qi.setSelectionRange(qi.value.length, qi.value.length);
  }
  $('#game-only').onchange = (e) => {
    gameFilter.onlyApps = e.target.checked;
    renderGames();
  };
}

// ---------- Overlay ----------

function renderOverlay() {
  const o = S.system.overlay;
  const busy = S.processes.some((p) => p.running && p.key.startsWith('overlay:'));
  setHTML($('#page-overlay'), `
    <h1>In-game overlay</h1>
    <p class="sub">A Vulkan layer that draws into a game's frames. Works for Proton games because DXVK and VKD3D present through Vulkan. It draws a test HUD for now.</p>
    <div class="card" style="max-width:720px">
      <div class="status"><span class="dot ${busy ? 'busy' : o.installed ? 'ok' : ''}"></span>${busy ? 'Working…' : o.installed ? 'Installed for this user' : 'Not installed'}</div>
      <div class="hint mono">${esc(o.manifest)}</div>
      <div class="actions">
        ${o.installed
          ? `<button class="btn" data-act="overlay:install" ${busy ? 'disabled' : ''}>Rebuild</button><button class="btn danger" data-act="overlay:uninstall" ${busy ? 'disabled' : ''}>Remove</button>`
          : `<button class="btn primary" data-act="overlay:install" ${busy || !S.system.tools.cargo ? 'disabled' : ''}>Build and install</button>`}
        ${S.system.tools.cargo ? '' : '<span class="hint">Needs Rust (cargo) to build the layer.</span>'}
      </div>
    </div>
    <h2>Turn it on for a game</h2>
    <p class="hint">Steam → right-click the game → Properties → Launch options:</p>
    <div class="copy"><code>${esc(o.launchOption)}</code><button class="btn small" data-copy="${esc(o.launchOption)}">Copy</button></div>
    <p class="hint">With debug log:</p>
    <div class="copy"><code>${esc(o.debugLaunchOption)}</code><button class="btn small" data-copy="${esc(o.debugLaunchOption)}">Copy</button></div>
    <h2>Anti-cheat</h2>
    <div class="callout">Games with kernel-level anti-cheat may treat a Vulkan layer like any other injected code. Read <code>docs/spike-1.md</code> before you turn the overlay on for such a game. MetaBot and the TH.GL Companion do not need this layer; they use their own windows.</div>`);
}

// ---------- Activity ----------

function lineClass(l) {
  // Chromium's own log lines (dbus, GPU, ...) are noise for the user.
  if (/^\[\d+:\d+\/[\d.]+:(ERROR|WARNING|INFO|VERBOSE)/.test(l.line)) return 'dim';
  if (l.stream === 'meta') return /failed|exited \((?!0\))/.test(l.line) ? 'bad' : 'meta';
  if (/\b(FAIL|error|mismatch|not found|missing)\b/i.test(l.line)) return 'bad';
  if (/^\s*ok\b|installed to|^Ready\./.test(l.line)) return 'good';
  return l.stream === 'stderr' ? 'stderr' : '';
}

async function loadLog(key) {
  const lines = (await act('process:log', key)) || [];
  logCache.set(key, lines);
  drawLog();
}

function drawLog() {
  const box = $('#log');
  if (!box || !selectedProc) return;
  const lines = logCache.get(selectedProc) || [];
  const top = box.scrollTop;
  box.innerHTML = lines.map((l) => `<span class="${lineClass(l)}">${esc(l.line)}</span>`).join('\n');
  box.scrollTop = logStick ? box.scrollHeight : top;
}

function renderActivity() {
  const el = $('#page-activity');
  const procs = [...S.processes].sort((a, b) => (b.running - a.running) || b.startedAt - a.startedAt);
  if (!selectedProc || !procs.some((p) => p.key === selectedProc)) selectedProc = procs[0]?.key || null;
  const sel = procs.find((p) => p.key === selectedProc);
  setHTML(el, `
    <h1>Activity</h1>
    <p class="sub">Installs, checks and running apps since Linuxwolf started. Full logs are in <span class="mono">~/.local/state/linuxwolf/gui/</span>.</p>
    ${procs.length ? `<div class="activity">
      <div class="plist">${procs.map((p) => `<button data-proc="${esc(p.key)}" class="${p.key === selectedProc ? 'active' : ''}">
        <div class="pl"><span class="dot ${p.running ? (p.kind === 'app' ? 'ok' : 'busy') : p.exitCode === 0 || p.exitCode === 'SIGTERM' ? '' : 'bad'}"></span>${esc(p.label)}</div>
        <div class="ps">${p.running ? (p.kind === 'app' ? 'running' : 'working') : `done (${esc(p.exitCode)})`} · ${ago(p.startedAt)}${p.lastLine ? ` · ${esc(p.lastLine)}` : ''}</div>
      </button>`).join('')}</div>
      <div class="logbox">
        <div class="lh"><b>${esc(sel?.label || '')}</b><span class="spacer"></span>
          ${sel?.running ? `<button class="btn small stop" data-act="process:stop" data-id="${esc(sel.key)}">Stop</button>` : ''}
          ${sel ? `<button class="btn small" data-act="process:openLog" data-id="${esc(sel.key)}">Open log file</button>` : ''}
        </div>
        <pre class="log mono" id="log"></pre>
      </div>
    </div>` : '<div class="empty">Nothing yet. Install or start an app in the Library.</div>'}`);
  const box = $('#log');
  if (box) {
    box.onscroll = () => {
      logStick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    };
  }
  if (selectedProc) {
    if (logCache.has(selectedProc)) drawLog();
    loadLog(selectedProc);
  }
}

// ---------- Settings ----------

function seg(name, value, options) {
  return `<div class="seg">${options.map(([v, label]) => `<button data-set="${name}" data-val="${v}" class="${value === v ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
}

function check(k, ok, v, level = ok ? 'ok' : 'bad') {
  return `<div class="check"><span class="dot ${level}"></span><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
}

function renderSettings() {
  const s = S.settings;
  const y = S.system;
  const ptrace = y.ptraceScope;
  setHTML($('#page-settings'), `
    <h1>Settings</h1>
    <p class="sub">How Linuxwolf starts apps. Changes apply the next time an app starts.</p>
    <div class="form">
      <label class="k">Window system for Overwolf Electron apps</label>
      <div class="v">${seg('backend', s.backend, [['x11', 'XWayland'], ['wayland', 'Wayland']])}
        <div class="hint">XWayland is recommended: Proton games are XWayland windows too, so "always on top" and hotkeys work while the game has focus. Native Wayland cannot keep a window above a fullscreen game.</div></div>
      <label class="k">On-screen-display windows (KDE)</label>
      <div class="v">${seg('osd', s.osd, [['clickthrough', 'Click-through only'], ['all', 'All always-on-top'], ['off', 'Off']])}
        <div class="hint">KWin stacks on-screen-display windows above fullscreen games. Windows of this type cannot take keyboard focus, so by default only click-through windows get it.</div></div>
      <label class="k">Auto-start</label>
      <div class="v"><label class="toggle"><input type="checkbox" data-bool="stopWithGame" ${s.stopWithGame ? 'checked' : ''}>Stop apps again when their game exits</label>
        <div class="hint">Turn on "With game" for an app in the Library to start it when its game starts.</div></div>
      <label class="k">Tray</label>
      <div class="v"><label class="toggle"><input type="checkbox" data-bool="closeToTray" ${s.closeToTray ? 'checked' : ''}>Keep running in the tray when the window is closed</label>
        <div class="hint">Needed for auto-start. Start minimised with <code>linuxwolf --hidden</code>.</div></div>
      <label class="k">Debug</label>
      <div class="v"><label class="toggle"><input type="checkbox" data-bool="debug" ${s.debug ? 'checked' : ''}>Log every emulated Windows call (LINUXWOLF_DEBUG)</label></div>
    </div>
    <h2>This computer</h2>
    <div class="checks">
      ${check('Session', true, `${y.session}${y.desktop ? ` · ${y.desktop}` : ''}`, 'ok')}
      ${check('X11 / XWayland', Boolean(y.display), y.display ? `${y.display}${y.xwayland ? ' (XWayland)' : ''}` : 'no DISPLAY')}
      ${check('Steam', y.steamRoots.length > 0, y.steamRoots.length ? `${y.steamRoots.length} install${y.steamRoots.length > 1 ? 's' : ''}` : 'not found')}
      ${check('glibc', Boolean(y.glibc), y.glibc || 'not found', y.glibc ? 'ok' : 'warn')}
      ${check('ptrace_scope', ptrace === null || Number(ptrace) <= 1, ptrace ?? 'no Yama')}
      ${check('FUSE (AppImages)', y.fuse, y.fuse ? 'available' : 'missing, uses extract-and-run', y.fuse ? 'ok' : 'warn')}
      ${check('Overlay layer', y.overlay.installed, y.overlay.installed ? 'installed' : 'not installed', y.overlay.installed ? 'ok' : 'warn')}
      ${Object.entries(y.tools).map(([t, ok]) => check(t, ok, ok ? 'found' : 'not found', ok ? 'ok' : t === 'xprop' || t === '7z' ? 'bad' : 'warn')).join('')}
    </div>
    <p class="hint">Linuxwolf ${esc(y.repoRoot)} · Electron ${esc(y.versions.electron)} · Node ${esc(y.versions.node)} · apps in <span class="mono">${esc(y.appsDir)}</span></p>`);
}

// ---------- Shell ----------

function renderNav() {
  const live = S.games.running;
  const nr = $('#nav-running');
  nr.hidden = !live.length;
  nr.textContent = live.length;
  const busy = S.processes.filter((p) => p.running && p.kind === 'task').length;
  const nt = $('#nav-tasks');
  nt.hidden = !busy;
  nt.textContent = busy;
  const apps = S.apps.filter((a) => a.running).map((a) => a.name);
  setHTML($('#now-playing'), live.length
    ? live.map((g) => `<div class="game"><span class="dot ok"></span>${esc(g.name || g.exe)}</div>`).join('') + `<div>${apps.length ? `with ${esc(apps.join(', '))}` : 'no app running'}</div>`
    : `<div>No game running</div>${apps.length ? `<div>${esc(apps.join(', '))} running</div>` : ''}`);
}

const RENDER = { library: renderLibrary, games: renderGames, overlay: renderOverlay, activity: renderActivity, settings: renderSettings };

async function refresh() {
  S = await lw.call('state:get');
  renderNav();
  RENDER[page]();
}

function show(p) {
  page = p;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
  document.querySelectorAll('.page').forEach((s) => s.classList.toggle('active', s.id === `page-${p}`));
  if (S) RENDER[p]();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-page],[data-act],[data-url],[data-copy],[data-proc],[data-set]');
  if (!t) return;
  if (t.dataset.page) return show(t.dataset.page);
  if (t.dataset.url) {
    e.preventDefault();
    return act('open:url', t.dataset.url);
  }
  if (t.dataset.copy) {
    await act('clipboard:write', t.dataset.copy);
    return toast('Copied.', true);
  }
  if (t.dataset.proc) {
    selectedProc = t.dataset.proc;
    logStick = true;
    return renderActivity();
  }
  if (t.dataset.set) return act('settings:set', { [t.dataset.set]: t.dataset.val });
  const ch = t.dataset.act;
  const id = t.dataset.id;
  t.disabled = true;
  await act(ch, ch === 'game:play' ? Number(id) : id);
  if (ch === 'app:install' || ch === 'app:check' || ch.startsWith('overlay:')) {
    selectedProc = ch === 'app:install' ? `install:${id}` : ch === 'app:check' ? `check:${id}` : ch;
    logStick = true;
  }
  if (ch === 'game:play') toast('Asked Steam to start the game.', true);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.auto) act('app:setAutoStart', t.dataset.auto, t.checked);
  if (t.dataset.bool) act('settings:set', { [t.dataset.bool]: t.checked });
});

lw.onChanged(() => refresh());
lw.onOutput((o) => {
  const lines = logCache.get(o.key);
  if (lines) {
    lines.push({ stream: o.stream, line: o.line });
    if (lines.length > 400) lines.shift();
  }
  if (page === 'activity' && o.key === selectedProc) drawLog();
});
setInterval(() => page === 'activity' && S && renderNav(), 5000);

refresh();
