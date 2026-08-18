// Luma Looks desktop controller — a standalone pop-out window that renders ONLY the gold/black Luma
// panel (src/main.jsx branches to <LumaWindow/> on ?window=luma). Opened by the in-game Ctrl+Shift+L
// keybind (mod → 'luma_open' → electron/main.js → openLumaWindow) so the realism controls appear
// over the game, without disturbing the main Excalibur window. Modeled on electron/test-lab-window.cjs
// (same renderer bundle, preload, fonts, IPC surface). Geometry + always-on-top persist.
const { BrowserWindow, ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { startMinimizeWatch, stopMinimizeWatch } = require('./luma-minimize-watch.cjs');

let win = null;
let deps = null;
let selfMinimized = false;   // true only while WE minimised the window to follow GT (not the user)

const STATE_FILE = () => path.join(app.getPath('userData'), 'luma-window.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) || {}; } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE(), JSON.stringify(s)); } catch { /* best effort */ } }

// Force the window in front of a focused, possibly-fullscreen game. Windows blocks a background app
// from a plain focus()-steal, so we ride alwaysOnTop at the screen-saver level for a moment.
function bringToFront() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  win.focus();
  const st = loadState();
  if (st.alwaysOnTop === false) {
    setTimeout(() => { try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); } catch { /* gone */ } }, 500);
  }
}

function openLumaWindow() {
  if (win && !win.isDestroyed()) { bringToFront(); return; }
  const st = loadState();
  win = new BrowserWindow({
    width:  st.width  || 720,
    height: st.height || 660,
    x: (typeof st.x === 'number' ? st.x : undefined),
    y: (typeof st.y === 'number' ? st.y : undefined),
    minWidth: 600,
    minHeight: 460,
    title: 'Luma Looks · Excalibur',
    backgroundColor: '#0a0908',
    // Frameless like the main app window: LumaController renders its own
    // title bar (drag region + minimize/close via the luma:* IPC below).
    frame: false,
    // Default ON: it's a controller you pull up over the game with a keybind. Toggleable + persisted.
    alwaysOnTop: st.alwaysOnTop !== false,
    autoHideMenuBar: true,
    show: false,
    icon: deps && deps.icon,
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (deps.isDev) win.loadURL(`${deps.devUrl}/?window=luma`);
  else            win.loadFile(deps.indexHtml, { search: 'window=luma' });

  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) { win.show(); bringToFront(); } });
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 2500);

  const persist = () => {
    if (win && !win.isDestroyed()) {
      const b = win.getBounds();
      saveState({ ...loadState(), x: b.x, y: b.y, width: b.width, height: b.height });
    }
  };
  win.on('moved', persist);
  win.on('resized', persist);
  win.on('closed', () => { win = null; selfMinimized = false; stopMinimizeWatch(); });

  // Follow Gorilla Tag's minimise state: minimise with the game, restore with it. We only restore a
  // window WE minimised (selfMinimized) so we never yank up a window the user minimised themselves.
  startMinimizeWatch((state) => {
    if (!win || win.isDestroyed()) return;
    if (state === 'MIN') {
      if (!win.isMinimized()) { selfMinimized = true; win.minimize(); }
    } else if (state === 'NORM') {
      if (selfMinimized && win.isMinimized()) { win.restore(); }
      selfMinimized = false;
    }
    // 'GONE' → GT exited; the bridge-disconnect path closes the window (main.js).
  });
}

// Close the controller from the main process — called when Gorilla Tag exits (the mod bridge drops),
// so the Luma window's lifetime is tied to the game's, per the owner's request.
function closeLumaWindow() {
  if (win && !win.isDestroyed()) { try { win.close(); } catch { /* already closing */ } }
  win = null;
}

function registerLumaWindow(d) {
  deps = d;
  ipcMain.handle('luma:open-window',  () => { openLumaWindow(); return { ok: true }; });
  ipcMain.handle('luma:close-window', () => { if (win && !win.isDestroyed()) win.close(); return { ok: true }; });
  // The frameless window's own minimize button (the user minimizing themselves,
  // so selfMinimized stays false and the game-follow watcher won't restore it).
  ipcMain.handle('luma:minimize-window', () => { if (win && !win.isDestroyed()) win.minimize(); return { ok: true }; });
  ipcMain.handle('luma:set-always-on-top', (_e, v) => {
    const on = !!v;
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(on);
    saveState({ ...loadState(), alwaysOnTop: on });
    return { ok: true, data: on };
  });
}

module.exports = { registerLumaWindow, openLumaWindow, closeLumaWindow };
