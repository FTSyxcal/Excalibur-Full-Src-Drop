// Mod Test Lab - a standalone pop-out window for exercising every built-in
// Excalibur feature from the desktop while you're in the headset. It flips
// config.features (and the active/home modpacks' builtinFeatures) so the running
// mod enables/disables modules live, previews any tier, and runs quick presets.
//
// Modeled on electron/log-window.cjs: it loads the SAME renderer bundle with
// `?window=testlab`, and src/main.jsx branches to <TestLab/> for that flag, so
// it reuses the build, fonts, preload bridge and IPC surface. Geometry +
// always-on-top are persisted so the pop-out reopens where you left it.
const { BrowserWindow, ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');

let win = null;
let deps = null;

const STATE_FILE = () => path.join(app.getPath('userData'), 'test-lab-window.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) || {}; } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE(), JSON.stringify(s)); } catch { /* best effort */ } }

function openTestLabWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  const st = loadState();
  win = new BrowserWindow({
    width:  st.width  || 460,
    height: st.height || 760,
    x: (typeof st.x === 'number' ? st.x : undefined),
    y: (typeof st.y === 'number' ? st.y : undefined),
    minWidth: 380,
    minHeight: 480,
    title: 'Excalibur · Mod Test Lab',
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
    },
  });

  if (deps.isDev) win.loadURL(`${deps.devUrl}/?window=testlab`);
  else            win.loadFile(deps.indexHtml, { search: 'window=testlab' });

  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
  // Safety net: if ready-to-show never fires, show anyway so it can't hang hidden.
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 2500);

  const persist = () => {
    if (win && !win.isDestroyed()) {
      const b = win.getBounds();
      saveState({ ...loadState(), x: b.x, y: b.y, width: b.width, height: b.height });
    }
  };
  win.on('moved', persist);
  win.on('resized', persist);
  win.on('closed', () => { win = null; });
}

function registerTestLabWindow(d) {
  deps = d;
  ipcMain.handle('testlab:open',  () => { openTestLabWindow(); return { ok: true }; });
  ipcMain.handle('testlab:close', () => { if (win && !win.isDestroyed()) win.close(); return { ok: true }; });
  ipcMain.handle('testlab:set-always-on-top', (_e, v) => {
    const on = !!v;
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(on);
    saveState({ ...loadState(), alwaysOnTop: on });
    return { ok: true, data: on };
  });
}

module.exports = { registerTestLabWindow, openTestLabWindow };
