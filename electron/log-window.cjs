// Live BepInEx log console - a separate always-on-top-capable window that tails
// the game's LogOutput.log in near-real-time. GT is VR, so a pop-out (that can sit
// on a second monitor / float over the game) is the only way "live" logs are
// actually watchable while you're in the headset. The past-session archive
// (game-logs:* in main.js) is unchanged; this is purely the CURRENT session, live.
//
// The window loads the same renderer as the main app with `?window=logs`, so it
// reuses the build/fonts; main.jsx branches to <LogConsole/> for that flag.
const { BrowserWindow, ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');

let logWin = null;
let tailTimer = null;
let lastSize = 0;          // byte offset we've already streamed
let currentGamePath = null;
let deps = null;

const STATE_FILE = () => path.join(app.getPath('userData'), 'log-window.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) || {}; } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE(), JSON.stringify(s)); } catch { /* best effort */ } }

function logFilePath() {
  const gp = currentGamePath || (deps && deps.getGamePath && deps.getGamePath());
  return gp ? path.join(gp, 'BepInEx', 'LogOutput.log') : null;
}

function sendData(payload) {
  if (logWin && !logWin.isDestroyed()) { try { logWin.webContents.send('logwin:data', payload); } catch { /* window gone */ } }
}

function stopTail() { if (tailTimer) { clearInterval(tailTimer); tailTimer = null; } }

// Send whatever's already in the file, then poll for new bytes. Handles the
// relaunch case where BepInEx truncates/recreates the log (size shrinks -> reset).
function startTail() {
  stopTail();
  lastSize = 0;
  const p = logFilePath();
  if (p && fs.existsSync(p)) {
    try {
      const st  = fs.statSync(p);
      // Read the TAIL, not the whole file.
      //
      // BepInEx logs grow without bound across a long session, and this read the
      // entire thing into a string in the MAIN process and then pushed that one
      // string over IPC - which serialises it again on the way out and once more
      // on the way in. A multi-hundred-MB log (a mod stuck in an error loop is
      // the usual cause, and it is exactly when somebody opens the log panel)
      // could take the app down at the moment it is most needed.
      //
      // The panel only ever shows the recent end anyway: LiveLogPanel caps
      // itself at MAX_LINES and drops everything above it.
      const MAX_INITIAL_BYTES = 2 * 1024 * 1024;
      let raw;
      if (st.size > MAX_INITIAL_BYTES) {
        const fd = fs.openSync(p, 'r');
        try {
          const buf = Buffer.alloc(MAX_INITIAL_BYTES);
          fs.readSync(fd, buf, 0, MAX_INITIAL_BYTES, st.size - MAX_INITIAL_BYTES);
          // Drop the first (almost certainly partial) line.
          const text = buf.toString('utf8');
          const nl = text.indexOf('\n');
          raw = (nl === -1 ? text : text.slice(nl + 1));
        } finally { fs.closeSync(fd); }
      } else {
        raw = fs.readFileSync(p, 'utf8');
      }
      lastSize  = st.size;
      sendData({ initial: raw, path: p });
    } catch { sendData({ initial: '', waiting: true, path: p }); }
  } else {
    sendData({ initial: '', waiting: true, path: p });
  }
  tailTimer = setInterval(() => {
    if (!logWin || logWin.isDestroyed()) { stopTail(); return; }
    const fp = logFilePath();
    if (!fp || !fs.existsSync(fp)) return; // game not launched yet
    let st; try { st = fs.statSync(fp); } catch { return; }
    if (st.size < lastSize) { lastSize = 0; sendData({ cleared: true }); } // relaunch cleared the file
    if (st.size > lastSize) {
      try {
        const fd  = fs.openSync(fp, 'r');
        const len = st.size - lastSize;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastSize);
        fs.closeSync(fd);
        lastSize = st.size;
        sendData({ chunk: buf.toString('utf8') });
      } catch { /* transient read race; retry next tick */ }
    }
  }, 600);
}

function openLogWindow(gamePath) {
  currentGamePath = gamePath || currentGamePath || (deps && deps.getGamePath && deps.getGamePath()) || null;
  if (logWin && !logWin.isDestroyed()) { logWin.show(); logWin.focus(); return; }
  const st = loadState();
  logWin = new BrowserWindow({
    width:  st.width  || 760,
    height: st.height || 620,
    x: (typeof st.x === 'number' ? st.x : undefined),
    y: (typeof st.y === 'number' ? st.y : undefined),
    minWidth: 420,
    minHeight: 280,
    title: 'Excalibur · Live logs',
    backgroundColor: '#0a0a0c',
    alwaysOnTop: !!st.alwaysOnTop,
    autoHideMenuBar: true,
    show: false,
    icon: deps && deps.icon,
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // keep the tail flowing when not focused
    },
  });

  if (deps.isDev) logWin.loadURL(`${deps.devUrl}/?window=logs`);
  else            logWin.loadFile(deps.indexHtml, { search: 'window=logs' });

  logWin.once('ready-to-show', () => { if (logWin && !logWin.isDestroyed()) logWin.show(); });
  // Safety net: if ready-to-show never fires, show anyway so the window can't hang hidden.
  setTimeout(() => { if (logWin && !logWin.isDestroyed() && !logWin.isVisible()) logWin.show(); }, 2500);

  const persist = () => {
    if (logWin && !logWin.isDestroyed()) {
      const b = logWin.getBounds();
      saveState({ ...loadState(), x: b.x, y: b.y, width: b.width, height: b.height });
    }
  };
  logWin.on('moved', persist);
  logWin.on('resized', persist);
  logWin.on('closed', () => { stopTail(); logWin = null; });
}

// ── Inline (in-app) tail ────────────────────────────────────────────────────
// Same tail logic as the pop-out, but streams to whatever webContents asked for
// it (the MAIN app window) via 'livelog:data'. Powers the in-app Live Logs panel
// that fills the Mods-page content area after a launch. Independent state from
// the pop-out so the two never fight over the poll timer.
let inlineTimer = null;
let inlineSize = 0;
let inlineGamePath = null;
let inlineSender = null;

function inlineSend(payload) {
  if (inlineSender && !inlineSender.isDestroyed()) { try { inlineSender.send('livelog:data', payload); } catch { /* gone */ } }
}
function inlineLogPath() {
  const gp = inlineGamePath || (deps && deps.getGamePath && deps.getGamePath());
  return gp ? path.join(gp, 'BepInEx', 'LogOutput.log') : null;
}
function stopInlineTail() { if (inlineTimer) { clearInterval(inlineTimer); inlineTimer = null; } inlineSender = null; }
function startInlineTail(sender, gamePath) {
  stopInlineTail();
  inlineSender = sender;
  inlineGamePath = gamePath || inlineGamePath || (deps && deps.getGamePath && deps.getGamePath()) || null;
  inlineSize = 0;
  const p = inlineLogPath();
  if (p && fs.existsSync(p)) {
    try {
      const st  = fs.statSync(p);
      const raw = fs.readFileSync(p, 'utf8');
      inlineSize = st.size;
      inlineSend({ initial: raw, path: p });
    } catch { inlineSend({ initial: '', waiting: true, path: p }); }
  } else {
    inlineSend({ initial: '', waiting: true, path: p });
  }
  inlineTimer = setInterval(() => {
    const fp = inlineLogPath();
    if (!fp || !fs.existsSync(fp)) return; // game not launched yet
    let st; try { st = fs.statSync(fp); } catch { return; }
    if (st.size < inlineSize) { inlineSize = 0; inlineSend({ cleared: true }); } // relaunch cleared the file
    if (st.size > inlineSize) {
      try {
        const fd  = fs.openSync(fp, 'r');
        const len = st.size - inlineSize;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, inlineSize);
        fs.closeSync(fd);
        inlineSize = st.size;
        inlineSend({ chunk: buf.toString('utf8') });
      } catch { /* transient read race; retry next tick */ }
    }
  }, 600);
}

function registerLogWindow(d) {
  deps = d;
  ipcMain.handle('logwin:open', (_e, { gamePath } = {}) => { openLogWindow(gamePath); return { ok: true }; });
  // In-app live log panel: start/stop tailing straight into the caller's window.
  ipcMain.handle('livelog:start', (e, { gamePath } = {}) => { startInlineTail(e.sender, gamePath); return { ok: true }; });
  ipcMain.handle('livelog:stop', () => { stopInlineTail(); return { ok: true }; });
  // The log renderer calls this once mounted: start tailing + hand back persisted prefs.
  ipcMain.handle('logwin:ready', () => {
    startTail();
    const st = loadState();
    return { ok: true, data: { alwaysOnTop: !!st.alwaysOnTop, gamePath: currentGamePath } };
  });
  ipcMain.handle('logwin:set-always-on-top', (_e, v) => {
    const on = !!v;
    if (logWin && !logWin.isDestroyed()) logWin.setAlwaysOnTop(on);
    saveState({ ...loadState(), alwaysOnTop: on });
    return { ok: true, data: on };
  });
  ipcMain.handle('logwin:close', () => { if (logWin && !logWin.isDestroyed()) logWin.close(); return { ok: true }; });
}

module.exports = { registerLogWindow, openLogWindow };
