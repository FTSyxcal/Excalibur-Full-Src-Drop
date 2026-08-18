// System-tray icon, created only while the window is hidden.
//
// Excalibur had NO tray at all. That is what turned a leaked process into an
// unkillable one: the window was gone, there was no taskbar button and no tray
// icon, so Task Manager was the only way out (see the shutdown fix in main.js).
//
// The tray now exists for exactly one job - being the way back to a window you
// closed to the tray on purpose. It is created when the window hides and
// destroyed when it comes back, so a user who never turns `closeToTray` on
// never gets a tray icon at all, and the tray is never sitting there meaning
// nothing.
//
// THE LOAD-BEARING RULE: `show()` returns false if the icon could not be
// created. The caller must not hide the window when that happens - hiding with
// no tray to restore from would recreate the exact bug this replaced, except
// deliberately.

const path = require('path');
const fs = require('fs');
const { Tray, Menu, app, nativeImage } = require('electron');
const { logError, logInfo } = require('./logger.cjs');

let tray = null;

// dist/ is what ships inside the packaged app (public/ is copied into it by
// Vite), and public/ is where it lives when running from source. Try both
// rather than assuming, because a missing icon is the one failure that would
// leave someone with no way back to their window.
//
// PNG FIRST, and this is not a style preference. Measured against a real
// Electron runtime: this repo's gtmp-icon.ico loads through
// nativeImage.createFromPath as an EMPTY image on Windows, while icon.png loads
// fine and produces a working Tray. The .ico is still perfectly good for the
// Windows shell (it is what the .gtmp file association uses) - it is only
// nativeImage that will not read it. Putting the .ico first would mean the tray
// silently never appeared.
function iconCandidates() {
  return [
    path.join(__dirname, '..', 'dist', 'icon.png'),
    path.join(__dirname, '..', 'public', 'icon.png'),
    path.join(__dirname, '..', 'dist', 'gtmp-icon.ico'),
    path.join(__dirname, '..', 'public', 'gtmp-icon.ico'),
  ];
}

// The first candidate that both exists AND decodes into a non-empty image.
// Existence alone is not enough - see the note above.
function loadIcon() {
  for (const p of iconCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (img.isEmpty()) { logInfo(`[tray] ${p} decoded as an empty image - skipping`); continue; }
      // Windows tray slots are 16px; handing over a 256px source leaves the
      // scaling to the shell and it comes out muddy.
      const sized = img.resize({ width: 16, height: 16 });
      return { image: sized.isEmpty() ? img : sized, path: p };
    } catch (e) {
      logInfo(`[tray] ${p} failed to load: ${e?.message || e}`);
    }
  }
  return null;
}

function isAlive() {
  return !!tray && !tray.isDestroyed?.();
}

// Show the tray icon. `onOpen` restores the window; `onQuit` performs a real
// quit. Returns true only if there is now a working icon on screen.
function show({ onOpen, onQuit }) {
  if (isAlive()) return true;
  try {
    const icon = loadIcon();
    if (!icon) {
      logError(new Error('[tray] no usable icon found - refusing to create a tray with no icon'));
      return false;
    }
    tray = new Tray(icon.image);
    tray.setToolTip('Excalibur');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Excalibur', click: () => onOpen?.() },
      { type: 'separator' },
      // Quit is on the menu because the tray icon must never be a trap: there
      // has to be a way to end the app from the only surface it still has.
      { label: 'Quit Excalibur', click: () => onQuit?.() },
    ]));
    // Windows convention: a plain click reopens. Double-click too, since people
    // do both and a tray icon that ignores the obvious gesture reads as broken.
    tray.on('click', () => onOpen?.());
    tray.on('double-click', () => onOpen?.());
    logInfo(`[tray] icon created from ${icon.path}`);
    return true;
  } catch (e) {
    logError('[tray] failed to create:', e);
    tray = null;
    return false;
  }
}

function destroy() {
  if (!isAlive()) { tray = null; return; }
  try { tray.destroy(); } catch { /* already gone */ }
  tray = null;
}

module.exports = { show, destroy, isAlive };
