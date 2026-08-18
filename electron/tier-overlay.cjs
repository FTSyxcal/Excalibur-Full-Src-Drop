// Lifecycle manager for the transparent click-through overlay window that
// shows the user's tier as a pill on launch / on tier change.
//
// Architecture rationale: rendering UI inside Gorilla Tag via IMGUI or a
// ScreenSpaceOverlay Canvas does NOT show up on the desktop window in
// Gorilla Tag's URP setup - both render paths are swallowed by the VR
// rendering pipeline. The proven workaround (used by Sakura's camera mod
// and many other GT mods) is to run UI as a SEPARATE Windows process with
// its own native window. We have an even cleaner version of that since
// the Excalibur desktop app is already running: we just spawn a tiny
// transparent BrowserWindow positioned over the GT window's top-left.
//
// Window properties:
//   transparent + frame:false   → invisible chrome, pixel-perfect overlay
//   alwaysOnTop=screen-saver    → highest practical z-order; sits above GT
//   focusable: false            → never steals focus from the game
//   setIgnoreMouseEvents(true)  → clicks pass straight through to GT
//   skipTaskbar: true           → no taskbar entry
//
// Positioned at the top-left of the primary display (the "easy" version
// of the plan). If the GT window is maximized / borderless-fullscreen on
// the primary monitor (the default Steam-launched setup), this lands as
// "top-left of the GT window" exactly. Custom-positioned GT windows
// won't be tracked - that would be the "proper" version requiring
// Win32 FindWindow + GetWindowRect polling, deliberately out of scope
// for v1.

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { logInfo, logError } = require('./logger.cjs');

let overlayWin = null;
let hideTimer  = null;
// 2.2s matches the CSS animation total (220ms fade-in + 1540ms hold +
// 440ms fade-out, rounded up). We keep the window visible until the
// renderer says it's done OR this timeout fires as a safety net (in
// case the renderer crashes mid-animation).
const SAFETY_HIDE_MS = 2500;

function isAlive(win) {
  return win && !win.isDestroyed();
}

function buildWindow() {
  // Place near the top-left of the primary display. Log full multi-monitor
  // layout so we can diagnose "where did the overlay actually appear"
  // questions from user reports.
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();
  const bounds   = primary.workArea;
  logInfo(`[overlay] ${displays.length} display(s); primary workArea=(${bounds.x},${bounds.y},${bounds.width}x${bounds.height})`);
  displays.forEach((d, i) => {
    logInfo(`[overlay]   display[${i}] id=${d.id} bounds=(${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height})${d.id === primary.id ? ' [PRIMARY]' : ''}`);
  });

  const win = new BrowserWindow({
    width:           260,
    height:          72,
    // Use bounds.x/y rather than 0/0 so multi-monitor setups still land
    // on the primary work area's actual origin (e.g. negative coords if
    // the primary is to the right of a leftward monitor).
    x:               bounds.x + 0,
    y:               bounds.y + 0,
    frame:           false,
    transparent:     true,
    resizable:       false,
    movable:         false,
    minimizable:     false,
    maximizable:     false,
    fullscreenable:  false,
    skipTaskbar:     true,
    focusable:       false,
    show:            false,
    hasShadow:       false,
    // 'pop-up' avoids the brief taskbar flash some Windows configs show
    // when a normal window first appears.
    type:            'toolbar',
    backgroundColor: '#00000000',
    webPreferences: {
      preload:           path.join(__dirname, 'tier-overlay', 'preload.cjs'),
      contextIsolation:  true,
      nodeIntegration:   false,
      sandbox:           false,
      // Disable spellcheck etc. - pure rendering surface.
      spellcheck:        false,
      // Forces the window to never throttle when occluded so the pop
      // animation stays smooth even if it's behind other windows when
      // first shown (we re-raise it immediately on show).
      backgroundThrottling: false,
    },
  });

  // Forward renderer console output to the main log so the user's
  // packaged-build crashes inside the overlay HTML are diagnosable.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    logInfo(`[overlay:console] ${level} ${source}:${line} ${message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logError(new Error(`[overlay] did-fail-load code=${code} url=${url} desc=${desc}`));
  });

  // Click-through across the whole window. `forward: true` means the
  // overlay still receives input events for hover purposes if we ever
  // want them - currently we don't, but it costs nothing.
  win.setIgnoreMouseEvents(true, { forward: true });

  // Highest practical z-order. 'screen-saver' is one notch below the
  // OS modal; nothing the user normally interacts with sits above it.
  win.setAlwaysOnTop(true, 'screen-saver');

  // Hide from Alt+Tab so the overlay doesn't show in the window switcher.
  // (frame:false alone is not enough - Windows still adds it to Alt+Tab.)
  win.setSkipTaskbar(true);

  win.loadFile(path.join(__dirname, 'tier-overlay', 'index.html'));

  win.on('closed', () => {
    if (overlayWin === win) overlayWin = null;
  });

  return win;
}

// Make sure the window exists and is ready, then show it on top.
async function ensureWindow() {
  if (isAlive(overlayWin)) return overlayWin;
  logInfo('[overlay] buildWindow() - creating BrowserWindow');
  overlayWin = buildWindow();
  // Wait for the renderer to finish loading before sending it data -
  // otherwise the IPC fires into the void and the pill never animates.
  await new Promise((resolve) => {
    if (!overlayWin) return resolve();
    overlayWin.webContents.once('did-finish-load', () => {
      logInfo('[overlay] did-finish-load');
      resolve();
    });
  });
  return overlayWin;
}

// Public: show a tier pill. Called from the renderer via the
// `tier-overlay:show` IPC handler registered below.
async function show(tier) {
  logInfo(`[overlay] show(${tier}) called`);
  if (!tier) { logInfo('[overlay] show() bailed - no tier'); return; }

  const win = await ensureWindow();
  if (!isAlive(win)) { logInfo('[overlay] show() bailed - window not alive'); return; }

  // Show + raise to top in case the user's switched apps. show() also
  // forces the always-on-top setting to take effect on Windows.
  if (!win.isVisible()) {
    logInfo('[overlay] showInactive()');
    win.showInactive();
  }
  win.moveTop();
  const b = win.getBounds();
  logInfo(`[overlay] window bounds after show: x=${b.x} y=${b.y} ${b.width}x${b.height}; visible=${win.isVisible()}`);

  win.webContents.send('tier-overlay:show', tier);
  logInfo(`[overlay] IPC tier-overlay:show sent with tier=${tier}`);

  // Safety net - if the renderer doesn't fire `tier-overlay:done` (e.g.
  // CSS animation event never fires for some reason), hide on a timer.
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (isAlive(win) && win.isVisible()) {
      logInfo('[overlay] safety-hide timer fired');
      win.hide();
    }
  }, SAFETY_HIDE_MS);
}

function registerIpc() {
  logInfo('[overlay] registerIpc()');
  // Renderer asks main to show the pill with a given tier.
  ipcMain.handle('tier-overlay:show', async (_e, tier) => {
    logInfo(`[overlay] IPC received tier-overlay:show tier=${tier}`);
    try { await show(tier); return { ok: true }; }
    catch (e) {
      logError(new Error(`[overlay] show() threw: ${e?.message || e}`));
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Overlay tells main its animation completed - hide the window so it
  // stops drawing. The next show() reveals it again.
  ipcMain.on('tier-overlay:done', () => {
    logInfo('[overlay] renderer reported animation done');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (isAlive(overlayWin) && overlayWin.isVisible()) overlayWin.hide();
  });
}

function destroy() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (isAlive(overlayWin)) {
    try { overlayWin.close(); } catch { /* nbd */ }
  }
  overlayWin = null;
}

module.exports = { registerIpc, show, destroy };
