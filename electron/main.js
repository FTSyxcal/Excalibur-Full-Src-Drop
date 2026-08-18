// Electron main process.
// Owns: window lifecycle, IPC handlers, Steam detection, mod filesystem ops,
// profile storage, and logging. The renderer never touches `fs` or `child_process`
// directly - everything goes through the `gtmm` bridge exposed by preload.cjs.

// Sentry must initialize BEFORE anything else so it can capture early boot
// crashes (e.g. an exception during config load or window creation).
require('./sentry.cjs').init();

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, protocol, net } = require('electron');

// Custom protocol so the renderer can <img src> a user-uploaded modpack
// icon. We can't use file:// URLs because the renderer is served from
// http://localhost (dev) or app:// (packaged) with webSecurity:true,
// which blocks cross-origin file loads. The scheme must be registered
// BEFORE app.whenReady() resolves; the actual handler binds inside it.
protocol.registerSchemesAsPrivileged([
  // corsEnabled matters: without it the renderer can load an icon into an
  // <img> but the canvas it is drawn onto is TAINTED, so toDataURL() throws.
  // That silently broke pack icons on the wristband, because the encoder
  // swallows the throw and reports "no icon".
  { scheme: 'excalibur-icon', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { detectGorillaTagPath, detectAllGorillaTagFolders, recommendedGorillaTagFolder, launchGorillaTag, quitGorillaTag, isGorillaTagRunning, getGorillaTagRunning } = require('./steam.cjs');
const gtDisplay = require('./gt-display.cjs');
const { scanMods, toggleMod, setAllMods, installMods, renameMod, moveMod, createFolder, deleteMod, suggestRegistryMatch, getPluginsDir } = require('./mods.cjs');
const gtVersions = require('./gt-versions.cjs');
const crashDiagnose = require('./crash-diagnose.cjs');
const { exportPack, readPack, importPack, extractPackForProfile } = require('./packs.cjs');
const crypto = require('crypto');
const { loadConfig, saveConfig, getConfigPath, defaults: configDefaults } = require('./config.cjs');
const media = require('./media.cjs');
const { listProfiles, saveProfile, deleteProfile, applyProfile, replaceAll, ensureStandardProfile, removeModFromAllProfiles, renameModInAllProfiles } = require('./profiles.cjs');
const { finalizeRename } = require('./smart-naming.cjs');
const sync = require('./sync.cjs');
const { logInfo, logError, getLogPath, writeDataDirPointer } = require('./logger.cjs');
const bridge           = require('./bridge.cjs');
const discordPresence  = require('./discord-presence.cjs');
// (The presence + OBS boot block that used to live here has moved into
// app.whenReady, AFTER the single-instance check. At module scope it ran in the
// DOOMED second instance too: syncObsWebsocket() rewrites OBS's own config file
// and the 15s interval kept firing until that process finally exited, so
// launching the app twice had a second copy editing OBS settings underneath the
// live one. Exactly the class of bug the bridge.token note in whenReady
// describes.)
const auth             = require('./auth.cjs');
const githubVerify     = require('./github-verify.cjs');
const downloader       = require('./mod-downloader.cjs');
const githubRepo       = require('./github-repo.cjs');
const modPayload       = require('./mod-payload.cjs');
const peerProcess      = require('./peer-process.cjs');
const modIntegrity     = require('./mod-integrity.cjs');
const diagnostics      = require('./diagnostics.cjs');
const notificationMirror = require('./notification-listener.cjs');
// Resume the notification listener across restarts if it was already
// configured (feature on + at least one allow-listed app) - same pattern as
// the presence-prefs block above.
{
  const _cfg = loadConfig();
  const _apps = _cfg.notificationMirrorApps || [];
  notificationMirror.setAllowedApps(_apps);
  if (_cfg.features?.['notification-mirror'] && _apps.length > 0) notificationMirror.ensureRunning();
}

// True once the in-game mod has sent its `hello` this connection. Distinguishes
// the real mod from the loader stub's transient payload-fetch connection so the
// connection UI and presence push only fire for the mod. See handleModHello.
let modHelloSeen = false;

// The game folder the patcher was last deployed into (Steam install, or a
// side-loaded version). Tracked so we can remove the patcher again when the game
// closes - it lives on disk ONLY during an Excalibur-launched session, so a
// plain Steam launch loads nothing Excalibur. See removeIdlePatcher.
let lastPatcherTarget = null;
// A launch is in flight until this timestamp, or until the game is actually
// seen running (whichever comes first).
//
// THE RESTART BUG THIS FIXES: the 5s poll strips the patcher the moment it
// sees "was running -> not running". On a restart the old process dies, the
// relaunch deploys a fresh patcher and asks Steam to start the game — but
// Steam + Unity + SteamVR take several seconds to show a process, so the very
// next poll tick still sees nothing running, concludes the session ended, and
// DELETES the patcher that was just written for the launch now in progress.
// The game then comes up with no Excalibur at all: "restart launches with no
// mods". Suppressing the cleanup while a launch is pending closes that window.
let launchGraceUntil = 0;
function removeIdlePatcher() {
  if (Date.now() < launchGraceUntil) {
    logInfo('[ModPayload] skipping patcher cleanup - a launch is still in flight');
    return;
  }
  try { modPayload.removePatcher(lastPatcherTarget || loadConfig().gamePath); }
  catch (e) { logError('[ModPayload] idle patcher removal failed:', e.message); }
}
const updater          = require('./updater.cjs');
const tierOverlay      = require('./tier-overlay.cjs');
const tray             = require('./tray.cjs');
const logWindow        = require('./log-window.cjs');
const testLabWindow    = require('./test-lab-window.cjs');
const lumaWindow       = require('./luma-window.cjs');
const { registerLumaPresets, findPresetByName } = require('./luma-presets.cjs');
const shortcuts        = require('./shortcuts.cjs');
const os               = require('os');
const https            = require('https');

const isDev = !app.isPackaged;

// Live-logs pop-out window (tails BepInEx/LogOutput.log). Registers its IPC now;
// the window itself is only created when the user opens it.
logWindow.registerLogWindow({
  isDev,
  preloadPath: path.join(__dirname, 'preload.cjs'),
  indexHtml:   path.join(__dirname, '..', 'dist', 'index.html'),
  devUrl:      'http://localhost:5174',
  icon:        path.join(__dirname, '..', 'dist', 'icon.png'),
  getGamePath: () => { try { return loadConfig().gamePath || null; } catch { return null; } },
});

// Mod Test Lab pop-out (built-in feature tester). Same deps as the log window;
// the window is only created when the dev opens it from the Developer Panel.
testLabWindow.registerTestLabWindow({
  isDev,
  preloadPath: path.join(__dirname, 'preload.cjs'),
  indexHtml:   path.join(__dirname, '..', 'dist', 'index.html'),
  devUrl:      'http://localhost:5174',
  icon:        path.join(__dirname, '..', 'dist', 'icon.png'),
});

// Luma Looks pop-out (the gold/black realism controller). Opened by the in-game Ctrl+Shift+L keybind
// via the 'luma_open' bridge message below; the window is only created on first open.
lumaWindow.registerLumaWindow({
  isDev,
  preloadPath: path.join(__dirname, 'preload.cjs'),
  indexHtml:   path.join(__dirname, '..', 'dist', 'index.html'),
  devUrl:      'http://localhost:5174',
  icon:        path.join(__dirname, '..', 'dist', 'icon.png'),
});

// ─── Test Lab: on-demand mod rebuild ──────────────────────────────────────
// `npm run dev` runs a file watcher that rebuilds the mods on every C# save,
// but the watcher can die with its dev session (or never start, if the app was
// launched on its own) — and then edits made in another session go stale
// silently. These two handlers back the Test Lab's "Update mods" button:
// check whether any source is newer than the built payload, and rebuild
// everything on demand. Both delegate to scripts/build-mods-once.mjs, the same
// implementation the watcher uses.
//
// Dev-only: a packaged app ships no scripts/ or C# sources and has no .NET SDK.
const MODS_ONCE_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-mods-once.mjs');

function runModsScript(args) {
  return new Promise((resolve) => {
    if (!isDev || !fs.existsSync(MODS_ONCE_SCRIPT)) {
      resolve({ ok: false, error: 'Mod rebuild is only available in a dev checkout.' });
      return;
    }
    // process.execPath is electron.exe; ELECTRON_RUN_AS_NODE makes it behave as
    // plain node so it can run the .mjs build script (and its own children).
    const child = spawn(process.execPath, [MODS_ONCE_SCRIPT, ...args], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', () => {
      // The script prints exactly one JSON line; take the last non-empty line
      // so any stray build chatter can't break parsing.
      const line = out.trim().split('\n').filter(Boolean).pop();
      try { resolve({ ok: true, data: JSON.parse(line) }); }
      catch { resolve({ ok: false, error: (err || out || 'no output').trim().slice(0, 400) }); }
    });
  });
}

// Status is a pure fs walk, so import the ESM module in-process (cheap enough
// for the Test Lab to poll). The BUILD stays a child process: build-mods-once
// spawns `process.execPath` for its sub-builds, which must be node-behaving.
let _modsOnceMod = null;
async function modsOnceModule() {
  if (!_modsOnceMod) _modsOnceMod = await import(require('url').pathToFileURL(MODS_ONCE_SCRIPT).href);
  return _modsOnceMod;
}

ipcMain.handle('testlab:mods-status', async () => {
  try {
    if (!isDev || !fs.existsSync(MODS_ONCE_SCRIPT)) return { ok: false, error: 'dev-only' };
    const m = await modsOnceModule();
    return ok(m.modsStatus());
  } catch (e) { return fail(e); }
});

ipcMain.handle('testlab:rebuild-mods', () => runModsScript(['--json']));

// Hold a single window reference so we can restore/position it correctly
// and persist geometry on close.
let mainWindow = null;

// ── Luma Looks engine control (2026-07-31) ───────────────────────────────────
// The 'luma-looks' built-in feature hosts the realism engine inside the mod; the engine keeps a
// loopback control server on 47800 (electron/luma-bridge.cjs is our client of it). The renderer's
// Luma panel drives every effect through these handlers, and the engine's live settings + stats are
// forwarded to the window so the panel always reflects the real state. Declared AFTER mainWindow so
// the forwarders (which only fire at event time) reference an already-defined binding.
const { LumaEngineClient } = require('./luma-bridge.cjs');
const lumaEngine = new LumaEngineClient();
// Broadcast to EVERY window, not just mainWindow: the Luma panel lives in the dedicated pop-out
// (electron/luma-window.cjs, ?window=luma), so sending only to mainWindow left the controller stuck
// on "Waiting for the Luma engine" even after the engine connected and sent its hello.
const lumaBroadcast = (channel, d) => {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send(channel, d); } catch { /* window gone */ }
  }
};
// The "starting look": lumaLooksConfig.defaultPreset applies ONCE per game
// session, on the engine's first hello. Never over queued offline edits
// (fromPending - those are the user's newest intent), and never on a
// mid-session socket reconnect (the once-flag, cleared when the game exits).
let lumaStartingLookApplied = false;
lumaEngine.on('hello', (d) => {
  try {
    if (!lumaStartingLookApplied && !d?.fromPending) {
      const name = loadConfig()?.lumaLooksConfig?.defaultPreset;
      const preset = name ? findPresetByName(name) : null;
      if (preset) {
        logInfo(`[luma] applying starting look "${preset.name}"`);
        lumaEngine.apply(preset.settings);
        d = { ...d, settings: preset.settings };   // the panel should show what the game now runs
      } else if (name) {
        // A configured name that no longer resolves used to do NOTHING, silently -
        // indistinguishable from "no starting look set". The built-in preset list
        // was replaced wholesale on 2026-08-02, so a config still naming one of the
        // old ones lands here, and the user needs to be told rather than left
        // wondering why their starting look stopped applying.
        logError(`[luma] starting look "${name}" no longer exists - pick another in Specials`);
      }
    }
  } catch (e) { logError('[luma] starting look failed:', e && e.message); }
  lumaStartingLookApplied = true;
  lumaBroadcast('luma:hello', d);
});
lumaEngine.on('state', (d) => lumaBroadcast('luma:state', d));
lumaEngine.on('stats', (d) => lumaBroadcast('luma:stats', d));
// Whether a Luma panel has asked for the engine link and not explicitly let go. The bridge
// 'disconnected' handler below stops the client when Gorilla Tag exits, so without this flag an
// embedded panel left open across a game relaunch stayed dead until a remount called luma:connect
// again. handleModHello reconnects when this is set; connect() itself is idempotent (no-op while a
// socket exists), so hello + a mounted panel can never open two links.
let lumaPanelWants = false;
ipcMain.handle('luma:connect', () => { lumaPanelWants = true; lumaEngine.connect(); return lumaEngine.status(); });
ipcMain.handle('luma:disconnect', () => { lumaPanelWants = false; lumaEngine.stop(); return { ok: true }; });
ipcMain.handle('luma:apply', (_e, settings) => {
  // A panel edit revives a dropped link (idempotent no-op while connected).
  // Covers enabling the Luma feature mid-game after the hello-time reconnect
  // was skipped because the feature was still off at game launch.
  if (lumaPanelWants && !lumaEngine.connected) { try { lumaEngine.connect(); } catch { /* retry loop */ } }
  return { ok: lumaEngine.apply(settings) };
});
ipcMain.handle('luma:status', () => lumaEngine.status());
// Preset save/apply/import/export (built-in controller's presets area) — see electron/luma-presets.cjs.
registerLumaPresets();

// ─── Gorilla Tag display-settings restore ────────────────────────────────
// Excalibur's -screen-* / -popupwindow / -monitor launch args are persisted by
// Unity into GT's PlayerPrefs, so without intervention they leak into later
// *plain* Steam launches (the windowed/title-bar bug, or a forced resolution).
// We flag a restore whenever we launch with such an override, then put GT's
// display back to its own defaults once that game session ends. The user's
// chosen options stay saved in Excalibur's config, so the next Excalibur launch
// re-applies them - no loss of convenience. See electron/gt-display.cjs.
function launchHasDisplayOverride(o) {
  if (!o) return false;
  if (o.displayMode && o.displayMode !== 'default') return true;
  if (o.resolution  && o.resolution  !== 'default') return true;
  if (o.monitor     && o.monitor     !== 'default') return true;
  if (o.customArgs && /-screen-|-popupwindow|-monitor\b/i.test(o.customArgs)) return true;
  return false;
}

function flagPendingDisplayRestore() {
  try {
    const cfg = loadConfig();
    if (!cfg.pendingDisplayRestore) { cfg.pendingDisplayRestore = true; saveConfig(cfg); }
  } catch (e) { logError('[gt-display] could not flag pending restore:', e && e.message); }
}

// Restore GT display defaults if a prior Excalibur launch applied overrides.
// MUST only run while the game is NOT running (Unity rewrites these keys on game
// exit, so a mid-game restore would just be overwritten).
function maybeRestoreGtDisplay() {
  try {
    const cfg = loadConfig();
    if (!cfg.pendingDisplayRestore) return;
    gtDisplay.restoreGorillaTagDisplayDefaults();
    const fresh = loadConfig();
    fresh.pendingDisplayRestore = false;
    saveConfig(fresh);
  } catch (e) { logError('[gt-display] restore failed:', e && e.message); }
}

// Guards the before-quit handler so cleanup only runs once.
let _quitCleanupStarted = false;

// True once a REAL quit has been asked for, as opposed to a window close that
// the closeToTray setting turns into a hide. Every genuine exit route sets it
// (tray menu, the in-app force-quit, app.quit() from anywhere) so the window's
// close handler knows not to intercept.
let _reallyQuitting = false;

// Restore the window from the tray, or from a minimised state. Also the
// single-instance handler's job, so a second launch surfaces the running copy
// instead of appearing to do nothing.
function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // The tray icon is PERMANENT now (see ensureTray) and is deliberately NOT
  // destroyed here. It used to exist only while the window was hidden, which
  // meant a running Excalibur you could not see - the window closed, or a
  // launch that never presented one - offered no way out but Task Manager.
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  // Tell the renderer it is back on screen. With closeToTray on, this IS the
  // user's "opening the app" - they may not have restarted it in days - so it
  // is the moment to re-check anything that would otherwise only be read at
  // boot. See the handler in src/App.jsx.
  try { mainWindow.webContents.send('app:revealed'); } catch { /* window went away */ }
}

// A real quit, from wherever it was asked for.
function quitForReal() {
  _reallyQuitting = true;
  app.quit();
}

// Excalibur keeps a tray icon for its WHOLE lifetime, not just while hidden
// (owner request). The icon is the app's always-available "I am running, and
// here is how to stop me" surface: Quit Excalibur ends it from one click, so
// a window you closed, minimised, or never saw is no longer a Task Manager
// job. tray.show() is idempotent - it returns early when an icon already
// exists - so this is safe to call from several places.
function ensureTray() {
  try { tray.show({ onOpen: revealMainWindow, onQuit: quitForReal }); }
  catch (e) { logError('[tray] ensure failed:', e && e.message); }
}

// Clamp persisted window bounds so a saved position from a monitor that's
// no longer connected doesn't hide the window off-screen. If the stored
// rect doesn't overlap any current display, drop the x/y and center on the
// primary display using default dimensions.
function reconcileBounds(saved) {
  const fallback = { width: 1200, height: 800 };
  if (!saved) return fallback;
  const displays = screen.getAllDisplays();
  const overlaps = displays.some((d) => {
    const a = d.workArea;
    return (
      saved.x < a.x + a.width &&
      saved.x + (saved.width || 0) > a.x &&
      saved.y < a.y + a.height &&
      saved.y + (saved.height || 0) > a.y
    );
  });
  if (!overlaps) {
    return { width: saved.width || fallback.width, height: saved.height || fallback.height };
  }
  return saved;
}

// ── excalibur:// deep-link handler ─────────────────────────────────
// Friend-invite links live at `excalibur://profile/<username>`. When
// the user (or someone with the app installed) clicks one, Windows
// routes it through the protocol handler we register below. We pick
// up the URL out of process.argv on cold-start, or via the
// 'second-instance' event on warm-start (single-instance lock means
// the second launch attempts dies, but its argv gets forwarded to us).

const PROTOCOL = 'excalibur';

// Enforce single-instance so the OS forwards protocol launches to the
// already-running window instead of spawning a parallel Electron.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Second launch happened (the OS spawned a new Excalibur because
    // someone clicked a `excalibur://` URL). Forward its argv to the
    // existing window for routing.
    // revealMainWindow rather than restore+focus: with closeToTray on, the
    // running copy may be HIDDEN, not minimised, and restore() does nothing to
    // a hidden window. Launching the app again while it sits in the tray is the
    // most natural way to ask for it back, and it used to silently do nothing.
    revealMainWindow();
    // Warm-start Test Lab shortcut: a throwaway `electron . --test-lab`
    // instance loses the lock and forwards its argv here. Open the pop-out
    // on the already-running app instead of spinning up a second stack.
    if (argv.some((a) => typeof a === 'string' && a.includes('--test-lab'))) {
      try { testLabWindow.openTestLabWindow(); } catch { /* non-fatal */ }
    }
    const url = argv.find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`));
    if (url) routeDeepLink(url);
  });
}

function registerProtocolHandler() {
  // Tell Windows that excalibur:// URLs should launch this exe. The
  // path arg is needed in dev so the protocol points at the right
  // electron binary (in packaged builds, app.getPath('exe') is the
  // real exe and the arg is unused).
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
  // Cold-start: argv might contain the URL the user clicked (a desktop
  // modpack shortcut, or a link from the browser).
  //
  // This used to wait for 'did-finish-load' and fire immediately after. That
  // is far too early: the page having loaded says nothing about whether the
  // renderer has read the profile list yet, and the play handler needs it.
  // Queue it instead and let the renderer pull it when it can actually act.
  const startupUrl = process.argv.find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`));
  if (startupUrl) routeDeepLink(startupUrl);
}

// ── Deep-link delivery queue ───────────────────────────────────────
// Deep links used to be fired at the renderer the moment they were parsed,
// which lost every COLD start. A desktop shortcut launch arrives before the
// app has finished booting: the window exists and the page has loaded, but
// React has not yet read the profile list off disk, so the play handler
// looked up an id in an empty array and returned silently. Double-clicking a
// modpack shortcut with Excalibur closed opened the app and did nothing else.
//
// So links queue here until the renderer says it is ready to act on them,
// and the renderer only says that once boot has finished. A warm start
// flushes immediately because the flag is already set.
let deepLinkQueue = [];
let deepLinkReady = false;

function flushDeepLinks() {
  if (!deepLinkReady || !mainWindow || mainWindow.isDestroyed()) return;
  const pending = deepLinkQueue;
  deepLinkQueue = [];
  for (const payload of pending) {
    try { mainWindow.webContents.send('deeplink', payload); } catch { /* window went away mid-flush */ }
  }
}

// The renderer calls this once it has booted (profiles loaded, game path
// known). Re-fired on every reload, which is what makes dev HMR work.
ipcMain.on('deeplink:ready', () => {
  deepLinkReady = true;
  flushDeepLinks();
});

// Parse `excalibur://profile/<username>` etc. and forward to the
// renderer. The renderer's deeplink listener decides what UI to open.
function routeDeepLink(url) {
  try {
    const u = new URL(url);
    // Path is e.g. //profile/someone → host=profile, pathname=/someone.
    // We're permissive: treat the URL as { kind, target } and let the
    // renderer interpret kind-specific routing.
    const kind   = u.hostname;                                    // 'profile'
    const target = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    deepLinkQueue.push({ kind, target, url });
    flushDeepLinks();
  } catch (e) {
    logError?.('deeplink parse failed:', e);
  }
}

// True when this process was auto-launched by the Windows startup entry with the
// "minimized" flag, so we open into the taskbar instead of popping to the front.
const START_MINIMIZED = process.argv.includes('--startup-minimized');

// Cold-start Test Lab shortcut: launched via the pinned Test Lab shortcut,
// which either passes `--test-lab` or sets EXCALIBUR_OPEN_TEST_LAB=1 (the env
// path is how `npm run dev` threads it through concurrently). Gated behind an
// explicit opt-in, so a normal launch never opens the pop-out.
const OPEN_TEST_LAB =
  process.argv.includes('--test-lab') || process.env.EXCALIBUR_OPEN_TEST_LAB === '1';

// Sync the Windows "launch at startup" registry Run entry with config. When on,
// the entry passes --startup (+ --startup-minimized when the user wants it to
// open minimized) so the app can tell a boot-launch from a manual one. Only
// meaningful in the packaged build - skipped in dev so we never register the
// bare electron.exe on the user's machine.
function applyLoginItemSettings(config) {
  if (isDev) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!config.launchOnStartup,
      path: process.execPath,
      args: config.startMinimized ? ['--startup-minimized'] : ['--startup'],
    });
  } catch (e) {
    logError('setLoginItemSettings failed:', e);
  }
}

function createWindow() {
  const config = loadConfig();
  const bounds = reconcileBounds(config.window);

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 640,
    // FRAMELESS + OPAQUE. The window WAS `transparent: true` so the app could
    // own a 10px CSS corner (2px more than Windows' fixed 8px DWMWCP_ROUND).
    // That flag turned out to cost far more than 2px of curvature:
    //
    //   * Electron FORCE-DISABLES `thickFrame` on transparent Windows windows
    //     no matter what you pass, stripping WS_THICKFRAME. The old comment
    //     here claimed thickFrame survived and Snap kept working - it did not.
    //     Owner-observed 2026-07-28: no drag-to-edge, no Win+arrow, no Snap
    //     Layouts, and window dragging was visibly stuttery.
    //   * Transparent windows composite with per-pixel alpha (no opaque fast
    //     path), which is where the drag stutter came from.
    //
    // Opaque + frameless keeps `thickFrame` genuinely at its TRUE default, so
    // WS_THICKFRAME is back: Aero Snap (drag-to-edge, Win+arrow, the Win11
    // snap-layouts bar on drag-to-top and Win+Z), edge-drag resizing, native
    // open/close animations, and the DWM drop shadow all work again. Win11's
    // DWM also auto-rounds frameless thick-frame windows (8px) and clips the
    // content itself, so the CSS corner radii were removed from index.css -
    // rounding in CSS on top of the DWM arc is exactly the double-curve bug
    // the transparent design was built to dodge. Win10 renders square
    // corners; accepted.
    //
    // What the earlier `titleBarStyle: 'hidden'` attempt actually hated was
    // the 1px (29,29,29) caption hairline plus CSS-over-native double arcs;
    // plain `frame: false` has no caption border, and with no CSS arc there
    // is nothing to double.
    //
    // Critical: do NOT add `titleBarOverlay` here. That caused the window to
    // never fire ready-to-show in a previous attempt (made alongside
    // transparency; untested against an opaque window - revisit deliberately
    // if the native-caption Snap Layouts flyout is ever wanted).
    frame: false,
    // Flash guard: painted by the compositor before the renderer's first
    // frame and during resize reveals. Matches the app's base background
    // (#040404, the dark end of #root::before's gradient); the UI theme is
    // currently hardcoded dark in App.jsx. If the dormant DWM
    // background-material path ('window:set-background-material') is ever
    // revived for the acrylic/mica look - which this opacity change finally
    // UNBLOCKS, see the note in App.jsx - the material only shows where the
    // window background is not painted, so this value must be swapped out at
    // the same time.
    backgroundColor: '#040404',
    //
    // `show: false` + ready-to-show (below) still does real work: it holds
    // the window until the renderer's first real paint, so launch shows one
    // finished frame instead of a bare #040404 rectangle.
    icon: path.join(__dirname, '..', 'dist', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);

  attachRendererConsole(mainWindow);

  // Application menu is stripped for a clean chrome-less look, which also
  // removes the default DevTools accelerator. Re-bind Ctrl+Shift+I and F12,
  // but ONLY for developers and testers - server-verified via the JWT's
  // app_role / is_tester claims, which a regular user cannot forge without
  // the RS256 private key. This keeps the inspector available for support
  // and self-diagnosis while preventing casual snooping on the renderer.
  // A reload throws away the renderer's deep-link listener, so anything we
  // flushed to the old page is gone. Signing in does exactly that: the auth
  // screen calls location.reload() once the JWT is stored. Without this, a
  // shortcut clicked while signed out delivered its link to the page that was
  // about to be replaced and the game never launched. Re-arm the queue and
  // wait for the new renderer to say it is ready.
  mainWindow.webContents.on('did-start-loading', () => { deepLinkReady = false; });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isToggle =
      (input.control && input.shift && input.key.toLowerCase() === 'i') ||
      input.key === 'F12';
    if (!isToggle) return;

    try {
      const tok = auth.getToken();
      if (!tok) return;
      const p = auth.parseJwtPayload(tok) || {};
      const allowed = p.app_role === 'developer' || p.is_tester === true;
      if (!allowed) return;
    } catch { return; }

    mainWindow.webContents.toggleDevTools();
    event.preventDefault();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5174');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    // The tray icon goes up as soon as there is an app to quit, and stays for
    // the whole session. A start-minimized launch is exactly the case that
    // used to leave no way out but Task Manager.
    ensureTray();
    // Startup-minimized launches open straight into the taskbar (shown but not
    // focused, then minimized) instead of grabbing the foreground on boot.
    if (START_MINIMIZED) {
      mainWindow.showInactive();
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
    // The renderer is now loaded from Vite, so the pop-out (which loads the
    // same dev URL) is guaranteed to have a server to hit. Open it here.
    if (OPEN_TEST_LAB) {
      try { testLabWindow.openTestLabWindow(); } catch { /* non-fatal */ }
    }
  });

  // Tell the renderer when window focus changes so it can pause/resume
  // CSS animations + JS work that doesn't need to run when the user
  // has tabbed away. Massive perf win - Excalibur stops eating CPU
  // when you're not actively looking at it.
  const sendFocus = (focused) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:focus-changed', !!focused);
    }
  };
  mainWindow.on('focus',   () => sendFocus(true));
  mainWindow.on('blur',    () => sendFocus(false));
  mainWindow.on('show',    () => sendFocus(mainWindow.isFocused()));
  mainWindow.on('hide',    () => sendFocus(false));
  mainWindow.on('minimize',() => sendFocus(false));
  mainWindow.on('restore', () => sendFocus(mainWindow.isFocused()));

  // Persist size + position so the window reopens where the user left it.
  //
  // DEBOUNCED, deliberately. 'move' and 'resize' fire continuously while the
  // user drags - dozens of events a second - and this body is entirely
  // synchronous: loadConfig() reads and parses config.json, saveConfig() writes
  // a temp file and renames over it. Undebounced that is a disk write per frame
  // of a window drag, on the main process, blocking the UI.
  //
  // It is not just our own cost either: saveConfig()'s rename is what the
  // in-game mod's ConfigWatcher listens for, so dragging the window used to
  // spam the running game with config reloads.
  //
  // 400ms after the last event is well past the end of a drag and far below the
  // "user might close the app now" threshold; the close path below flushes
  // anyway so nothing is lost.
  let boundsTimer = null;
  const writeBoundsNow = () => {
    boundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const c = loadConfig();
      c.window = mainWindow.getBounds();
      saveConfig(c);
    } catch (e) {
      logError('[bounds] failed to persist window bounds:', e.message);
    }
  };
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(writeBoundsNow, 400);
  };
  // Flush a pending write rather than losing the last drag on quit.
  const flushBounds = () => {
    if (!boundsTimer) return;
    clearTimeout(boundsTimer);
    writeBoundsNow();
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  mainWindow.on('close', flushBounds);

  // Close-to-tray. Opt-in (config.closeToTray, default false), so by default
  // the X still means quit.
  //
  // The order here is the whole safety argument: the tray icon is created
  // FIRST, and the window is only hidden if that succeeded. Hiding a window
  // whose tray icon failed to appear would leave a running app with no taskbar
  // button and no tray entry - which is precisely the bug this release fixes,
  // except deliberately. If the tray cannot be created we let the close happen,
  // and the app quits as it always did.
  mainWindow.on('close', (e) => {
    logInfo(`[shutdown] window close requested (reallyQuitting=${_reallyQuitting})`);
    if (_reallyQuitting) return;                       // tray Quit, force-quit, app.quit()
    let wantsTray = false;
    try { wantsTray = loadConfig().closeToTray === true; } catch { /* default off */ }
    if (!wantsTray) return;

    // Normally already up (ensureTray runs at startup); this re-asserts it and
    // is still the safety gate - hiding a window whose tray icon failed to
    // appear would leave a running app with no taskbar button and no tray
    // entry, which is the bug this exists to prevent.
    const shown = tray.show({ onOpen: revealMainWindow, onQuit: quitForReal });
    if (!shown) {
      logError(new Error('[tray] could not create a tray icon - closing normally instead of hiding'));
      return;
    }
    e.preventDefault();
    persistBounds();          // the bounds would otherwise be lost on a hide
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    logInfo('[shutdown] main window destroyed - quitting');
    mainWindow = null;
    // Closing the main window QUITS. Excalibur has no background mode, so once
    // this window is gone there is no surface left to bring the app back from -
    // unless it was hidden to the tray on purpose, which is handled by the
    // 'close' handler above and never reaches here.
    //
    // This used to rely entirely on 'window-all-closed', which fires only when
    // EVERY window is destroyed - and Excalibur keeps windows the user cannot
    // see. electron/tier-overlay.cjs builds a `show: false, skipTaskbar: true`
    // window the first time the in-game tier pill appears, and never closes it;
    // its own teardown runs from 'before-quit', which is downstream of the
    // app.quit() that 'window-all-closed' was supposed to trigger. So one
    // in-game session was enough to deadlock the whole thing: overlay alive ->
    // 'window-all-closed' never fires -> app.quit() never runs -> 'before-quit'
    // never runs -> overlay never closed. The window vanished, the process kept
    // running with no taskbar entry and no tray icon, and Task Manager was the
    // only way out.
    //
    // Measured with a standalone Electron probe rather than assumed: one
    // hidden skipTaskbar window changes 'window-all-closed' from FIRED to
    // DID NOT FIRE. That is why testers hit this and developers did not - in
    // dev the app is killed by stopping `npm run dev`, which takes the whole
    // process tree with it, so the leak never shows.
    //
    // 'window-all-closed' below stays as the fallback for the case where the
    // main window never existed at all.
    if (process.platform !== 'darwin') app.quit();
  });
}

// ── Navigation lockdown ─────────────────────────────────────────────────────
// The renderer holds `window.gtmm`. `gtmm.auth.status()` returns BOTH raw JWTs
// and `gtmm.util.openFolder()` reaches shell.openPath (which executes an .exe).
// preload stays attached across a navigation, so ANY navigation away from our
// own page hands that whole surface to whatever loaded: account takeover plus
// local code execution.
//
// Two ways in, both open before this block existed:
//   1. window.open() from the renderer. MessagesPanel opened DM image URLs that
//      way, and a DM body is attacker-controlled (see the [img] guard in
//      api/social/messages.js).
//   2. Dropping a link onto the window. DragDropOverlay only called
//      preventDefault for `Files` payloads, so a text/uri-list drop fell
//      through to Chromium's default, which is "navigate".
//
// Registered on web-contents-created so it covers every window this process
// ever creates, including ones added later, rather than just mainWindow.
// Anything that wants to leave the app goes through shell.openExternal with
// the SAME allowlist as the `util:open-external` IPC handler, so there is one
// list rather than two that can drift.
const EXTERNAL_SCHEME_OK = /^(https?:|discord:|ms-settings:)/i;

// The exact pages this app is allowed to be showing. Everything the packaged
// build loads goes through one of these two: `dist/index.html` (the main window
// AND every pop-out - luma, logs, test lab - which pass a ?window= search) and
// the tier overlay's own page.
//
// This used to be `u.protocol === 'file:'`, i.e. "any local file is us". It is
// not: a preload-bearing window navigated to ANY html on disk gets the whole
// window.gtmm surface, which returns raw JWTs and reaches shell.openPath. The
// main window was protected only because DragDropOverlay preventDefaults drops,
// and that component is mounted inside <App/> only - the pop-outs share the
// preload with no such guard, so dropping a downloaded .html onto the Luma
// window was a straight path to local code execution with the user's tokens.
// Comparing the resolved path closes it for every window at once.
const INTERNAL_PAGES = [
  path.resolve(__dirname, '..', 'dist', 'index.html'),
  path.resolve(__dirname, 'tier-overlay', 'index.html'),
];

function isInternalUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'excalibur-icon:') return true;   // our own image scheme
    if (isDev) return u.origin === 'http://localhost:5174';
    if (u.protocol !== 'file:') return false;
    // fileURLToPath handles the Windows `/C:/...` pathname shape and percent
    // decoding; a hand-rolled slice gets both wrong.
    const p = path.resolve(require('url').fileURLToPath(u));
    // Windows paths are case-insensitive, so compare that way or a legitimate
    // load through a differently-cased path would be blocked as hostile.
    const eq = (a, b) => (process.platform === 'win32'
      ? a.toLowerCase() === b.toLowerCase()
      : a === b);
    return INTERNAL_PAGES.some((page) => eq(p, page));
  } catch { return false; }
}

function openExternally(url) {
  try {
    if (typeof url === 'string' && EXTERNAL_SCHEME_OK.test(url)) shell.openExternal(url);
  } catch (e) { logError('[nav] openExternal failed:', e.message); }
}

app.on('web-contents-created', (_e, contents) => {
  // window.open / target=_blank must never create a preload-bearing window.
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });

  // The SteamDB scraper is the one window that is SUPPOSED to browse the web.
  //
  // This guard is registered on web-contents-created, so it covers every window
  // the process makes - including the manifest scraper in gt-versions.cjs, which
  // loads steamdb.info behind a Cloudflare challenge. That challenge navigates
  // and reloads several times, and every one of those hops was preventDefault'd
  // AND handed to the user's real browser, so the scraper could never complete
  // and the person got a pile of unexpected browser tabs instead. It is why
  // fetching a manifest has to be done by hand (the internal notes record
  // saving the page with Ctrl+S as the workaround).
  //
  // Identified by its dedicated session partition rather than by URL, because
  // the whole point is that this window may follow links we do not know ahead of
  // time. It carries NO preload (see the BrowserWindow options there), so the
  // reason this guard exists - "preload stays attached across a navigation and
  // hands window.gtmm to whatever loaded" - does not apply to it.
  // Marked explicitly by whoever creates the window, not sniffed. A heuristic on
  // the URL or session path would be wrong exactly when it matters (the very
  // first navigation happens while the URL is still about:blank).
  const mayBrowseFreely = (c) => c?.excaliburAllowExternalNav === true;

  contents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    if (mayBrowseFreely(contents)) return;   // the scraper is allowed to browse
    event.preventDefault();
    logInfo('[nav] blocked navigation to', String(url).slice(0, 120));
    openExternally(url);
  });

  // Subframes do not fire will-navigate.
  contents.on('will-frame-navigate', (event) => {
    const url = event?.url;
    if (!url || isInternalUrl(url)) return;
    if (mayBrowseFreely(contents)) return;
    event.preventDefault();
    logInfo('[nav] blocked frame navigation to', String(url).slice(0, 120));
  });

  // No <webview> is used today. If one is ever added it must not inherit the
  // preload or node integration.
  contents.on('will-attach-webview', (_evt, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
});

app.whenReady().then(() => {
  // A second instance that lost the single-instance lock must do NOTHING
  // here. app.quit() defers, so `ready` can still fire in the doomed
  // process — it used to run bridge.start(), whose _initToken clobbered
  // the live app's bridge.token on disk (its own listen() then failed
  // EADDRINUSE). Result: every mod handshake failed with "connection
  // closed before payload arrived" until the app was restarted.
  if (!gotInstanceLock) return;

  logInfo('App starting');

  // Presence + OBS boot state. Moved here from module scope so it only ever runs
  // in the instance that actually owns the app - see the note where it used to
  // live. Still before RPC 'ready' fires, which is what the original comment
  // cared about.
  {
    const _cfg = loadConfig();
    discordPresence.setDevStatus(_cfg.devDiscordStatus === true);
    // OBS self-heal: keep obs-websocket usable without the user ever opening
    // Tools -> WebSocket Server Settings. See syncObsWebsocket().
    try { syncObsWebsocket(); } catch { /* best effort */ }
    setInterval(() => { try { syncObsWebsocket(); } catch { } }, 15_000);
    // Hidden feature, defaultEnabled: absent means ON, only an explicit
    // false disables. Applied at boot so the flag survives restarts.
    discordPresence.setEnabled(_cfg.features?.['rich-presence'] !== false);
    discordPresence.setShowClientRpc(_cfg.presenceConfig?.showClientRpc !== false);
  }

  // Tell the in-game mod where our data actually lives. Only writes anything
  // when we are NOT in the canonical %APPDATA%\Excalibur - see the comment on
  // writeDataDirPointer. Without it a portable install (or the tmpdir fallback)
  // leaves the mod unable to find bridge.token, so it never connects and every
  // in-game feature is silently dead.
  writeDataDirPointer();
  tierOverlay.registerIpc();
  bridge.start();
  media.init({ bridge, logInfo, logError });

  // Serve modpack-icon files out of userData/profile-icons under our
  // custom scheme. Path-traversal guard: we resolve the requested name
  // back into the icons dir and reject anything that escapes it.
  try {
    const iconsDir = path.join(app.getPath('userData'), 'profile-icons');
    protocol.handle('excalibur-icon', (req) => {
      try {
        const url = new URL(req.url);
        // URL shape is excalibur-icon://icon/<filename>; URL parser
        // puts the leading segment into host, the rest into pathname.
        const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        const safe = path.basename(name);
        const file = path.join(iconsDir, safe);
        if (!file.startsWith(iconsDir)) return new Response('forbidden', { status: 403 });
        if (!fs.existsSync(file))       return new Response('not found', { status: 404 });
        return net.fetch('file://' + file.replace(/\\/g, '/'));
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    });
  } catch (e) {
    logError('[icons] protocol handler failed:', e.message);
  }

  // (Manifest list is now a static export in src/lib/gt-versions.js -
  // no boot-time fetch needed.)
  // A raw socket handshake on the bridge is NOT necessarily the mod: the loader
  // stub opens a short-lived connection first, purely to fetch the encrypted
  // core payload, then disconnects. We only tell the renderer "mod connected"
  // (and push config) once the real mod announces itself with a `hello` - so
  // that transient loader fetch never flickers the connection UI.
  bridge.on('connected',    () => { /* wait for `hello` (see handleModHello) */ });
  bridge.on('disconnected', () => {
    if (!modHelloSeen) return;   // loader fetch closing, or never really connected
    modHelloSeen = false;
    mainWindow?.webContents.send('bridge:disconnected');
    // Gorilla Tag closed → the Luma engine (hosted in the mod) is gone with it, so tear down the
    // desktop controller too. The owner wants the Luma window tied to the game's lifetime: close GT,
    // the Luma window closes. Also stop the engine client so it isn't left retrying into the void.
    try { lumaWindow.closeLumaWindow(); } catch { /* window already gone */ }
    try { lumaEngine.stop(); } catch { /* not connected */ }
    lumaStartingLookApplied = false;   // next game launch is a new session - starting look applies again
    // DROP THE CACHED PAID ASSEMBLIES WHEN THE GAME CLOSES.
    //
    // They were held for ten minutes, cleared only on logout, so relaunching
    // the game inside that window re-streamed the SAME bytes from memory. On
    // 2026-08-02 that quietly wasted an entire evening: build after build was
    // published to R2 and tested, and several of those launches ran the
    // previous assembly - the owner's "it feels like you're not even changing
    // anything" was literally true, and nothing in either log said so.
    //
    // One launch is one fetch of ~350 KB, which is nothing next to starting
    // Gorilla Tag, and it makes "relaunch the game" mean what everyone already
    // assumes it means.
    try { modPayload.clearTierCache(); } catch { /* best effort */ }
  });
  bridge.on('message', (msg) => {
    mainWindow?.webContents.send('bridge:message', msg);
    if (msg.type === 'hello')                    handleModHello();
    if (msg.type === 'media_cmd')                media.command(msg.cmd, msg.v);
    if (msg.type === 'media_state_request')      media.requestState();
    if (msg.type === 'payload_request')          handlePayloadRequest(msg);
    if (msg.type === 'integrity_report')         modIntegrity.relay(auth.getToken(), msg)
                                                   .catch(() => { /* never surfaces */ });
    // Anti-dump: the in-game mod saw a debugger / dump tool. Log-only for now -
    // the enforcement (withholding the paid half) already happened at the
    // payload_request. Wiring this to the integrity review card needs a server
    // change and is deliberately not done here.
    if (msg.type === 'tamper_report') {
      const reasons = Array.isArray(msg.reasons) ? msg.reasons.join(', ') : 'unknown';
      logError(`[ModPayload] in-game tamper signal this session: ${reasons}`);
    }
    // In-game launch summary + Luma VR readiness, for the Copy Diagnostics
    // report. The desktop cannot see this state on its own, so the mod pushes it
    // and diagnostics.cjs persists the last one - the report then shows what
    // actually happened in-game even after the game has closed.
    if (msg.type === 'mod_diagnostics')  try { diagnostics.recordModDiagnostics(msg); } catch { /* diagnostic only */ }
    if (msg.type === 'luma_diagnostics') try { diagnostics.recordLumaDiagnostics(msg); } catch { /* diagnostic only */ }
    if (msg.type === 'auth_request')             handleAuthRequest();
    if (msg.type === 'list_recordings_request')  handleListRecordings();
    if (msg.type === 'browse_directory_request') handleBrowseDirectory(msg);
    if (msg.type === 'friend_action')            mainWindow?.webContents.send('social:friend-action', msg);
    if (msg.type === 'own_presence_change') {
      // One line per change: the measured record that the mod's status tap
      // reached the desktop at all (the rest of the trail is renderer logs).
      logInfo('[social] own_presence_change from mod:',
        msg.status ?? '(no status)', 'share_room_code:', msg.share_room_code ?? '(unchanged)');
      mainWindow?.webContents.send('social:own-presence-change', msg);
    }
    // Luma Looks in-game keybind → bring the desktop controller to the front and tell the renderer
    // to focus the Luma panel. NOTE: do NOT call revealMainWindow() here — it does an unconditional
    // tray.destroy(), which throws when the window is already visible (tray only exists while hidden),
    // killing the handler before it focuses anything. A plain restore/show/focus works in every state.
    // Setup tiles. The mod has sent this since the tiles shipped and NOTHING
    // on the desktop listened, so tapping a tile in game played its sound,
    // logged a line, and then did nothing at all - the one exception being
    // RECORDING, which separately pokes the paid OBS assembly in game.
    //
    // Same reveal approach as luma_open below: restore/show/focus rather than
    // revealMainWindow(), whose unconditional tray.destroy() throws when the
    // window is already visible and would kill the handler before it focuses.
    if (msg.type === 'setup_tile') {
      try {
        const tile = String(msg.tile || '');
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          // ALL FOUR tiles navigate, as of 2026-08-15.
          //
          // This used to map only mods and friends, on the reasoning that
          // 'profile' and 'recording' had "no route of their own" and that
          // guessing one would take the user somewhere they did not ask for.
          // The cost of that caution was higher than it looked: since the
          // in-VR expand pages were removed on 2026-08-08, a tap IS this
          // handler, so a tile missing from this map does nothing anywhere.
          // A tester tapped 'profile' seven times and 'recording' three times
          // in one session, which is what someone does to a dead button.
          //
          // Neither destination is a guess. Both are where that tile's
          // subject actually lives in the app today:
          //   profile   -> FriendsView, the only host of EditProfileModal
          //   recording -> ProfilesView (the 'mods' route), the only host of
          //                the in-game feature-config panels, which is where
          //                the Pro+ recording stack is configured
          // If either subject ever moves, this map moves with it.
          const ROUTE_FOR_TILE = {
            mods: 'mods', friends: 'friends', profile: 'friends', recording: 'mods',
          };
          const route = ROUTE_FOR_TILE[tile];
          if (route) mainWindow.webContents.send('app:navigate', { route, from: 'setup_tile' });
        }
        logInfo('[setup-tiles] tile tapped in game:', tile || '(unnamed)');
      } catch (e) { logError('[setup-tiles] handler failed:', e && e.message); }
    }
    // Switch an installed mod on or off from the pre-game MODS tile.
    //
    // Resolved by NAME against a fresh scan rather than by a path the mod sent,
    // for two reasons: no absolute path (and therefore no Windows username) has
    // to cross the bridge, and the mod's list may be seconds stale while the
    // truth on disk is whatever scanMods says right now.
    //
    // A name that matches nothing, or matches more than one entry, is REFUSED
    // and logged. Guessing which of two same-named mods was meant would move a
    // file the player did not point at, and mods are not cheap to put back.
    if (msg.type === 'mod_toggle') {
      try {
        const want = msg.enabled === true;
        const name = String(msg.name || '').trim();
        const c = loadConfig();
        if (!name || !c.gamePath) { logError('[setup-tiles] mod_toggle: no name or no game path'); return; }
        const scan = scanMods(c.gamePath);
        const hits = (scan.mods || []).filter((m) => !m.isDataFolder
          && String(m.displayName || m.baseName || m.fileName || '').trim() === name);
        if (hits.length !== 1) {
          logError(`[setup-tiles] mod_toggle refused: '${name}' matched ${hits.length} mods`);
          sendInstalledMods();   // re-sync so the tile stops showing a state we did not apply
          return;
        }
        toggleMod(hits[0].path, want);
        logInfo(`[setup-tiles] mod '${name}' -> ${want ? 'ON' : 'OFF'} (takes effect next launch)`);
      } catch (e) {
        logError('[setup-tiles] mod_toggle failed:', e && e.message);
      }
      // Always re-push, success or failure: the tile paints optimistically and
      // this is what corrects it when the move was refused.
      sendInstalledMods();
    }
    // Step the active profile/modpack from the pre-game MODS tile.
    //
    // A DIRECTION, not a name: the mod already has the ordered shelf from
    // profile_info, but the desktop owns which one is live and applyProfile
    // carries the Standard-Profile invariants. Sending "next" lets the desktop
    // stay the only thing that decides what "next" resolves to.
    if (msg.type === 'profile_switch') {
      try {
        const dir = Number(msg.dir) >= 0 ? 1 : -1;
        const c = loadConfig();
        const all = (listProfiles() || []).filter((p) => p && p.id);
        if (all.length < 2) { logInfo('[setup-tiles] profile_switch: fewer than 2 profiles, nothing to step'); return; }
        // No active profile means the Standard loadout, which sits before the
        // first entry - so stepping forward from it lands on all[0].
        const cur = all.findIndex((p) => p.id === c.activeProfileId);
        const next = cur < 0
          ? (dir > 0 ? 0 : all.length - 1)
          : ((cur + dir) % all.length + all.length) % all.length;
        applyProfile(all[next].id);
        logInfo(`[setup-tiles] profile -> '${all[next].name}' (${dir > 0 ? 'next' : 'prev'})`);
      } catch (e) {
        logError('[setup-tiles] profile_switch failed:', e && e.message);
      }
      // Re-push both: switching a profile changes which mods are enabled, so
      // the mod list on the tile is stale the moment the profile lands.
      try { handleModHello(); } catch { /* best-effort */ }
    }
    if (msg.type === 'luma_open') {
      // Open (or focus) the DEDICATED gold/black Luma controller window — not the main app. It forces
      // itself in front of the focused game via alwaysOnTop (see electron/luma-window.cjs).
      try {
        logInfo('[luma] luma_open received — opening the Luma Looks window');
        lumaWindow.openLumaWindow();
      } catch (e) { logError('[luma] open window failed:', e && e.message); }
    }
    // Wristband "VIEW IN EXCALIBUR": the renderer opens the profile card
    // (see src/App.jsx); main's only job is making the window seen. Same
    // restore/show/focus dance as luma_open, and NOT revealMainWindow(),
    // for the tray.destroy() reason documented above.
    if (msg.type === 'open_profile') {
      try {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      } catch (e) { logError('[social] open_profile focus failed:', e && e.message); }
    }
  });
  registerGtmpFileAssociation();
  registerProtocolHandler();
  try { applyLoginItemSettings(loadConfig()); } catch { /* startup entry sync is best-effort */ }
  createWindow();
  // Auto-updater wires into the GitHub Releases feed configured in
  // package.json under build.publish. Dev runs short-circuit inside
  // updater.init - no network calls until the app is packaged.
  //
  // The saved policy ('ask' | 'auto') is handed over at init so the very first
  // check already obeys it. Without this the module default would apply for the
  // first few seconds, which on a fresh launch is exactly when a check runs.
  updater.init({
    logger: { info: logInfo, warn: logInfo, error: logError, debug: () => {} },
    policy: (() => { try { return loadConfig().updatePolicy; } catch { return 'ask'; } })(),
  });
  updater.setMainWindow(mainWindow);
  // The update CHANNEL comes from the verified JWT, not from a setting, so it
  // has to be pushed in once the token has been read. No check runs until this
  // happens (or until the updater's own auth timeout fires), because checking
  // early would show a tester the stable build and then correct itself with a
  // second, different prompt seconds later.
  syncUpdaterChannel();

  // Restore GT's display settings on startup if needed (only while the game is
  // not running - Unity rewrites these keys on game exit). Both paths are
  // no-ops when GT is already at its defaults.
  try {
    if (!isGorillaTagRunning()) {
      const cfg = loadConfig();
      if (!cfg.displayLeakHealed) {
        // One-time self-heal: users updating from a version that leaked GT's
        // display settings (before this restore logic existed) get fixed once,
        // just by launching the new Excalibur - no action required from them.
        gtDisplay.restoreGorillaTagDisplayDefaults();
        const fresh = loadConfig();
        fresh.displayLeakHealed = true;
        fresh.pendingDisplayRestore = false;
        saveConfig(fresh);
      } else {
        // Normal safety net: a prior session flagged a restore but Excalibur
        // closed before the game exited.
        maybeRestoreGtDisplay();
      }
      // Clean up a patcher left on disk by an unclean prior exit (crash), so a
      // plain Steam launch loads nothing Excalibur until the user next launches
      // through Excalibur. Only when the game isn't currently running.
      removeIdlePatcher();
    }
  } catch { /* non-fatal */ }

  // Poll game state every 5 s to pause/resume the client Discord presence.
  // When the game is running the mod's own RPC takes over (same app ID),
  // so we clear our activity to avoid fighting over who shows last.
  let gameWasRunning = false;
  setInterval(async () => {
    try {
      // Async + cache-shared with the renderer's own poll (steam.cjs). This
      // used to be the synchronous probe, which stalled the whole main process
      // - and therefore every renderer IPC call - twelve times a minute.
      const running = await getGorillaTagRunning();
      if (running && !gameWasRunning) {
        discordPresence.pause();
        // The grace is deliberately NOT cleared here any more. "The process
        // exists" is not "the launch succeeded": on a slow HDD the game can
        // appear, chew on its 2-minute load, and die - and clearing the grace
        // at first sight meant that crash immediately stripped the patcher, so
        // the user's natural relaunch-from-Steam came up completely vanilla.
        // The grace now ends when the MOD says hello (see handleModHello), or
        // at its own expiry for a launch that never got there.
      }
      if (!running && gameWasRunning) {
        discordPresence.resume();
        // Game just closed - undo any -screen-* leak so plain Steam launches
        // stay borderless-fullscreen. No-op unless we flagged a restore.
        maybeRestoreGtDisplay();
        // Strip the patcher back off disk now that the session is over, so a
        // subsequent plain Steam launch loads nothing Excalibur. The file is
        // unlocked now that the game process is gone.
        removeIdlePatcher();
      }
      gameWasRunning = running;
    } catch { /* non-fatal */ }
  }, 5000);

  // ── Keep the 7-day token alive for tray-resident installs ────────────────
  //
  // renew() used to run exactly once, from the renderer's boot effect. An app
  // left running in the tray (the normal way people use it) sailed past day 7
  // with no re-arm anywhere: the UI still looked signed in, but getToken()
  // started returning null, and every game launch from then on was silently
  // free-only AND unauthenticated in-game. Renewing on a timer means a running
  // app can never age out. Failure is renew()'s documented no-op - offline
  // ticks keep the current token and the next tick tries again.
  setInterval(() => {
    try {
      auth.renew()
        .then((r) => { if (r) logInfo('[auth] background token renewal ok'); })
        .catch(() => { /* keep the token we have; next tick retries */ });
    } catch { /* never let a timer tick throw */ }
  }, 12 * 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Make .gtmp files open with Excalibur and show our custom icon in Explorer.
// We write per-user registry entries (HKCU) so no admin is required, and
// copy the icon out of the asar bundle to a stable path since Windows'
// shell icon resolver can't read from inside the packaged archive.
function registerGtmpFileAssociation() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const bundledIcon = path.join(__dirname, '..', 'dist', 'gtmp-icon.ico');
    if (!fs.existsSync(bundledIcon)) return;
    const stableIcon = path.join(app.getPath('userData'), 'gtmp-icon.ico');
    fs.copyFileSync(bundledIcon, stableIcon);

    const exePath = app.getPath('exe');
    const progId = 'Excalibur.gtmp';
    const entries = [
      ['HKCU\\Software\\Classes\\.gtmp', progId],
      [`HKCU\\Software\\Classes\\${progId}`, 'Excalibur Mod Pack'],
      [`HKCU\\Software\\Classes\\${progId}\\DefaultIcon`, stableIcon],
      [`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, `"${exePath}" "%1"`],
    ];
    for (const [key, value] of entries) {
      // Fire-and-forget - we don't need to block app startup on reg.exe.
      execFile('reg.exe', ['add', key, '/ve', '/d', value, '/f'], () => {});
    }
    logInfo(`Registered .gtmp association with icon ${stableIcon}`);
  } catch (e) {
    logError('Failed to register .gtmp association:', e);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Fires on every quit path (force-quit IPC, Alt+F4, Cmd+Q, window close).
// We delay the actual quit briefly so the Discord `clearActivity` IPC
// write has time to reach Discord before the socket closes - otherwise
// the user's profile keeps showing "Excalibur · Managing mods" until
// Discord's next heartbeat notices we've disappeared.
app.on('before-quit', (e) => {
  // A doomed second instance (lost the single-instance lock) owns no
  // window, no bridge and no deployed patcher — running this cleanup from
  // it would rip the patcher out from under the REAL app's session.
  if (!gotInstanceLock) return;
  logInfo(`[shutdown] before-quit: running cleanup (pid ${process.pid}, lock=${gotInstanceLock})`);
  // A SECOND quit must be prevented too, not waved through.
  //
  // Closing the window fires app.quit() from the 'closed' handler, and then
  // 'window-all-closed' fires it again a millisecond later. This used to
  // `return` on the second one without calling preventDefault, so Electron went
  // ahead with a graceful shutdown - which tears down the JS timers, including
  // the app.exit(0) armed below. Electron then waited on handles that never
  // closed (the bridge's TCP server, the Discord RPC socket) and the process
  // simply hung: window gone, no tray, still in Task Manager.
  //
  // Measured on the real app, not reasoned about. The log showed
  // "exit timer armed" followed by the second before-quit, and "exiting now"
  // never arriving. Holding the quit here keeps the timer alive, and the timer
  // is what actually ends the process.
  if (_quitCleanupStarted) { e.preventDefault(); return; }
  _quitCleanupStarted = true;
  e.preventDefault();
  try { discordPresence.destroy(); } catch { /* already destroyed */ }
  try { tierOverlay.destroy();    } catch { /* already destroyed */ }
  try { tray.destroy();           } catch { /* never created */ }
  // Tell the media agent to restore the Spotify mixer level it changed and
  // exit. Without this, a wristband mute persists in the Windows mixer after
  // the app is gone - Windows remembers per-app levels forever.
  try { media.stop();             } catch { /* agent never started */ }
  // Same reason as media.stop(): the notification listener is a powershell
  // child, and it was only ever stopped on a config change. Left running it
  // holds a handle on its own script inside the install folder, which is one
  // of the ways an uninstall can be left with a directory it cannot remove.
  try { notificationMirror.stop(); } catch { /* never started */ }
  // Strip the patcher on the way out so a plain Steam launch after Excalibur is
  // closed loads nothing Excalibur. Best-effort: if the game is still running it
  // stays locked and the next app-start cleanup (or game-close poll) handles it.
  try { modPayload.removePatcher(lastPatcherTarget || loadConfig().gamePath); } catch { /* non-fatal */ }
  // Three ways out, in order, because the first two DO NOT RELIABLY WORK
  // here. Measured on the real app, from its own log:
  //
  //   [shutdown] exiting now (pid 33200)
  //   [shutdown] app.exit(0) RETURNED without exiting - forcing process.exit
  //   ...and pid 33200 was still in Task Manager 12 seconds later.
  //
  // app.exit() returned instead of terminating, and process.exit() did
  // nothing either - both block in native code on the way out (the Sentry
  // main-process SDK and its crashpad handler are the prime suspects; the
  // crashpad child is the one thing that always outlived the parent).
  // process.kill(self) is TerminateProcess on Windows, which no atexit
  // handler, native thread or flush can refuse.
  //
  // Each line only runs if the one before it failed to end the process, so
  // a healthy shutdown still takes the clean path and never reaches the
  // kill.
  setTimeout(() => {
    logInfo(`[shutdown] exiting now (pid ${process.pid})`);
    try { app.exit(0); } catch (e) { logError('[shutdown] app.exit threw:', e); }
    try { process.exit(0); } catch (e) { logError('[shutdown] process.exit threw:', e); }
    logInfo('[shutdown] graceful exits did not terminate - terminating hard');
    try { process.kill(process.pid, 'SIGKILL'); } catch (e) { logError('[shutdown] SIGKILL threw:', e); }
  }, 300);
});

// ---------- IPC handlers ----------
// Each handler wraps its body in try/catch and returns a result envelope
// { ok, data?, error? } so the renderer can display friendly errors without
// special-casing thrown exceptions.

function ok(data) {
  return { ok: true, data };
}
function fail(err) {
  logError(err);
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

// Resolve a renderer-supplied path to something safe to hand shell.openPath,
// or null. shell.openPath on a FILE launches it with its default handler, so on
// Windows an `.exe`, `.bat`, `.cmd`, `.ps1` or `.lnk` simply runs - which turns
// any renderer compromise into local code execution. `fs.existsSync` was the
// only check on three of these handlers and it is not a type check.
function openableDir(p) {
  if (typeof p !== 'string' || !p) return null;
  try { return fs.statSync(p).isDirectory() ? p : null; } catch { return null; }
}

// ── Safe outbound fetch for user-supplied URLs ──────────────────────────────
//
// "Install from a link" takes an arbitrary URL from the user, so an allowlist is
// the wrong shape (the bundled catalog already points at a non-GitHub host). But
// the request was previously issued with `redirect: 'follow'` and no other
// checks at all, which made it a blind-SSRF primitive: http://127.0.0.1:52137 is
// the mod bridge, :52139 is the OAuth loopback, 169.254.169.254 is cloud
// metadata, and every RFC1918 address is someone's router admin page. Following
// redirects blind meant an attacker-controlled https origin could 302 into any
// of those, and the fetch was already made before anyone could object.
//
// So: resolve the host, refuse anything that is not a public address, follow
// redirects MANUALLY re-checking each hop, and put a deadline on the whole
// thing. DNS is resolved explicitly rather than trusted by name, which is what
// closes the rebinding case.
const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];
function isPrivateAddress(addr) {
  if (!addr) return true;
  const a = String(addr).toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::1' || a === '::' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd')) return true;
  // ::ffff:127.0.0.1 style
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : a;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return PRIVATE_V4.some((re) => re.test(v4));
  return false;
}

async function assertPublicHost(urlStr) {
  const u = new URL(urlStr);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links can be installed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.localhost)$/i.test(host)) throw new Error('That link points at this computer.');
  const dns = require('dns').promises;
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('That link\'s address could not be resolved.');
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error('That link points at a private or local address, so it was not fetched.');
  }
}

// Fetch with a deadline, a redirect cap, a per-hop host check, and a
// Content-Length pre-check so a huge body is refused BEFORE it is buffered.
// arrayBuffer() used to run first and the size check second, so a hostile
// Content-Length-less response could OOM the main process before anyone looked.
async function safeFetchBinary(startUrl, { maxBytes, timeoutMs = 60_000, maxRedirects = 5 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  let url = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, { redirect: 'manual', signal: deadline });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Download failed (HTTP ${res.status} with no destination).`);
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error('That file is too large.');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('That file is too large.');
    return { buf, res, finalUrl: url };
  }
  throw new Error('That link redirected too many times.');
}

ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});
ipcMain.handle('window:close', () => {
  // Closing animation removed - close immediately. The renderer no
  // longer listens for app:will-close; main-process side stays as a
  // direct close.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});
ipcMain.handle('window:force-quit', () => {
  // Explicit "quit the app", so it bypasses close-to-tray.
  quitForReal();
});

// Tell the updater which release channel this person is on.
//
// Testers and developers ride the tester channel, everyone else the stable one,
// and the signal is the RS256 JWT that auth.cjs has already signature-verified.
// Deliberately NOT a setting: a config file is trivially editable, and "am I
// allowed to receive untested builds" is not a question the client gets to
// answer for itself.
//
// Called on startup, after login, and after logout. Each one genuinely changes
// the answer: signing in can promote someone onto the tester channel, and
// signing out demotes them (though never onto an older build - the updater sets
// allowDowngrade false, so someone left ahead of stable simply stays there).
function syncUpdaterChannel() {
  try {
    const status = auth.getStatus();
    updater.setChannelFromAuth(status?.authenticated ? status.user : null);
  } catch (e) {
    // A failure to read the token must not stop updates entirely. Falling back
    // to the stable channel is the safe wrong answer: at worst a tester gets
    // tester builds one launch late, rather than nobody getting anything.
    logError('updater channel sync failed, defaulting to stable:', e?.message || e);
    try { updater.setChannelFromAuth(null); } catch { /* updater not up yet */ }
  }
}

ipcMain.handle('auth:status', () => {
  try { return ok(auth.getStatus()); } catch (e) { return fail(e); }
});

ipcMain.handle('auth:login', async () => {
  try {
    const result = await auth.login();
    // If Gorilla Tag is already running, push the fresh JWT to the mod
    // immediately. The mod only ASKS for auth once (on bridge connect), so a
    // login that happens after the game booted would otherwise leave every
    // in-game feature locked until a game restart.
    try { if (bridge.isConnected) handleAuthRequest(); } catch { /* best effort */ }
    // Signing in can move someone onto the tester channel, so re-resolve it and
    // re-check. Without this a newly-signed-in tester would keep watching the
    // stable feed until the next app launch.
    syncUpdaterChannel();
    return ok(result);
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
});

// Renew the stored token so the app sees CURRENT standing (chiefly: a tier
// bought since sign-in) and gets another 7 days. Called by the renderer at
// startup. Never throws at the caller: a failed renewal leaves the existing
// token untouched, which is why the renderer can fire this without a fallback.
ipcMain.handle('auth:renew', async () => {
  try {
    const result = await auth.renew();
    if (!result || result.rejected) return ok(result);
    // Same reasoning as auth:login. The mod asks for auth exactly once, on
    // bridge connect, so a renewal that lands while Gorilla Tag is already
    // running must be pushed - otherwise someone who upgrades mid-session keeps
    // the free assemblies until they restart the game.
    try { if (bridge.isConnected) handleAuthRequest(); } catch { /* best effort */ }
    // A renewal can flip is_tester (a grade granted since sign-in), which
    // decides which release channel this install watches.
    syncUpdaterChannel();
    return ok(result);
  } catch (e) { return fail(e); }
});

ipcMain.handle('auth:logout', () => {
  try {
    auth.logout();
    // Drop the paid assemblies held in memory for the account that just left.
    // They are keyed by token so a new sign-in could not have used them anyway,
    // but leaving another account's Pro bytes sitting in this process after they
    // signed out is the kind of thing that is only ever explained afterwards.
    try { modPayload.clearTierCache(); } catch { /* best effort */ }
    // Mirror of the login push: lock the running mod right away.
    try { if (bridge.isConnected) handleAuthRequest(); } catch { /* best effort */ }
    // A signed-out app is not a tester, so drop back to the stable channel.
    syncUpdaterChannel();
    return ok(true);
  } catch (e) { return fail(e); }
});

// Called by the bridge when the mod requests auth - sends the stored JWT
// back to the mod so it can verify independently.
ipcMain.handle('auth:get-token', () => {
  try { return ok(auth.getToken()); } catch (e) { return fail(e); }
});

// Discord friends list captured at OAuth time. Empty when the
// relationships.read scope wasn't granted by Discord (unverified app).
ipcMain.handle('auth:get-discord-friends', () => {
  try { return ok(auth.getDiscordFriends()); } catch (e) { return fail(e); }
});

// GitHub creator verification: runs the OAuth flow (main-process localhost
// callback server) then the API repo-ownership check. Uses the signed-in
// user's JWT so the API knows who is claiming. Returns the API's
// { ok, filed, github_login, hash_state, message } straight through. `repo` is the
// repository the claimant names as holding the mod; `note` is optional free-text
// context. Both end up on the claim a reviewer sees.
ipcMain.handle('github:verify-creator', async (_e, modId, note, repo) => {
  const token = auth.getToken();
  if (!token) return { ok: false, error: 'not_authenticated' };
  try {
    return await githubVerify.verifyGithub(modId, token, note, repo);
  } catch (e) {
    return { ok: false, error: e.code || 'failed', message: e.message };
  }
});

// Renderer fires this when the theme toggles so the Windows-drawn
// titleBarOverlay glyphs (minimize / maximize / close) stay legible
// against the new background. `light: true` paints the buttons dark
// on light; otherwise light glyphs on dark.
ipcMain.handle('window:set-overlay-theme', (_e, { light } = {}) => {
  try {
    if (!mainWindow) return ok(false);
    mainWindow.setTitleBarOverlay?.({
      color:       light ? '#f5f5f7' : '#0a0a0c',
      symbolColor: light ? '#1f2937' : '#e5e7eb',
    });
    return ok(true);
  } catch (e) { return fail(e); }
});
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

// DWM compositor material - the only way to get a real desktop-blur
// behind an Electron window on Windows. CSS backdrop-filter can't reach
// outside the renderer, so the renderer calls this whenever the
// background theme changes. Valid values: 'none' | 'auto' | 'mica' |
// 'acrylic' | 'tabbed'. Silently no-ops off-Windows or on older builds
// that don't support the API.
ipcMain.handle('window:set-background-material', (_e, material) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  try {
    if (typeof mainWindow.setBackgroundMaterial === 'function') {
      mainWindow.setBackgroundMaterial(material || 'none');
      return { ok: true };
    }
    return { ok: false, error: 'setBackgroundMaterial unavailable' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// Mirror the main window's console into the app log. Without this the
// entire renderer (social/friends/messages, all of Supabase) fails
// silently as far as any log is concerned.
function attachRendererConsole(win) {
  try {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      // 0=verbose 1=info 2=warning 3=error - only surface warn/error, and
      // anything the social layer deliberately tags.
      const social = /social|friend|supabase|messages|presence/i.test(String(message));
      if (level < 2 && !social) return;
      const src = String(sourceId || '').split('/').pop();
      const line1 = `[renderer:${level >= 3 ? 'error' : 'warn'}] ${message} (${src}:${line})`;
      if (level >= 3) logError(line1); else logInfo(line1);
    });
  } catch (e) { logError('attachRendererConsole failed:', e.message); }
}

ipcMain.handle('config:get', () => {
  try {
    return ok(loadConfig());
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('config:set', (_e, patch) => {
  try {
    const current = loadConfig();
    const next = { ...current, ...patch };
    saveConfig(next);

    // If the user flipped Preview-Tier-As (or any change that could
    // affect it), push a live override message to the mod so the in-VR
    // wristband / setup tiles / etc. re-evaluate without a GT restart.
    // pushDevTierOverride is a no-op when (a) the user isn't dev/tester
    // per JWT, or (b) the mod isn't currently connected.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'devPreviewTier')) {
      try { pushDevTierOverride(); } catch (e) { logError('pushDevTierOverride failed:', e); }
    }

    // Keep the Windows startup entry in sync when either toggle changes.
    if (patch && (Object.prototype.hasOwnProperty.call(patch, 'launchOnStartup') || Object.prototype.hasOwnProperty.call(patch, 'startMinimized'))) {
      applyLoginItemSettings(next);
    }

    // Start/stop the notification listener when its feature toggle or
    // allow-list changes. An empty allow-list means nothing would ever be
    // mirrored, so there's no point keeping the listener process running.
    if (patch && (Object.prototype.hasOwnProperty.call(patch, 'features') || Object.prototype.hasOwnProperty.call(patch, 'notificationMirrorApps'))) {
      const apps = next.notificationMirrorApps || [];
      notificationMirror.setAllowedApps(apps);
      if (next.features?.['notification-mirror'] && apps.length > 0) notificationMirror.ensureRunning();
      else notificationMirror.stop();
    }

    return ok(next);
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('steam:detect', () => {
  try {
    const result = detectGorillaTagPath();
    return ok(result);
  } catch (e) {
    return fail(e);
  }
});

// On-demand "find my Gorilla Tag" scan: every GT folder across all Steam
// libraries/drives, best-first, so the user can pick the right one.
ipcMain.handle('steam:list-gt-folders', () => {
  try {
    return ok(detectAllGorillaTagFolders());
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('dialog:pick-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Gorilla Tag install folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return ok(null);
    return ok(result.filePaths[0]);
  } catch (e) {
    return fail(e);
  }
});

// Multi-select mod-file picker. Opens the native OS file picker with
// a .dll / .zip filter and returns the picked absolute paths so the
// caller can hand them straight to mods:install. Cancels return ok([]).
ipcMain.handle('dialog:pick-mod-files', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Pick mod files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Mod files', extensions: ['dll', 'zip'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return ok([]);
    return ok(result.filePaths || []);
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('mods:scan', (_e, gamePath) => {
  try {
    // scanMods does not only READ - it repairs layout and normalises names on
    // disk. Every other handler that writes into the plugins folder refuses
    // while Gorilla Tag is running, because BepInEx has those files open and a
    // rename underneath a loaded assembly is how you corrupt an install. This
    // one mutated regardless, and it is called on every visit to the Mods page.
    if (isGorillaTagRunning()) {
      return { ok: false, error: 'Close Gorilla Tag before scanning mods.', code: 'GAME_RUNNING' };
    }
    return ok(scanMods(gamePath));
  } catch (e) {
    return fail(e);
  }
});

// Crash / "why didn't my mods load" diagnosis. The enabled-mod list is read
// HERE rather than accepted from the renderer: the whole point is to compare
// what is really on disk against what the loader really reported, and a
// renderer scan can be stale by exactly the change that broke the launch.
ipcMain.handle('diagnose:run', () => {
  try {
    const gamePath = loadConfig().gamePath || '';
    let enabledMods = [];
    try {
      const flatten = (list) => (list || []).flatMap((m) => (
        m.kind === 'folder' ? flatten(m.children) : (m.enabled ? [m.baseName] : [])
      ));
      enabledMods = flatten(scanMods(gamePath)?.mods);
    } catch { /* diagnose still works without the cross-reference */ }
    const r = crashDiagnose.diagnose({ gamePath, enabledMods });
    logInfo(`[diagnose] ${r?.data?.findings?.length ?? 0} finding(s): ${r?.data?.summary || ''}`);
    return r;
  } catch (e) {
    return fail(e);
  }
});

// ── Multi-file mod archives ────────────────────────────────────────────────
// Read a picked .zip in THIS process, using the same adm-zip that installs one -
// see the header of mod-archive-read.cjs for why a second parser in the renderer
// would be a security problem rather than a convenience. Nothing is written to
// disk: entries are enumerated, then drained one at a time so a large archive
// never crosses IPC in a single message.
const archiveReader = require('./mod-archive-read.cjs');
// The unpacked-size ceiling is enforced HERE, not taken on trust.
//
// `maxUnpacked` arrives from the renderer and went straight through, and
// readIndex only applies it when it is TRUTHY (`if (maxUnpacked && total > ...)`)
// - so 0, null, undefined or a missing key disabled the check entirely, and any
// number at all raised it. A zip bomb is decompressed in the MAIN process, so
// the ceiling that matters is the one main insists on.
//
// The renderer's value still applies when it is STRICTER: that is the tier
// ceiling, and it exists so a Free user is told before they wait through an
// upload. This just stops it being used to remove a limit.
const ARCHIVE_HARD_MAX_UNPACKED = 2 * 1024 * 1024 * 1024; // 2 GiB, well past any legitimate mod
ipcMain.handle('mods:archive-index', (_e, { bytes, maxUnpacked }) => {
  try {
    const asked = Number(maxUnpacked);
    const ceiling = Number.isFinite(asked) && asked > 0
      ? Math.min(asked, ARCHIVE_HARD_MAX_UNPACKED)
      : ARCHIVE_HARD_MAX_UNPACKED;
    return ok(archiveReader.readIndex(bytes, { maxUnpacked: ceiling }));
  } catch (e) { return fail(e); }
});
ipcMain.handle('mods:archive-entry', (_e, { handle, entryPath }) => {
  try { return ok(archiveReader.readEntry(handle, entryPath)); } catch (e) { return fail(e); }
});
ipcMain.handle('mods:archive-release', (_e, { handle }) => {
  try { return ok(archiveReader.release(handle)); } catch (e) { return fail(e); }
});

ipcMain.handle('mods:toggle', (_e, { modPath, enable }) => {
  try {
    if (isGorillaTagRunning()) {
      return {
        ok: false,
        error: 'Gorilla Tag is currently running. Close it before toggling mods.',
        code: 'GAME_RUNNING',
      };
    }
    return ok(toggleMod(modPath, enable));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('mods:install', (_e, { gamePath, targetPath, sourcePaths }) => {
  try {
    if (isGorillaTagRunning()) {
      return {
        ok: false,
        error: 'Gorilla Tag is currently running. Close it before installing mods.',
        code: 'GAME_RUNNING',
      };
    }
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
      return { ok: false, error: 'No files to install' };
    }
    return ok(installMods(gamePath, targetPath, sourcePaths));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('mods:set-all', (_e, { gamePath, enable, baseNames = null }) => {
  try {
    if (isGorillaTagRunning()) {
      return {
        ok: false,
        error: 'Gorilla Tag is currently running. Close it before toggling mods.',
        code: 'GAME_RUNNING',
      };
    }
    return ok(setAllMods(gamePath, enable, Array.isArray(baseNames) ? baseNames : null));
  } catch (e) {
    return fail(e);
  }
});

// ── Folder-aware operations: rename, move, createFolder, suggest ──────
// Same game-running gate as toggle/install since each is a file-system
// mutation that BepInEx can be holding a handle to.

ipcMain.handle('mods:rename', (_e, { modPath, newName }) => {
  try {
    if (isGorillaTagRunning()) {
      return { ok: false, error: 'Gorilla Tag is currently running. Close it before renaming mods.', code: 'GAME_RUNNING' };
    }
    return ok(renameMod(modPath, newName));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('mods:move', (_e, { modPath, destDir }) => {
  try {
    if (isGorillaTagRunning()) {
      return { ok: false, error: 'Gorilla Tag is currently running. Close it before moving mods.', code: 'GAME_RUNNING' };
    }
    return ok(moveMod(modPath, destDir));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('mods:create-folder', (_e, { gamePath, parentDir, folderName }) => {
  try {
    if (isGorillaTagRunning()) {
      return { ok: false, error: 'Gorilla Tag is currently running. Close it before creating folders.', code: 'GAME_RUNNING' };
    }
    return ok(createFolder(gamePath, parentDir, folderName));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('mods:delete', (_e, { modPath }) => {
  try {
    if (isGorillaTagRunning()) {
      logInfo('mods:delete refused - game running:', modPath);
      return { ok: false, error: 'Gorilla Tag is currently running. Close it before deleting mods.', code: 'GAME_RUNNING' };
    }
    const r = deleteMod(modPath);
    logInfo('mods:delete', modPath, '->', JSON.stringify(r));
    return ok(r);
  } catch (e) {
    logError('mods:delete failed:', modPath, e.message);
    return fail(e);
  }
});

// Reveal a mod (or folder) in the OS file explorer. Read-only, so no
// game-running gate. showItemInFolder highlights the item in its parent.
ipcMain.handle('mods:reveal', (_e, { modPath }) => {
  try {
    shell.showItemInFolder(modPath);
    return ok(true);
  } catch (e) {
    return fail(e);
  }
});

// ─── Transfer mods between Gorilla Tag installs ───────────────────────────
// Users often end up with mods stranded in a Gorilla Tag folder that isn't the
// one the game actually launches from (a moved/duplicated Steam library). These
// two handlers let them see those mods and pull them into the current install.

// Walk a plugins dir and return every .dll with its path RELATIVE to that dir,
// so we can recreate the same layout on the receiving side (mods that ship
// their dependencies live in a subfolder and must stay together).
function listPluginDlls(pluginsDir) {
  const out = [];
  if (!fs.existsSync(pluginsDir)) return out;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (/\.dll$/i.test(ent.name)) {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* ignore */ }
        out.push({ name: ent.name, rel: path.relative(pluginsDir, abs), size });
      }
    }
  };
  walk(pluginsDir);
  return out;
}

// List mods sitting in OTHER Gorilla Tag folders (i.e. not the selected one).
ipcMain.handle('mods:external-list', () => {
  try {
    const cfg = loadConfig();
    const current = cfg.gamePath ? path.resolve(cfg.gamePath).toLowerCase() : null;
    const folders = detectAllGorillaTagFolders()
      .filter((f) => !current || path.resolve(f.path).toLowerCase() !== current)
      .map((f) => ({
        path: f.path,
        hasExe: f.hasExe,
        mods: listPluginDlls(path.join(f.path, 'BepInEx', 'plugins')),
      }))
      .filter((f) => f.mods.length > 0);
    return ok(folders);
  } catch (e) {
    return fail(e);
  }
});

// Copy (or MOVE) the selected mods into the CURRENT install's plugins folder.
// `items`: [{ from: <source GT folder>, rel: <path relative to its plugins dir> }]
// `mode` : 'copy' (leave the originals alone) | 'move' (delete them afterwards)
// A mod inside a subfolder is taken as the WHOLE subfolder so its bundled
// dependencies come with it; a loose root .dll is taken on its own.
ipcMain.handle('mods:transfer', (_e, { items, mode = 'copy' } = {}) => {
  try {
    const cfg = loadConfig();
    if (!cfg.gamePath) return fail(new Error('No Gorilla Tag folder is selected.'));
    if (isGorillaTagRunning()) {
      return { ok: false, code: 'GAME_RUNNING', error: 'Close Gorilla Tag before transferring mods.' };
    }
    const move = mode === 'move';
    const destRoot = path.join(cfg.gamePath, 'BepInEx', 'plugins');
    fs.mkdirSync(destRoot, { recursive: true });

    const copyDir = (src, dst) => {
      fs.mkdirSync(dst, { recursive: true });
      for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, ent.name);
        const d = path.join(dst, ent.name);
        if (ent.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
      }
    };

    // Which dlls the user actually ticked, per source folder. A MOVE deletes the
    // whole source subfolder, so we have to know whether the tick list accounts
    // for everything in it - ticking ONE dll used to delete the lot, including
    // dlls the user never selected and never saw named.
    const pickedInDir = new Map();   // "from|relDir" -> Set(lowercased filenames)
    for (const it of items || []) {
      if (!it?.from || !it?.rel) continue;
      const d = path.dirname(it.rel);
      if (!d || d === '.') continue;
      const k = `${it.from}|${d}`.toLowerCase();
      if (!pickedInDir.has(k)) pickedInDir.set(k, new Set());
      pickedInDir.get(k).add(path.basename(it.rel).toLowerCase());
    }
    const dllsIn = (dir) => {
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.dll$/i.test(e.name)) out.push(e.name.toLowerCase());
        }
      };
      try { walk(dir); } catch { /* unreadable - treat as empty */ }
      return out;
    };

    const doneDirs = new Set();
    const copied = [];
    const refused = [];
    for (const it of items || []) {
      if (!it?.from || !it?.rel) continue;
      const srcRoot = path.join(it.from, 'BepInEx', 'plugins');
      const srcAbs = path.resolve(srcRoot, it.rel);
      // Containment guard: never let a crafted `rel` escape the plugins dir.
      if (!isInsideDir(srcRoot, srcAbs)) continue;
      if (!/\.dll$/i.test(srcAbs) || !fs.existsSync(srcAbs)) continue;

      const relDir = path.dirname(it.rel);
      if (relDir && relDir !== '.') {
        // Mod lives in its own folder - bring the folder (deps included), once.
        const key = `${it.from}|${relDir}`.toLowerCase();
        if (doneDirs.has(key)) continue;
        doneDirs.add(key);
        const destAbs = path.resolve(destRoot, relDir);
        if (!isInsideDir(destRoot, destAbs)) continue;
        const srcDir = path.resolve(srcRoot, relDir);
        // Never let a "move" eat the folder we just wrote to (same install).
        if (srcDir.toLowerCase() === destAbs.toLowerCase()) continue;

        // A MOVE may only delete a folder the user accounted for in full.
        // Copying the whole folder is right - a folder mod's libraries are part
        // of the mod - but DELETING dlls that were never ticked is not
        // something a transfer should decide on its own.
        if (move) {
          const present = dllsIn(srcDir);
          const picked = pickedInDir.get(key) || new Set();
          const missing = present.filter((n) => !picked.has(n));
          if (missing.length) {
            refused.push({
              unit: relDir,
              reason: `not all of its mods were selected (${missing.length} more: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''})`,
            });
            continue;
          }
        }
        copyDir(srcDir, destAbs);
        if (move) fs.rmSync(srcDir, { recursive: true, force: true });
        copied.push(relDir);
      } else {
        const destAbs = path.resolve(destRoot, path.basename(it.rel));
        if (!isInsideDir(destRoot, destAbs)) continue;
        if (srcAbs.toLowerCase() === destAbs.toLowerCase()) continue;
        fs.copyFileSync(srcAbs, destAbs);
        if (move) fs.rmSync(srcAbs, { force: true });
        copied.push(path.basename(it.rel));
      }
    }
    return ok({ copied, count: copied.length, moved: move, refused });
  } catch (e) {
    return fail(e);
  }
});

// Open the plugins folder itself in the file explorer.
ipcMain.handle('mods:open-plugins', (_e, gamePath) => {
  try {
    if (!gamePath) return ok(false);
    // Same rule as util:open-folder: only ever open a DIRECTORY. The fallback
    // branch took the raw renderer path, and shell.openPath on a file RUNS it
    // with its default handler - so `.exe`, `.bat`, `.cmd`, `.lnk` all execute.
    // `existsSync` is not a type check.
    const dir = getPluginsDir(gamePath);
    const target = openableDir(dir) || openableDir(gamePath);
    if (!target) return ok(false);
    shell.openPath(target);
    return ok(true);
  } catch (e) {
    return fail(e);
  }
});

// Install a mod straight from a URL (a GitHub release .dll link, etc). Downloads
// to a temp file, then hands it to the same installer drag-and-drop uses.
ipcMain.handle('mods:install-url', async (_e, { gamePath, url }) => {
  try {
    if (isGorillaTagRunning()) {
      return { ok: false, error: 'Close Gorilla Tag before installing mods.', code: 'GAME_RUNNING' };
    }
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'Enter a valid http(s) link.' };
    const MAX = 60 * 1024 * 1024;
    let buf, res, finalUrl;
    try {
      ({ buf, res, finalUrl } = await safeFetchBinary(url, { maxBytes: MAX }));
    } catch (e) {
      // A timeout aborts as an AbortError; say something a human can act on
      // rather than surfacing the raw name.
      const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? 'That download took too long and was stopped.'
        : (e?.message || 'Download failed.');
      return { ok: false, error: msg };
    }
    // Name from the FINAL url after redirects, not the one that was typed - a
    // /releases/latest/download/... link resolves to the real asset name.
    let name = decodeURIComponent((finalUrl.split('?')[0].split('#')[0].split('/').pop()) || 'mod.dll');
    if (!/\.dll$/i.test(name)) {
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
      if (m) name = decodeURIComponent(m[1].replace(/"/g, ''));
    }
    if (!/\.dll$/i.test(name)) return { ok: false, error: 'That link is not a .dll mod file.' };

    // Stage in a temp DIRECTORY under the mod's REAL filename.
    //
    // This used to write to `<tmp>/excalibur-dl-<ts>-<Name>.dll`, and installMods
    // names its destination `path.basename(src)` - so the file that landed in
    // plugins/ kept the TEMP name. Two things then went wrong at once:
    //
    //   * isManagerEntry is /^excalibur([-.]|$)/i and scanMods skips every match,
    //     so a file starting "excalibur-dl-" was filtered out of EVERY scan,
    //     permanently. The mod loaded in game and did not exist as far as the app
    //     was concerned: it could not be toggled, renamed, revealed, updated or
    //     deleted, and installing the same link twice left two timestamped copies
    //     both loading, neither visible.
    //   * addBasesToStandard recorded the mod under `name`, which never matched
    //     the name on disk, so the next scan's purgeMissingMembers stripped it
    //     back out of Standard again.
    //
    // A per-call directory keeps the real basename without risking a collision
    // in the shared temp dir.
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9._ ()-]/g, '_');
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excalibur-dl-'));
    const tmp = path.join(stageDir, safeName);
    let result;
    try {
      fs.writeFileSync(tmp, buf);
      result = installMods(gamePath, getPluginsDir(gamePath), [tmp]);
    } finally {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    // installMods returns an ARRAY of per-file results. `{ ...result, name }`
    // spread it into `{ '0': {...}, name }`, so the per-file `{ok:false, error}`
    // was never inspected and a failed install (locked file, game launched
    // mid-download) reported SUCCESS - and the renderer then wrote the mod into
    // Standard's membership. Report the one file's real outcome.
    const entry = Array.isArray(result) ? result[0] : null;
    if (!entry || entry.ok === false) {
      return { ok: false, error: entry?.error || 'Install failed.' };
    }
    // `entry.name` is the name that ended up ON DISK, which is what the caller
    // records as profile membership - it differs from `name` when installMods
    // had to avoid a collision.
    return ok({ ...entry, name: entry.name || safeName });
  } catch (e) {
    return fail(e);
  }
});

// Install a community-store mod in-app: fetch the server-signed URL and write it
// straight into BepInEx/plugins as <name>.dll. The URL is a short-lived signed
// link to a single .dll in the mod-files bucket (not necessarily ending in
// ".dll"), so we trust the caller's name rather than sniffing the URL. Returns
// the installed baseName so the renderer can add it to the chosen profiles.
ipcMain.handle('mods:install-community', async (_e, { gamePath, url, name, sha256 }) => {
  try {
    if (isGorillaTagRunning()) {
      return { ok: false, error: 'Close Gorilla Tag before installing mods.', code: 'GAME_RUNNING' };
    }
    if (!gamePath || !/^https?:\/\//i.test(String(url || ''))) return fail(new Error('Missing install info'));

    // Through safeFetchBinary, not a bare fetch. The URL arrives FROM THE
    // RENDERER, and the bare fetch had none of the protections the sibling
    // installer 100 lines up already uses:
    //   * no assertPublicHost, so this was an SSRF primitive - point it at
    //     127.0.0.1 or a LAN address and the main process fetches it for you
    //   * redirect: 'follow', so even a public first hop could bounce inward
    //   * no timeout, so a slow-loris link hung the handler forever
    //   * the size ceiling was checked AFTER arrayBuffer(), i.e. after the
    //     whole body was already resident in the main process
    const MAX_COMMUNITY_DLL = 60 * 1024 * 1024;
    let buf;
    try {
      ({ buf } = await safeFetchBinary(url, { maxBytes: MAX_COMMUNITY_DLL }));
    } catch (e) {
      const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? 'That download took too long and was stopped.'
        : (e?.message || 'Download failed.');
      return { ok: false, error: msg };
    }

    // The bytes must be the bytes that were scanned. The ARCHIVE installer
    // below already refuses on a hash mismatch - "Storage is content addressed,
    // so a mismatch means the object behind the hash is not what the record
    // says" - and this single-file path, which is the one most people use, had
    // no check at all. sha256 is optional only because older callers may not
    // send it; when it IS sent it is enforced.
    if (sha256) {
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== String(sha256).toLowerCase()) {
        logInfo(`[Community] Hash mismatch for ${name}: expected ${sha256}, got ${got}`);
        return { ok: false, error: 'That download did not match what was scanned, so nothing was installed.' };
      }
    }

    // Sanitize to a safe, readable bare-DLL filename.
    const base = String(name || 'Mod').replace(/\.dll$/i, '').replace(/[^\w.\-() +]/g, '_').trim().slice(0, 80) || 'Mod';
    const pluginsDir = getPluginsDir(gamePath);
    fs.mkdirSync(pluginsDir, { recursive: true });
    const dest = path.join(pluginsDir, `${base}.dll`);

    // Do not silently replace a different mod that happens to share a name.
    // The name comes from the community listing, so two unrelated uploads can
    // collide - and this wrote straight over whatever was there, including a
    // mod the user installed from the curated catalogue.
    if (fs.existsSync(dest)) {
      const existingHash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
      const incomingHash = crypto.createHash('sha256').update(buf).digest('hex');
      if (existingHash !== incomingHash) {
        return {
          ok: false, code: 'NAME_TAKEN',
          error: `A different mod called "${base}" is already installed. Remove it first if you meant to replace it.`,
        };
      }
      // Identical bytes: this is a reinstall, so let it through unchanged.
    }
    fs.writeFileSync(dest, buf);
    logInfo(`[Community] Installed ${base} → ${dest}`);
    return ok({ baseName: base, path: dest });
  } catch (e) {
    return fail(e);
  }
});

// Install a MULTI-FILE community mod.
//
// `files` comes from /api/mods/archive-files: one entry per file, each carrying
// the destination the SERVER computed and validated at upload time (through
// safeEntryPath + destinationFor) and a short-lived signed URL.
//
// Why this exists rather than reusing mods:install-community: that handler
// writes ONE bare .dll into plugins/. A multi-file mod given to it installs its
// primary file and none of its libraries, which does not fail - it produces a
// mod that reports installed and then silently never loads, because BepInEx
// cannot resolve an assembly that was never written.
//
// Three checks here that the server has already done. They are not redundant:
// the server proves what SHOULD be written, and this proves what IS written,
// and only this side is holding the player's game folder.
//
//   1. every destination is re-resolved and must stay inside the game folder
//   2. every file's sha256 must match what the list claimed
//   3. nothing is written until ALL of them have downloaded and verified
//
// (3) is the important one. A half-written mod is worse than a failed install:
// the plugin may be present without its libraries, which is the same silent
// non-loading state. So files are staged in memory and committed together.
ipcMain.handle('mods:install-archive', async (_e, { gamePath, files, name, id, primarySha }) => {
  try {
    if (isGorillaTagRunning()) {
      return { ok: false, error: 'Close Gorilla Tag before installing mods.', code: 'GAME_RUNNING' };
    }
    if (!gamePath || !Array.isArray(files) || !files.length) return fail(new Error('Missing install info'));
    if (files.length > 200) return { ok: false, error: 'That mod has too many files.' };

    const root = path.resolve(gamePath);
    const staged = [];
    let total = 0;

    for (const f of files) {
      const rel = String(f?.dest || '');
      if (!rel || /^[a-zA-Z]:/.test(rel) || /^[/\\]/.test(rel)) {
        return { ok: false, error: 'That mod contains an invalid file path.' };
      }
      // Resolve and confirm containment. path.resolve collapses any ".." that
      // survived, so this catches an escape even if the stored destination was
      // wrong - which is the whole point of checking it again here.
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        logInfo(`[Community] Refusing file outside the game folder: ${rel}`);
        return { ok: false, error: 'That mod tried to write outside the game folder and was not installed.' };
      }
      // Containment is necessary and NOT sufficient. It only proves the file
      // lands somewhere under the game folder, which still includes the game
      // root itself - so a destination like `BepInEx/plugins/M/../../../x.dll`
      // resolves back to the root and would drop a file next to the game
      // executable while passing every ".." check.
      //
      // destinationFor only ever produces a path under BepInEx/, so requiring it
      // here costs nothing and turns that into an invariant this side enforces
      // rather than one it assumes. The upload side proving something is not the
      // same as this side checking it, and only this side holds the game folder.
      const bepinRoot = path.resolve(root, 'BepInEx');
      if (!abs.startsWith(bepinRoot + path.sep)) {
        logInfo(`[Community] Refusing file outside BepInEx/: ${rel}`);
        return { ok: false, error: 'That mod tried to write outside the mods folder and was not installed.' };
      }
      if (!/^https?:\/\//i.test(String(f?.url || ''))) return { ok: false, error: 'Missing download link.' };

      // Same reasoning as the single-file installer above: these URLs come from
      // the renderer, so they go through the SSRF/redirect/timeout-checked path
      // and the per-file ceiling applies before the body is buffered rather
      // than after.
      const REMAINING = Math.max(0, 200 * 1024 * 1024 - total);
      let buf;
      try {
        ({ buf } = await safeFetchBinary(f.url, { maxBytes: REMAINING }));
      } catch (e) {
        const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? 'That download took too long and was stopped.'
          : (e?.message || 'Download failed.');
        return { ok: false, error: msg };
      }
      total += buf.length;
      if (total > 200 * 1024 * 1024) return { ok: false, error: 'That mod is too large to install.' };

      // The bytes must be the bytes that were scanned. Storage is content
      // addressed, so a mismatch means the object behind the hash is not what
      // the record says - refuse rather than write it.
      if (f.sha256) {
        const got = crypto.createHash('sha256').update(buf).digest('hex');
        if (got !== String(f.sha256).toLowerCase()) {
          logInfo(`[Community] Hash mismatch for ${rel}: expected ${f.sha256}, got ${got}`);
          return { ok: false, error: 'A file in that mod did not match its security record. Nothing was installed.' };
        }
      }
      staged.push({ abs, buf, rel });
    }

    // Commit. Everything downloaded and verified before this line.
    const written = [];
    for (const s of staged) {
      fs.mkdirSync(path.dirname(s.abs), { recursive: true });
      fs.writeFileSync(s.abs, s.buf);
      written.push(s.rel);
    }
    // A marker recording WHICH community mod this folder is.
    //
    // Without it the folder's identity is guessed by findPrimaryDll, which picks
    // `<FolderName>.dll` if it exists and otherwise the first .dll readdir
    // happens to return. For a mod called "Neon Grapples" (a space, so no
    // matching filename) that is `NeonCore.dll`; for one shipping 0Harmony it is
    // `0Harmony.dll`. The Mods page then hashes the wrong file and either fails
    // to identify the mod or attributes it to whatever else ships those bytes.
    //
    // The server already knows the answer, so it is recorded instead of
    // re-derived. Guessing is still the fallback for folders that predate this.
    try {
      const marker = {
        modId: id || null,
        title: name || null,
        primarySha256: primarySha || null,
        files: written,
        installedAt: new Date().toISOString(),
      };
      const folderAbs = staged.length ? path.dirname(staged[0].abs) : null;
      if (folderAbs && folderAbs.startsWith(path.resolve(root, 'BepInEx') + path.sep)) {
        fs.writeFileSync(path.join(folderAbs, '.excalibur-mod.json'), JSON.stringify(marker, null, 2));
      }
    } catch { /* identity falls back to the guess; not worth failing an install */ }

    // The folder the mod owns, so uninstall can remove all of it rather than one
    // file, and so the renderer knows which row to record as a profile member.
    //
    // Derived from the shared prefix of what was actually written, and it must
    // never resolve to a SHARED directory. `BepInEx/plugins` holds every other
    // mod on the machine; handing that back as "the folder this mod owns" would
    // invite a caller to treat the whole plugins tree as this mod's property.
    // The old code sidestepped that by returning null for a single-file archive,
    // which also blanked the answer for the legitimate one-file-in-its-own-folder
    // case (the renderer then had no membership key and silently skipped it).
    // Computing the prefix properly and rejecting the shared roots covers both.
    const SHARED_PREFIXES = new Set(['', 'bepinex', 'bepinex/plugins', 'bepinex/plugins_disabled']);
    const dirOf = (p) => String(p).split(/[/\\]/).slice(0, -1).join('/');
    let folder = written.length ? dirOf(written[0]) : '';
    for (const rel of written) {
      const d = dirOf(rel);
      // Walk back to the deepest directory every written file shares.
      while (folder && d !== folder && !d.startsWith(folder + '/')) folder = dirOf(folder);
    }
    if (SHARED_PREFIXES.has(String(folder).toLowerCase())) folder = null;
    logInfo(`[Community] Installed ${name || 'mod'}: ${written.length} file(s) under ${folder || 'plugins'}`);
    return ok({ files: written, folder, count: written.length });
  } catch (e) {
    return fail(e);
  }
});

// Registry similarity check used by the rename input. Read the static
// catalog from mods-registry.json via mod-downloader, run the typed
// name through the Levenshtein helper, return the closest match (or
// null). Pure read - no game-running gate.
ipcMain.handle('mods:suggest-registry-match', (_e, { typedName }) => {
  try {
    const downloader = require('./mod-downloader.cjs');
    const registry = downloader.loadRegistry();
    const bepMods = registry?.bepinex_mods || [];
    return ok(suggestRegistryMatch(typedName, bepMods));
  } catch (e) {
    return fail(e);
  }
});

// The renderer polls this every 4s forever. It MUST NOT be the synchronous
// probe: that spawned `tasklist` on the main thread and froze every other IPC
// handler behind it. The async path also shares its spawn with main.js's own
// 5s presence poll, so the pair costs one probe instead of two.
// See the long note above isGorillaTagRunning() in steam.cjs.
ipcMain.handle('game:is-running', async () => {
  try {
    return ok(await getGorillaTagRunning());
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('game:launch', async (_e, { mode, launchOptions } = {}) => {
  try {
    const id = launchOptions?.gtVersion || 'current';

    // Ensure the BepInEx patcher (the only on-disk bootstrap - in
    // BepInEx/patchers, NOT plugins) is deployed, deps/fonts are in the app data
    // dir, and no stale/pirated core DLL is anywhere, before the game starts.
    // No-op when BepInEx isn't installed or the payload hasn't been built.
    // Why this result is CARRIED rather than only logged (2026-08-03): it used
    // to be `if (!dep.ok) logError(...)` and nothing else, so a launch that
    // could not possibly load the mod went ahead in complete silence. The user
    // then saw only "Mod not found - check BepInEx logs" in the sidebar AFTER
    // the game was up, which describes the symptom and not the cause.
    //
    // That cost a tester's whole first session on v0.9.0: the app looked fine,
    // every Special was toggled on, the game launched, and nothing loaded. The
    // reason is knowable at THIS line - deployPatcher already returns it - it
    // simply was not being told to anyone. Same rule as the historical-build
    // branch below: it must not be silent.
    let modDeploy = { ok: true };
    try {
      const target = id === 'current' ? loadConfig().gamePath : gtVersions.installPath(id);
      if (target) {
        const dep = modPayload.deployPatcher(target);
        modDeploy = dep;
        if (!dep.ok) logError('[ModPayload] patcher deploy incomplete:', dep.error);
        // Remember where we put it so we can strip it again when the game closes.
        lastPatcherTarget = target;
        // Protect this patcher from the idle cleanup until the MOD actually
        // says hello (handleModHello clears this). 5 minutes is deliberately
        // generous — a cold Steam start with SteamVR behind it on an HDD is
        // routinely 2-3 minutes, and the cost of being wrong here is only
        // that a failed launch leaves the bootstrap on disk until the next
        // poll after the window expires.
        launchGraceUntil = Date.now() + 300000;
      }
    } catch (e) {
      logError('[ModPayload] pre-launch deploy failed:', e.message);
      modDeploy = { ok: false, error: e.message };
    }

    // Historical versions launch directly from the side-loaded copy.
    // `current` falls through to the normal Steam-URI launch.
    if (id !== 'current') {
      // Hard guard: if the user picked a specific build but it isn't
      // installed yet, FAIL with a clear message instead of silently
      // launching the live Steam install. Previously this fall-through
      // is what made it feel like "the wrong version launched."
      if (!gtVersions.isInstalled(id)) {
        return fail(new Error(
          `That Gorilla Tag version isn't downloaded yet. Open the Versions page and click "Download via Steam" first.`
        ));
      }
      // Refuse to launch a folder that cannot prove it holds the build its name
      // claims. Older installs (made before receipts existed) can be the wrong
      // build entirely - that is the "it launches a different update" report -
      // and launching them anyway would keep the problem invisible.
      // installedInfo walks the install folder, which is now async so the walk
      // no longer blocks the main process. See folderSize in gt-versions.cjs.
      const info = await gtVersions.installedInfo(id);
      if (!info.verified) {
        return {
          ok: false,
          code: 'VERSION_UNVERIFIED',
          error: info.reason === 'manifest-mismatch'
            ? `That folder contains a different Gorilla Tag build than the one it is labelled with, so it was not launched. Re-download this version from the Versions page.`
            : `This version was installed before Excalibur started recording which build it downloaded, so it can't be confirmed as the right one. Re-download it from the Versions page to be sure.`,
          data: { versionId: id, reason: info.reason, expected: info.expected || null, actual: info.actual || null },
        };
      }
      // A historical build is a bare Steam depot copy. BepInEx only ever gets
      // installed into the LIVE game folder, so nothing has ever put a mod
      // loader in here - the build starts vanilla, with no mods and no
      // wristband. That is legitimate (people downgrade to play an old build)
      // but it must not be silent, because "I launched it and none of my mods
      // were there" reads as the launcher being broken.
      //
      // [DECIDED 2026-07-29, owner] Telling the user is the WHOLE feature. We
      // are not going to make mods work on historical builds, now or later.
      //
      // Installing the loader here is the easy half and is not the problem. The
      // problem is that Excalibur's C# is compiled against the CURRENT game: one
      // ordinary update (2026-07-24) removed GTPlayerTransform.RotateToForward,
      // made GorillaComputer._allowedMapsToJoin private and stopped TeleportStation
      // being a Tappable. Point back a year and the built-in features have to be
      // rewritten per build, then rebuilt and retested per build, forever, with
      // the cost growing every time Gorilla Tag ships. So this stays a launcher
      // feature for playing old builds vanilla.
      //
      // If this is ever revisited, revisit THAT, not the loader install.
      const modLoaderPresent = fs.existsSync(path.join(gtVersions.installPath(id), 'BepInEx'));
      const exe = gtVersions.binaryPath(id);
      require('child_process').spawn(exe, [], {
        cwd: gtVersions.installPath(id),
        detached: true,
        windowsHide: false,
      }).unref();
      return ok({ launched: true, versionId: id, modsUnavailable: !modLoaderPresent });
    }
    // Launch from the folder the USER selected - not whatever copy Steam happens
    // to have registered. If there's no game there we surface a typed error so
    // the UI can offer to switch to a folder that actually has one.
    const gamePath = (() => { try { return loadConfig().gamePath || null; } catch { return null; } })();
    let vrWarning = null;
    try {
      // Quest mode can start the game perfectly and still never reach the
      // headset, if the Meta client is missing or another app holds the OpenXR
      // runtime. Both are knowable before launch, so they come back here rather
      // than being left in the log for nobody to read.
      ({ vrWarning } = launchGorillaTag(mode || 'steamvr', launchOptions || {}, gamePath) || {});
    } catch (e) {
      if (e && e.code === 'NO_GAME_AT_PATH') {
        logError(e);
        return {
          ok: false,
          code: 'NO_GAME_AT_PATH',
          error: e.message,
          data: { gamePath, recommended: recommendedGorillaTagFolder() },
        };
      }
      throw e;
    }
    // If we passed any display/resolution/monitor override, Unity will persist
    // it into GT's PlayerPrefs. Flag a restore so we undo it when this session
    // ends (see maybeRestoreGtDisplay + the game-state poll loop).
    if (launchHasDisplayOverride(launchOptions)) flagPendingDisplayRestore();
    // The game IS launching either way - refusing to start Gorilla Tag because
    // a mod cannot load would be worse than launching it vanilla. But the
    // renderer is told, so it can say WHICH thing is wrong instead of leaving
    // the user to infer it from a sidebar chip after the fact.
    return ok({
      launched: true,
      modDeploy: modDeploy.ok ? { ok: true } : { ok: false, error: modDeploy.error || 'unknown' },
      vrWarning: vrWarning || null,
    });
  } catch (e) {
    return fail(e);
  }
});

// ─── GT version-downgrader IPC ────────────────────────────────────────
ipcMain.handle('gtv:fetch-manifests', async (event, { force } = {}) => {
  try {
    const r = await gtVersions.fetchManifests({
      force: !!force,
      onProgress: (data) => { event.sender.send('gtv:scrape-progress', data); },
    });
    return ok(r);
  } catch (e) { return fail(e); }
});

ipcMain.handle('gtv:detect-steam', async () => {
  try {
    const r = await gtVersions.detectSteam();
    return ok(r ? { steamInstalled: true, steamPath: r.steamPath } : { steamInstalled: false });
  } catch (e) { return fail(e); }
});

ipcMain.handle('gtv:list-installed', () => {
  try { return ok(gtVersions.listInstalled()); } catch (e) { return fail(e); }
});

ipcMain.handle('gtv:is-installed', (_e, id) => {
  try { return ok(gtVersions.isInstalled(id)); } catch (e) { return fail(e); }
});

// Takes the manifest the caller is asking about: "is there an exe in Steam's
// folder" is not a useful question, "are those files the build I asked for" is.
ipcMain.handle('gtv:check-steam-folder', async (_e, arg) => {
  try {
    const manifestId = typeof arg === 'string' ? arg : arg?.manifestId;
    return ok(await gtVersions.checkSteamFolder({ manifestId }));
  } catch (e) { return fail(e); }
});

ipcMain.handle('gtv:list-installed-detailed', async () => {
  try { return ok(await gtVersions.listInstalledDetailed()); } catch (e) { return fail(e); }
});

ipcMain.handle('gtv:remove', async (_e, id) => {
  try {
    await gtVersions.removeVersion(id);
    // If the version we just deleted was the selected one, the config would
    // still point at it and every launch would fail with "not downloaded".
    try {
      const cfg = loadConfig();
      if (cfg?.gtVersion === id) saveConfig({ ...cfg, gtVersion: 'current' });
    } catch (e) { logError('[gtv] could not reset gtVersion after remove:', e.message); }
    return ok(true);
  } catch (e) { return fail(e); }
});

ipcMain.handle('gtv:prepare-download', async (_e, { versionId, manifestId }) => {
  try {
    const r = await gtVersions.prepareDownload({ versionId, manifestId });
    return ok(r);
  } catch (e) { return fail(e); }
});

// Active poller cancel funcs keyed by versionId. Renderer can cancel
// via gtv:cancel-download.
const _activePollers = new Map();

ipcMain.handle('gtv:start-poll', (event, { versionId, manifestId }) => {
  try {
    if (_activePollers.has(versionId)) {
      try { _activePollers.get(versionId)(); } catch {}
      _activePollers.delete(versionId);
    }
    const cancel = gtVersions.pollDownload({ versionId, manifestId }, (evt) => {
      event.sender.send('gtv:event', { versionId, ...evt });
    });
    _activePollers.set(versionId, cancel);
    return ok(true);
  } catch (e) { return fail(e); }
});

ipcMain.handle('gtv:cancel-download', (_e, versionId) => {
  try {
    const c = _activePollers.get(versionId);
    if (c) { c(); _activePollers.delete(versionId); }
    return ok(true);
  } catch (e) { return fail(e); }
});

ipcMain.handle('gtv:finalize', async (_e, { versionId, manifestId, sourcePath }) => {
  try {
    const r = await gtVersions.finalizeDownload({ versionId, manifestId, sourcePath });
    if (_activePollers.has(versionId)) {
      try { _activePollers.get(versionId)(); } catch {}
      _activePollers.delete(versionId);
    }
    return ok(r);
  } catch (e) { return fail(e); }
});

ipcMain.handle('game:quit', async () => {
  try {
    const r = await quitGorillaTag();
    if (!r.ok) return { ok: false, error: r.error };
    return ok(r);
  } catch (e) {
    return fail(e);
  }
});

// Manual failsafe for the rare case the automatic restore didn't run: put GT's
// display PlayerPrefs back to its defaults so plain Steam launches stop coming
// up windowed. Refuses while the game is running (Unity rewrites these on exit).
ipcMain.handle('game:reset-display', () => {
  try {
    if (isGorillaTagRunning()) {
      return { ok: false, code: 'GAME_RUNNING', error: 'Close Gorilla Tag first, then reset.' };
    }
    const r = gtDisplay.restoreGorillaTagDisplayDefaults();
    try {
      const cfg = loadConfig();
      cfg.pendingDisplayRestore = false;
      cfg.displayLeakHealed = true;
      saveConfig(cfg);
    } catch { /* non-fatal */ }
    return ok(r);
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('packs:export', async (_e, { modPaths, metadata }) => {
  try {
    const pickRes = await dialog.showSaveDialog(mainWindow, {
      title: 'Export mod pack',
      defaultPath: `${(metadata?.name || 'pack').replace(/[\\/:*?"<>|]/g, '_')}.gtmp`,
      filters: [{ name: 'Excalibur Mod Pack', extensions: ['gtmp'] }],
    });
    if (pickRes.canceled || !pickRes.filePath) return ok({ canceled: true });
    return ok(exportPack(modPaths, metadata, pickRes.filePath));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('packs:pick', async () => {
  try {
    const pickRes = await dialog.showOpenDialog(mainWindow, {
      title: 'Import mod pack',
      properties: ['openFile'],
      filters: [{ name: 'Excalibur Mod Pack', extensions: ['gtmp'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (pickRes.canceled || pickRes.filePaths.length === 0) return ok({ canceled: true });
    const filePath = pickRes.filePaths[0];
    const { manifest } = readPack(filePath);
    return ok({ filePath, manifest });
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('packs:save-as-profile', (_e, { filePath }) => {
  try {
    const packsBase = path.join(app.getPath('userData'), 'packs');
    const packId = crypto.randomUUID();
    const { manifest, destDir } = extractPackForProfile(filePath, packsBase, packId);
    // Create a pack-type profile pointing at the staged files.
    const profileList = saveProfile({
      name: manifest.name || 'Untitled Pack',
      kind: 'pack',
      modBaseNames: manifest.mods.map((m) => m.name),
      packDir: destDir,
      source: path.basename(filePath),
      description: manifest.description || '',
    });
    return ok({ manifest, profiles: profileList });
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('profiles:list', () => {
  try {
    return ok(listProfiles());
  } catch (e) {
    return fail(e);
  }
});

// Create the permanent Standard profile (seeded with every installed mod) if it
// doesn't exist yet, and fold any orphan mods into it. Returns the full list.
ipcMain.handle('profiles:ensure-standard', (_e, gamePath) => {
  try {
    return ok(ensureStandardProfile(gamePath));
  } catch (e) {
    return fail(e);
  }
});

// Purge a mod baseName from every profile (used after "Delete entirely" removes
// the physical file). Returns the updated profile list.
ipcMain.handle('profiles:remove-mod-everywhere', (_e, baseName) => {
  try {
    return ok(removeModFromAllProfiles(baseName));
  } catch (e) {
    return fail(e);
  }
});

// Re-point every profile's membership after a mod file is renamed, so the mod
// stays in the loadouts it was already part of. Returns the updated list.
ipcMain.handle('profiles:rename-mod-everywhere', (_e, { oldName, newName }) => {
  try {
    return ok(renameModInAllProfiles(oldName, newName));
  } catch (e) {
    return fail(e);
  }
});

// ── Cloud Sync ──────────────────────────────────────────────────────────────
ipcMain.handle('sync:device-info', () => {
  try { return ok(sync.deviceInfo()); } catch (e) { return fail(e); }
});
// Vault (Pro+) file ops — implemented in Stage 4; handlers registered here so
// the preload surface is complete.
ipcMain.handle('sync:hash-mods', async (_e, baseNames) => {
  try { return ok(await sync.hashMods(baseNames)); } catch (e) { return fail(e); }
});
ipcMain.handle('sync:read-mod-file', async (_e, baseName) => {
  try { return ok(await sync.readModFile(baseName)); } catch (e) { return fail(e); }
});
ipcMain.handle('sync:write-mod-file', async (_e, payload) => {
  try { return ok(await sync.writeModFile(payload)); } catch (e) { return fail(e); }
});

ipcMain.handle('profiles:replace-all', (_e, list) => {
  try {
    return ok(replaceAll(list));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('profiles:save', (_e, profile) => {
  try {
    return ok(saveProfile(profile));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('profiles:delete', (_e, id) => {
  try {
    return ok(deleteProfile(id));
  } catch (e) {
    return fail(e);
  }
});

// Lets the renderer pop a native file picker for an instance icon, then
// copies the chosen image into userData/profile-icons/<id>.<ext> and
// returns a stable file:// URL that the renderer can use as <img src>.
// The caller still has to write the returned `iconPath` onto the profile
// via profiles:save - this handler only stages the file.
ipcMain.handle('profiles:pick-icon', async (_e, profileId) => {
  try {
    if (!profileId) return fail('no_profile_id');
    const r = await dialog.showOpenDialog({
      title: 'Pick an instance icon',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      ],
    });
    if (r.canceled || !r.filePaths?.[0]) return ok(null);
    const src = r.filePaths[0];
    const stat = fs.statSync(src);
    if (stat.size > 4 * 1024 * 1024) return fail('icon_too_large');
    const ext = path.extname(src).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.png';
    const dir = path.join(app.getPath('userData'), 'profile-icons');
    fs.mkdirSync(dir, { recursive: true });
    // Stamp the filename with a timestamp so the renderer's <img> cache
    // busts whenever the icon changes - file:// URLs cache aggressively
    // and serving the same path with new bytes leaves the old image up.
    const dest = path.join(dir, `${String(profileId).replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}${ext}`);
    fs.copyFileSync(src, dest);
    const iconName = path.basename(dest);
    // The renderer loads icons through our custom protocol (see the
    // app.whenReady protocol.handle block) - file:// URLs are blocked
    // cross-origin by Electron's webSecurity:true default.
    return ok({ iconPath: dest, iconUrl: `excalibur-icon://icon/${encodeURIComponent(iconName)}` });
  } catch (e) {
    return fail(e.message || String(e));
  }
});

ipcMain.handle('profiles:apply', (_e, { gamePath, profileId }) => {
  try {
    if (isGorillaTagRunning()) {
      return {
        ok: false,
        error: 'Gorilla Tag is currently running. Close it before applying a profile.',
        code: 'GAME_RUNNING',
      };
    }
    return ok(applyProfile(gamePath, profileId));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('util:open-log', () => {
  try {
    shell.openPath(getLogPath());
    return ok(true);
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('util:clear-log', () => {
  try {
    const p = getLogPath();
    if (fs.existsSync(p)) fs.writeFileSync(p, '');
    return ok(true);
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('util:reset-config', () => {
  try {
    const current = loadConfig();
    // Reset to factory defaults, keeping gamePath so the user doesn't have to
    // re-detect Steam. All other values come from the canonical defaults object
    // so this automatically covers any newly added config fields.
    const reset = {
      ...configDefaults,
      gamePath: current.gamePath,
      window: null,
      onboarded: false,
    };
    saveConfig(reset);
    return ok(reset);
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('util:open-bepinex', (_e, gamePath) => {
  try {
    if (!gamePath) return ok(false);
    // Directory-only, for the same reason as util:open-folder above - the
    // fallback branch used to hand shell.openPath whatever the renderer sent.
    const bep = path.join(gamePath, 'BepInEx');
    const target = openableDir(bep) || openableDir(gamePath);
    if (!target) return ok(false);
    shell.openPath(target);
    return ok(true);
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('util:open-folder', (_e, p) => {
  try {
    // It is called open-FOLDER, so only ever open a folder. `existsSync` alone
    // let any existing path through, and shell.openPath on a .exe/.bat/.lnk
    // RUNS it - which turned a renderer compromise into local code execution.
    if (typeof p !== 'string' || !p) return ok(false);
    let st;
    try { st = fs.statSync(p); } catch { return ok(false); }
    if (!st.isDirectory()) {
      logInfo('[util] open-folder refused a non-directory:', p.slice(0, 160));
      return ok(false);
    }
    shell.openPath(p);
    return ok(true);
  } catch (e) {
    return fail(e);
  }
});

// ── Per-profile desktop shortcuts ────────────────────────────────────
// A .lnk on the desktop targeting this exe with `excalibur://play/<id>`.
// Double-clicking forwards that URL to the running app (or cold-starts it)
// through the single-instance handler above, and the renderer applies the
// profile and launches the game. See electron/shortcuts.cjs for why the
// argument shape differs in dev and why ownership is read back out of the
// .lnk rather than guessed from its filename. Windows-only.
//
// `iconPath` is the profile's own uploaded image, which we convert to an .ico
// so each shortcut looks like the modpack it launches. It is optional and
// failing to convert it only costs the custom icon, never the shortcut.
ipcMain.handle('profiles:create-shortcut', async (_e, { profileId, name, iconPath } = {}) => {
  try {
    return ok(await shortcuts.createProfileShortcut({ profileId, name, iconPath }));
  } catch (e) {
    return fail(e);
  }
});

// { [profileId]: '<path to .lnk>' } for every shortcut of ours on the desktop.
// Drives the "Shortcut on desktop" state in the Play menu, so the UI reflects
// what is ACTUALLY there - including shortcuts the user deleted by hand.
ipcMain.handle('profiles:shortcut-status', () => {
  try {
    return ok(shortcuts.shortcutStatus());
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('profiles:remove-shortcut', (_e, profileId) => {
  try {
    return ok(shortcuts.removeProfileShortcut(profileId));
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('util:open-external', (_e, url) => {
  try {
    // Accept only http(s), discord:, and ms-settings: (Windows Settings deep
    // links, e.g. notification-access) so we can't be talked into firing
    // file://, javascript:, or other dangerous URIs from the renderer.
    // Anything else is a silent no-op.
    if (typeof url !== 'string') return ok(false);
    if (!/^(https?:|discord:|ms-settings:)/i.test(url)) return ok(false);
    // Log every outbound link. "Every button opens the profile page" is not
    // reproducible from source - the renderer's URLs are correct and the
    // website's router resolves each of them to the right route - so the one
    // thing nobody could see was what URL actually left the app. One line per
    // click separates "the app sent the wrong URL" from "the site mis-routed
    // a correct one", which are opposite fixes.
    logInfo('[link] opening:', url);
    shell.openExternal(url);
    return ok(true);
  } catch (e) {
    return fail(e);
  }
});

// ── App-shell actions driven by the title-bar dropdown ───────────────
// system:open-logs opens whichever Excalibur log folder exists; we
// look at the common places electron-log writes (per-OS path) and
// fall back to %APPDATA%\Excalibur\logs on Windows.
ipcMain.handle('system:open-logs', () => {
  try {
    const candidates = [
      path.join(app.getPath('logs') || '', ''),
      path.join(app.getPath('userData') || '', 'logs'),
      path.join(app.getPath('userData') || '', ''),
    ].filter(Boolean);
    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        shell.openPath(p);
        return ok(true);
      }
    }
    return fail('no_log_dir_found');
  } catch (e) {
    return fail(e);
  }
});

// system:relaunch restarts the whole Electron app (not just the
// renderer) - same shape as Lunar's "Restart Launcher" menu item.
ipcMain.handle('system:relaunch', () => {
  try {
    app.relaunch();
    app.exit(0);
    return ok(true);
  } catch (e) {
    return fail(e);
  }
});

// system:get-version returns the app version string (read from
// package.json at packaging time) - used by the title-bar dropdown's
// "About" entry.
ipcMain.handle('system:get-version', () => {
  try { return ok(app.getVersion()); } catch (e) { return fail(e); }
});

ipcMain.handle('util:paths', () => {
  return ok({ config: getConfigPath(), log: getLogPath() });
});

// App version - used by WhatsNewToast to compare against
// config.whatsNewSeenVersion. Reads from package.json via app.getVersion()
// so it always tracks whatever electron-packager built into this binary.
ipcMain.handle('util:app-version', () => {
  try { return ok(app.getVersion()); }
  catch (e) { return fail(e.message); }
});

// Is this account allowed the diagnostics bundle? Testers, master testers and
// developers - nobody else.
//
// Read from auth.getStatus(), which returns claims off a token whose RS256
// signature was already verified against the public key embedded in this
// binary. That makes it server-asserted rather than client-controlled: editing
// the token, or the config, or anything else on disk, cannot manufacture a
// tester. Same reasoning as the developer-panel gate.
//
// NOT read from the renderer. The `canDiagnose` prop decides whether a BUTTON
// is drawn, and a drawn button is a UI decision, not a permission - anyone can
// open devtools and call window.gtmm.util.diagnostics() directly. The prop is
// convenience; this is the gate.
function diagnosticsAllowed() {
  try {
    const { mayDiagnose } = require('./diagnostics.cjs');
    const { user } = auth.getStatus() || {};
    return mayDiagnose(user);
  } catch { return false; }
}

// Whether to DRAW the button. Deliberately the same function the handler
// itself gates on, so the control cannot be shown to someone the handler would
// refuse, or hidden from someone it would allow. Threading this as a React
// prop through three components was the alternative, and props drift.
ipcMain.handle('util:can-diagnose', () => {
  try { return ok(diagnosticsAllowed()); } catch (e) { return fail(e); }
});

// One paste that answers "why did the mod not load". Everything sensitive is
// stripped inside buildDiagnosticBundle, not here, so there is exactly one
// place to audit for redaction.
ipcMain.handle('util:diagnostics', () => {
  try {
    if (!diagnosticsAllowed()) {
      logError('[Diagnostics] refused: account is not a tester or developer');
      return { ok: false, error: 'not_permitted' };
    }
    const { buildDiagnosticBundle } = require('./diagnostics.cjs');
    const cfg = (() => { try { return loadConfig(); } catch { return {}; } })();
    // `who` is taken from the VERIFIED claims too, not from the caller. A
    // renderer-supplied identity would be a line in a support paste that says
    // whatever the sender wanted it to say.
    const { user } = auth.getStatus() || {};
    return ok(buildDiagnosticBundle({
      gamePath:   cfg.gamePath || null,
      appVersion: app.getVersion(),
      who: {
        username: user?.username || null,
        role:     user?.app_role === 'developer' ? 'developer'
                  : user?.is_master_tester ? 'master_tester'
                  : user?.is_tester ? 'tester' : 'user',
        tier:     user?.tier || 'free',
      },
      payloadDir: modPayload.payloadDir(),
      runtimeDir: modPayload.runtimeDir(),
    }));
  } catch (e) { return fail(e); }
});

ipcMain.handle('util:read-bepinex-log', (_e, gamePath) => {
  try {
    if (!gamePath) return ok({ found: false, lines: [] });
    const logPath = path.join(gamePath, 'BepInEx', 'LogOutput.log');
    if (!fs.existsSync(logPath)) return ok({ found: false, lines: [] });
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return ok({ found: true, lines: lines.slice(-200), logPath });
  } catch (e) {
    return fail(e);
  }
});

// ── Session logs archive ──────────────────────────────────────────
// Modrinth-style per-modpack log history. BepInEx's LogOutput.log gets
// overwritten on every launch, so if a session crashes and the user
// starts GT again the crash context is gone. We snapshot the log
// after each session into a per-profile archive folder so users can
// browse past sessions and open the one where things went wrong.
//
// Path layout:
//   <userData>/session-logs/<profileId>/<ISO-timestamp>.log
//
// Files are plain text - the same content BepInEx writes, no
// re-formatting. Keeping the last 20 sessions per profile so the
// folder doesn't grow forever; older entries are rotated out on each
// new snapshot.
const SESSION_LOG_ROOT   = () => path.join(app.getPath('userData'), 'session-logs');
const SESSION_LOG_KEEP   = 20;

// A profile id is an opaque key, never a path. It arrives from the RENDERER and
// this directory is not just written to - the rotation below fs.unlinkSync()s
// every .log in it past the newest N. An id of '../../Documents' therefore
// deleted the user's logs somewhere else entirely. Same traversal class as the
// gtv:remove CRITICAL fixed 2026-08-01.
//
// Profile ids are 'standard' or a generated key, so a conservative charset is
// safe here. Returns null for anything else; every caller must treat that as
// "no directory" rather than falling back to a default, or the fallback becomes
// the hole.
function safeProfileDirName(profileId) {
  const id = String(profileId ?? '').trim();
  if (!id) return null;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) return null;
  if (id === '.' || id === '..') return null;    // allowed by the charset above
  return id;
}

function ensureLogDir(profileId) {
  const safe = safeProfileDirName(profileId);
  if (!safe) return null;
  const root = SESSION_LOG_ROOT();
  const dir = path.join(root, safe);
  // Backstop: prove we stayed under the root before creating anything.
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('game-logs:snapshot', (_e, { profileId, gamePath } = {}) => {
  try {
    if (!gamePath || !profileId) return ok({ saved: false, reason: 'missing_input' });
    const srcPath = path.join(gamePath, 'BepInEx', 'LogOutput.log');
    if (!fs.existsSync(srcPath)) return ok({ saved: false, reason: 'no_source' });
    const stat = fs.statSync(srcPath);
    // Skip tiny/empty logs - GT hadn't actually loaded BepInEx yet.
    if (stat.size < 200) return ok({ saved: false, reason: 'too_small' });
    const dir  = ensureLogDir(profileId);
    if (!dir) return ok({ saved: false, reason: 'bad_profile_id' });
    // ISO-ish timestamp safe for filenames on Windows.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest  = path.join(dir, `${stamp}.log`);
    fs.copyFileSync(srcPath, dest);
    // Rotate: keep the newest SESSION_LOG_KEEP entries only.
    const entries = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.log'))
      .map((n) => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of entries.slice(SESSION_LOG_KEEP)) {
      try { fs.unlinkSync(path.join(dir, stale.name)); } catch { /* nbd */ }
    }
    return ok({ saved: true, path: dest, bytes: stat.size });
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('game-logs:list', (_e, profileId) => {
  try {
    // Read-only, but it still hands the renderer absolute paths for whatever
    // directory the id resolves to, so it gets the same containment rule.
    const safe = safeProfileDirName(profileId);
    if (!safe) return ok([]);
    const dir = path.join(SESSION_LOG_ROOT(), safe);
    if (!fs.existsSync(dir)) return ok([]);
    const rows = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.log'))
      .map((n) => {
        const full = path.join(dir, n);
        const st = fs.statSync(full);
        return { name: n, path: full, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return ok(rows);
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('game-logs:read', (_e, logPath) => {
  try {
    if (!logPath || !fs.existsSync(logPath)) return ok({ found: false, lines: [] });
    // Safety: only serve files under the session-logs root so the
    // renderer can't turn this into an arbitrary file-read primitive.
    const root = SESSION_LOG_ROOT();
    if (!isInsideDir(root, logPath)) {
      return fail(new Error('Path outside session-logs root'));
    }
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return ok({ found: true, lines });
  } catch (e) {
    return fail(e);
  }
});

// Reveal the per-profile session-logs folder in Explorer / Finder.
// Creates the folder first if it doesn't exist yet - otherwise a
// first-run user with zero sessions would just get a silent no-op
// when they click "Open folder".
ipcMain.handle('game-logs:open-folder', async (_e, profileId) => {
  try {
    const dir = ensureLogDir(profileId);
    if (!dir) return fail(new Error('bad profile id'));
    const err = await shell.openPath(dir);
    if (err) return fail(new Error(err));
    return ok({ dir });
  } catch (e) {
    return fail(e);
  }
});

ipcMain.handle('game-logs:delete', (_e, logPath) => {
  try {
    if (!logPath) return ok({ deleted: false });
    const root = SESSION_LOG_ROOT();
    if (!isInsideDir(root, logPath)) {
      return fail(new Error('Path outside session-logs root'));
    }
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    return ok({ deleted: true });
  } catch (e) {
    return fail(e);
  }
});

// ── ReShade detection ──────────────────────────────────────────────
// Best-effort filesystem check for "is ReShade installed for this
// Gorilla Tag copy". ReShade injects as one of the standard wrapper
// DLLs (dxgi.dll for D3D11, d3d11.dll, opengl32.dll), and the VR-
// flavoured installer also creates a `reshade-presets` folder and a
// `ReShade.ini` config file next to the game exe. Any one of those
// is good enough to say "yes, it's there"; we report which evidence
// we found so the renderer can show "Installed - dxgi.dll detected"
// instead of a bare badge.
ipcMain.handle('reshade:detect', (_e, gamePath) => {
  try {
    if (!gamePath || !fs.existsSync(gamePath)) {
      return ok({ installed: false, evidence: [], reason: 'no_game_path' });
    }
    const candidates = [
      'dxgi.dll',
      'd3d11.dll',
      'd3d10.dll',
      'd3d9.dll',
      'opengl32.dll',
      'ReShade.ini',
      'reshade-presets',
      'reshade-shaders',
      'ReShade64.dll',
      'ReShade32.dll',
    ];
    const evidence = [];
    for (const name of candidates) {
      const p = path.join(gamePath, name);
      if (fs.existsSync(p)) evidence.push(name);
    }
    return ok({ installed: evidence.length > 0, evidence });
  } catch (e) {
    return fail(e.message || String(e));
  }
});

// Opens the official ReShade download page in the user's browser.
// Wrapping the actual installer is brittle (silent-install flags
// aren't documented for VR mode, UAC + antivirus prompts derail it),
// so we let the user run the real installer themselves and just
// auto-detect when they're done via reshade:detect polling.
ipcMain.handle('reshade:open-download', () => {
  try {
    shell.openExternal('https://reshade.me/');
    return ok(true);
  } catch (e) {
    return fail(e);
  }
});

// ── ReShade preset install (Phase 1) ───────────────────────────────
// Downloads a community .ini preset and drops it next to the user's
// Gorilla Tag install where ReShade can pick it up. We try the most
// common ReShade preset locations first; if none exist we fall back
// to the user's Downloads folder with a clear `location: 'downloads'`
// in the result so the renderer can show "you'll need to drag this
// into your ReShade folder yourself" copy.
//
// No ReShade auto-detect, no .fx shader bundle install - those are
// Phase 2. This handler just unblocks the upload→download loop so
// presets shared by other players can be tried in one click.
ipcMain.handle('reshade:install-preset', async (_e, { url, fileName, gamePath } = {}) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return fail('invalid_url');

    const safeName = String(fileName || 'preset.ini').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    if (!/\.ini$/i.test(safeName)) return fail('not_ini');

    // Pull the .ini over HTTPS. Presets are tiny (KB) so we just
    // buffer the whole response in memory.
    const buf = await new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // One-shot redirect follow - Supabase public storage rarely
          // redirects, but handle it cleanly if the bucket switches to
          // a signed-URL flow later.
          https.get(res.headers.location, (res2) => {
            const chunks = [];
            res2.on('data', (c) => chunks.push(c));
            res2.on('end', () => resolve(Buffer.concat(chunks)));
            res2.on('error', reject);
          }).on('error', reject);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`http_${res.statusCode}`)); return; }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    });

    // Cap the file size as a sanity check - Phase 1 doesn't ship .fx
    // shader bundles so a real preset should always be well under 1 MB.
    if (buf.length > 5 * 1024 * 1024) return fail('preset_too_large');

    // Pick a save target. Order:
    //   1. <gamePath>/reshade-presets/      (standard ReShade preset dir)
    //   2. <gamePath>/reshade-shaders/      (older ReShade install layout)
    //   3. <gamePath>/                      (loose .ini next to the exe also works)
    //   4. ~/Downloads/                     (fallback - user installs by hand)
    let saveDir = null;
    let location = 'downloads';
    const candidates = gamePath ? [
      { dir: path.join(gamePath, 'reshade-presets'), tag: 'reshade-presets' },
      { dir: path.join(gamePath, 'reshade-shaders'), tag: 'reshade-shaders' },
    ] : [];
    for (const c of candidates) {
      if (fs.existsSync(c.dir)) { saveDir = c.dir; location = c.tag; break; }
    }
    if (!saveDir) {
      saveDir = app.getPath('downloads');
      location = 'downloads';
    }

    // Avoid clobbering an existing preset with the same name - append
    // `-2`, `-3`, ... until we find a free slot.
    let finalPath = path.join(saveDir, safeName);
    let attempt = 1;
    while (fs.existsSync(finalPath)) {
      attempt += 1;
      const ext  = path.extname(safeName);
      const base = safeName.slice(0, -ext.length);
      finalPath = path.join(saveDir, `${base}-${attempt}${ext}`);
      if (attempt > 99) break;
    }

    fs.writeFileSync(finalPath, buf);
    return ok({ path: finalPath, location });
  } catch (e) {
    return fail(e.message || String(e));
  }
});

ipcMain.handle('util:screens', () => {
  try {
    const displays = screen.getAllDisplays();
    return ok(displays.map((d, i) => ({
      index: i + 1,
      id: d.id,
      label: `Monitor ${i + 1}${d.bounds.x === 0 && d.bounds.y === 0 ? ' (Primary)' : ''}`,
      bounds: d.bounds,
    })));
  } catch (e) {
    return fail(e);
  }
});

// Undo the recording-folder hijack described in syncObsWebsocket(), ONCE per
// install, for the machines the old code already changed.
//
// It only touches a value that is still EXACTLY our old target - a path the
// user picked themselves is never rewritten. What it restores is OBS's own
// default (Videos), because the original was overwritten in place and never
// saved anywhere; that is the closest honest answer we can give, and the log
// line says so rather than pretending we recovered their setting.
//
// The `obsRecPathRepaired` flag matters as much as the repair: without it this
// would re-run every 15s and stomp anyone who genuinely WANTS Excalibur's
// folder - the exact bug we are removing, pointed the other way.
function repairHijackedObsRecordingPath() {
  const cfg = loadConfig();
  if (cfg.obsRecPathRepaired) return;

  const norm = (p) => String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const hijacked = norm(path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Excalibur', 'recordings',
  ));

  const obsBase = path.join(os.homedir(), 'AppData', 'Roaming', 'obs-studio');
  let profileName = 'Untitled';
  const gIni = path.join(obsBase, 'global.ini');
  if (fs.existsSync(gIni)) {
    const m = fs.readFileSync(gIni, 'utf8').match(/^Profile\s*=\s*(.+)$/m);
    if (m) profileName = m[1].trim();
  }
  const bIni = path.join(obsBase, 'basic', 'profiles', profileName, 'basic.ini');
  // No profile to inspect yet: leave the flag unset so we look again later
  // rather than marking a machine repaired that we never actually read.
  if (!fs.existsSync(bIni)) return;

  const restore = path.join(os.homedir(), 'Videos').replace(/\\/g, '/');
  const txt = fs.readFileSync(bIni, 'utf8');
  // FilePath is Simple output, RecFilePath is Advanced.
  const fixed = txt.replace(/^(FilePath|RecFilePath)(\s*=\s*)(.*)$/gm,
    (line, key, eq, val) => (norm(val) === hijacked ? `${key}${eq}${restore}` : line));

  if (fixed !== txt) {
    fs.writeFileSync(bIni, fixed, 'utf8');
    console.log(`[obs] recording folder was pointed at Excalibur's own folder by an older build - restored to ${restore} (restart OBS to apply). Set it wherever you like; we will not touch it again.`);
  }
  saveConfig({ ...loadConfig(), obsRecPathRepaired: true });
}

// OBS WebSocket self-heal. The single biggest "OBS never connects" cause is
// obs-websocket shipping DISABLED by default; the second is a password or
// port Excalibur doesn't know. OBS keeps all three in a plain JSON file, so:
//   - server_enabled false -> flip it true. OBS only reads this at startup
//     (and rewrites it on exit), so if OBS is open right now our write can be
//     lost on its exit - the 15s resync converges it; a closed OBS keeps the
//     flip and comes up listening.
//   - mirror server_port + password (empty when auth is off) into the app
//     config, which ConfigWatcher streams to the mod within a second - the
//     in-game client dials the RIGHT port with the RIGHT password even if
//     the user rotates them in OBS mid-session.
//
// Note what is NOT in that list any more: this function does not choose where
// OBS saves recordings. Enabling a server the user already installed is a
// self-heal; moving their files is a decision, and it was not ours to make.
let _obsSyncLoggedEnable = false;
function syncObsWebsocket() {
  const wsCfgPath = path.join(
    os.homedir(), 'AppData', 'Roaming', 'obs-studio',
    'plugin_config', 'obs-websocket', 'config.json',
  );
  if (!fs.existsSync(wsCfgPath)) return;   // OBS not installed / never ran
  let wc;
  try { wc = JSON.parse(fs.readFileSync(wsCfgPath, 'utf8')); } catch { return; }

  if (wc.server_enabled === false) {
    try {
      fs.writeFileSync(wsCfgPath, JSON.stringify({ ...wc, server_enabled: true }, null, 2));
      if (!_obsSyncLoggedEnable) {
        _obsSyncLoggedEnable = true;
        console.log('[obs] websocket server was disabled - enabled it (takes effect next OBS start; restart OBS if it is open)');
      }
    } catch { /* file locked - retry next tick */ }
  }

  // We used to repoint OBS's recording output at %APPDATA%\Excalibur\recordings
  // right here. That was wrong twice over. It rewrote a setting the user owns,
  // with no toggle, no prompt and no record of what it replaced - and because
  // this function runs every 15s it then FOUGHT anyone who set it back, which
  // reads as OBS being broken rather than as us doing it. Where a user keeps
  // their recordings is not ours to decide, and we never needed it: OBS is the
  // source of truth and detectObsOutputFolder() already follows it, so the
  // wristband FILES page and Smart Naming work wherever they choose.
  try { repairHijackedObsRecordingPath(); } catch { /* retry on the next tick */ }

  try {
    const cfg = loadConfig();
    const port = Number(wc.server_port) || 4455;
    const pass = wc.auth_required === false ? '' : String(wc.server_password || '');
    if ((cfg.obsPort ?? 4455) !== port || (cfg.obsPassword || '') !== pass) {
      saveConfig({ ...cfg, obsPort: port, obsPassword: pass });
      console.log(`[obs] synced websocket endpoint from OBS config (port ${port}, auth ${pass ? 'on' : 'off'})`);
    }
  } catch { /* config write races are self-correcting on the next tick */ }
}

// The one diagnosis the Settings page needs to tell the user the SINGLE thing
// standing between them and a connection. The killer case this exists for:
// OBS is RUNNING with its WebSocket server off, our file flip is invisible to
// the running instance (OBS reads it at startup only), and on exit OBS
// rewrites the file from memory - so "enabled on disk" and "listening" can
// disagree for a whole OBS session. Only a live port probe tells the truth.
function isObsProcessRunning() {
  try {
    const out = require('child_process').execFileSync('tasklist', ['/FI', 'IMAGENAME eq obs64.exe'], { encoding: 'utf8' });
    return /obs64\.exe/i.test(out);
  } catch { return false; }
}
ipcMain.handle('obs:diagnose', async () => {
  try {
    const wsCfgPath = path.join(
      os.homedir(), 'AppData', 'Roaming', 'obs-studio',
      'plugin_config', 'obs-websocket', 'config.json',
    );
    let fileFound = false, fileEnabled = null, port = 4455, authRequired = null;
    try {
      const wc = JSON.parse(fs.readFileSync(wsCfgPath, 'utf8'));
      fileFound = true;
      fileEnabled = wc.server_enabled !== false;
      port = Number(wc.server_port) || 4455;
      authRequired = wc.auth_required !== false;
    } catch { /* absent = OBS not installed or never ran */ }
    const listening = await new Promise((resolve) => {
      const sock = require('net').connect({ host: '127.0.0.1', port, timeout: 700 });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error',   () => resolve(false));
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
    });
    return { ok: true, data: { obsRunning: isObsProcessRunning(), fileFound, fileEnabled, port, authRequired, listening } };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

// Smart Naming — the disk half of the rename engine. The renderer owns the OBS
// connection and computes the name; this does every fallible fs operation.
// finalizeRename NEVER throws and never overwrites: the worst case it can
// return is "kept OBS's original name".
ipcMain.handle('smart-naming:finalize', async (_e, opts) => {
  try {
    return await finalizeRename(opts || {});
  } catch (e) {
    logError('smart-naming finalize failed:', e);
    return { ok: true, renamed: false, reason: 'ipc-error' };
  }
});

// Where OBS actually writes recordings - active profile's basic.ini, with
// the user's Videos folder as the fallback. Shared by the renderer IPC and
// the wristband FILES page (whose "OBS RECORDINGS" root is this folder).
function detectObsOutputFolder() {
  try {
    const obsBase = path.join(os.homedir(), 'AppData', 'Roaming', 'obs-studio');
    let profileName = 'Untitled';
    const globalIni = path.join(obsBase, 'global.ini');
    if (fs.existsSync(globalIni)) {
      const m = fs.readFileSync(globalIni, 'utf8').match(/^Profile\s*=\s*(.+)$/m);
      if (m) profileName = m[1].trim();
    }
    const basicIni = path.join(obsBase, 'basic', 'profiles', profileName, 'basic.ini');
    if (fs.existsSync(basicIni)) {
      // Simple-output and advanced-output store different keys.
      const m = fs.readFileSync(basicIni, 'utf8').match(/^(?:RecFilePath|FilePath)\s*=\s*(.+)$/m);
      if (m) return m[1].trim().replace(/\//g, path.sep);
    }
  } catch { /* fall through */ }
  return path.join(os.homedir(), 'Videos');
}
ipcMain.handle('obs:detect-output-folder', () => ok(detectObsOutputFolder()));

// Report "mod connected" using the SAME signal as the event path (a real
// `hello`), not the raw socket. The loader stub opens a transient authed socket
// to fetch the core but never sends `hello`; keying off bridge.isConnected here
// would latch the renderer's modConnected=true from that loader-only window
// (its disconnect is deliberately suppressed), firing the tier pill over an
// empty desktop with no mod actually running.
ipcMain.handle('bridge:status', () => ok({ connected: modHelloSeen }));

// Declared ABOVE every reader (trackAndSend here, armSocialWatchdog below). It
// used to sit under both, which is safe only while every reader happens to run
// later - `let` is not hoisted, so the day one of them is called during module
// evaluation it throws a TDZ ReferenceError and takes the main process down. That
// is the same shape as the bug that blanked the renderer twice, which is why the
// crash gate now covers electron/ at all.
let bridgeSawFriendsState = false;
function trackAndSend(msg) {
  const ok = bridge.send(msg);
  if (ok && msg && msg.type === 'friends_state') bridgeSawFriendsState = true;
  return ok;
}
ipcMain.handle('bridge:send',   (_e, msg) => ok(trackAndSend(msg)));
ipcMain.handle('presence:set-route',      (_e, route)    => { discordPresence.setRoute(route); return ok(null); });
ipcMain.handle('presence:set-dev-status', (_e, enabled)  => { discordPresence.setDevStatus(enabled); return ok(null); });
ipcMain.handle('presence:set-enabled',    (_e, enabled)  => { discordPresence.setEnabled(enabled); return ok(null); });
ipcMain.handle('presence:set-config', (_e, cfg)   => {
  const param1         = cfg.param1 || 'game_mode';
  const param2         = cfg.param2 || 'none';
  const showClientRpc  = cfg.showClientRpc !== false;
  const showInGameRpc  = cfg.showInGameRpc !== false;
  const showTimestamp  = cfg.showTimestamp !== false;

  // Update the desktop client presence to respect showClientRpc.
  discordPresence.setShowClientRpc(showClientRpc);

  // Forward config to the in-game mod so it knows which params to display
  // AND whether to publish presence at all. When showInGameRpc=false, the
  // mod clears its presence so Discord falls back to its default behaviour.
  bridge.send({
    type: 'presence_config',
    param1,
    param2,
    show_in_game:  showInGameRpc,
    show_timestamp: showTimestamp,
  });

  // Persist
  const current = loadConfig();
  saveConfig({ ...current, presenceConfig: cfg });
  return ok(null);
});

ipcMain.handle('notifmirror:get-status', () => {
  try { return ok(notificationMirror.getStatus()); } catch (e) { return fail(e); }
});
// Re-attempts RequestAccessAsync (via a fresh listener spawn) - what the
// Settings "Grant access" button calls after the user opens Windows'
// notification-access page. Harmless if the listener is already running.
ipcMain.handle('notifmirror:request-access', () => {
  try { notificationMirror.ensureRunning(); return ok(null); } catch (e) { return fail(e); }
});
// One-shot enumeration for the Settings "View all apps" page - not the
// long-running listener, just a Get-StartApps snapshot.
ipcMain.handle('notifmirror:list-all-apps', async () => {
  try { return ok(await notificationMirror.listAllApps()); } catch (e) { return fail(e); }
});
ipcMain.handle('notifmirror:get-default-browser', () => {
  try { return ok(notificationMirror.getDefaultBrowserName()); } catch (e) { return fail(e); }
});

function handleListRecordings() {
  const recordingsDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Excalibur', 'recordings'
  );
  try {
    const files = fs.existsSync(recordingsDir)
      ? fs.readdirSync(recordingsDir)
          .filter((f) => f.toLowerCase().endsWith('.wav'))
          .map((f) => {
            const fp   = path.join(recordingsDir, f);
            const stat = fs.statSync(fp);
            // 22050 Hz mono 16-bit WAV: duration = (size - 44) / (22050 * 2)
            const durationSeconds = Math.max(0, Math.round((stat.size - 44) / 44100));
            return { name: f, path: fp, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, durationSeconds };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, 10)
      : [];
    bridge.send({ type: 'list_recordings_response', files });
  } catch (e) {
    logError('list_recordings_request failed:', e);
    bridge.send({ type: 'list_recordings_response', files: [] });
  }
}

// The real mod announced itself. Now (not on the raw socket connect, which may
// be the loader stub's payload fetch) tell the renderer and push presence.
// Watchdog: a mod hello MUST be followed by a friends_state actually
// accepted by the game socket within 8s. If not, force the renderer to
// re-push and say so loudly - social must ALWAYS work.
let socialWatchdog = null;
function armSocialWatchdog() {
  clearTimeout(socialWatchdog);
  bridgeSawFriendsState = false;
  socialWatchdog = setTimeout(() => {
    if (bridgeSawFriendsState) return;
    logError('[Bridge] WATCHDOG: no friends_state reached the game within 8s of hello - forcing re-push');
    mainWindow?.webContents.send('bridge:connected');   // renderer re-push trigger
  }, 8000);
}

function handleModHello() {
  modHelloSeen = true;
  // THE launch-succeeded signal: the mod is up, so the launch is no longer
  // "in flight" and normal cleanup-on-close behaviour resumes from here. This
  // used to key off the game PROCESS appearing, which a crash-during-load
  // satisfied - see the note in the poll loop.
  launchGraceUntil = 0;
  logInfo('[Bridge] mod hello - notifying renderer, replaying media state');
  mainWindow?.webContents.send('bridge:connected');
  // Game (re)started → the Luma engine's 47800 server is coming up with it. The bridge
  // 'disconnected' handler stopped the engine client when the game closed, so restart it here
  // if a panel still wants it — otherwise a panel left open across a relaunch never reconnects.
  // Guarded: connect() no-ops while a socket already exists, so this can never double-connect.
  // Also gated on the feature flag: with Luma Looks off there is no 47800
  // server, and an ungated reconnect here spent the whole game session
  // retrying a connection that could never succeed.
  if (lumaPanelWants) {
    try {
      const cfgNow = loadConfig();
      if (cfgNow?.features?.['luma-looks']) lumaEngine.connect();
    } catch { /* retry loop handles it */ }
  }
  media.resend();
  armSocialWatchdog();
  // Push the saved presence config so the mod starts with the user's chosen
  // state instead of its hardcoded defaults.
  try {
    const c = loadConfig();
    const p = c.presenceConfig || {};
    bridge.send({
      type:           'presence_config',
      param1:         p.param1 || 'game_mode',
      param2:         p.param2 || 'none',
      show_in_game:   p.showInGameRpc !== false,
      show_timestamp: p.showTimestamp !== false,
    });
  } catch { /* best-effort */ }
  // Which loadout is live, for the setup tiles' MODS card. Resolved here
  // rather than in the renderer because config only stores the profile ID,
  // and the mod wants a name it can put on screen. No active profile means
  // the Standard loadout, which the mod labels itself.
  try {
    const c    = loadConfig();
    const id   = c.activeProfileId || null;
    const all  = listProfiles() || [];
    let name = '', kind = '';
    if (id) {
      const prof = all.find((p) => p.id === id);
      if (prof) { name = prof.name || ''; kind = prof.kind || 'profile'; }
    }
    // The whole shelf, so the MODS page can list every modpack and mark the
    // live one. Sent as a pipe-joined string rather than a JSON array: the
    // mod parses bridge messages by string scanning (ConfigWatcher), and a
    // delimited scalar needs no array support on that side. Pipes are
    // stripped from names first so the split can never be ambiguous.
    const list = all
      .map((p) => ({
        n: String(p.name || '').replace(/\|/g, ' ').trim(),
        k: p.kind === 'pack' ? 'pack' : 'profile',
        a: p.id === id,
      }))
      .filter((p) => p.n)
      .map((p) => `${p.a ? '*' : ''}${p.k === 'pack' ? '#' : ''}${p.n}`);
    bridge.send({ type: 'profile_info', name, kind, profiles: list.join('|') });
  } catch { /* best-effort */ }
  sendInstalledMods();
}

// Every installed mod and whether it is switched ON, for the pre-game MODS
// tile's switch list.
//
// ── Why the mod cannot work this out for itself ────────────────────────────
//
// In-game it reads BepInEx.Bootstrap.Chainloader.PluginInfos, which contains
// only mods that LOADED. A switched-off mod lives in plugins_disabled/ and was
// never loaded, so it is absent from that list entirely - meaning the tile could
// switch a mod off and then never show it again to switch back on. The whole
// point of a switch list is the off ones, so the desktop has to supply it.
//
// ── Names, not paths ───────────────────────────────────────────────────────
//
// Entries carry `baseName`, and `mod_toggle` sends the same name back for the
// desktop to resolve. Absolute paths are deliberately NOT sent: they contain the
// Windows username, this payload ends up in the BepInEx log, and that log gets
// pasted into Discord. diagnostics.cjs redacts the username for exactly this
// reason; there is no sense in shipping it over the bridge in the first place.
//
// Same pipe-joined encoding as profile_info above, for the same reason - the mod
// parses bridge messages by string scanning and needs no array support. Pipes
// are stripped from names so the split can never be ambiguous.
function sendInstalledMods() {
  try {
    if (!bridge) return;
    const c = loadConfig();
    if (!c.gamePath) { bridge.send({ type: 'installed_mods', mods: '' }); return; }
    const scan = scanMods(c.gamePath);
    const list = (scan.mods || [])
      // Data folders (GorillaShirts packs, wallpapers, custom maps) are not
      // mods and toggleMod REFUSES to move them. Offering a switch that
      // no-ops would be worse than not offering one.
      .filter((m) => !m.isDataFolder)
      .map((m) => ({
        n: String(m.displayName || m.baseName || m.fileName || '').replace(/\|/g, ' ').trim(),
        on: m.enabled !== false,
      }))
      .filter((m) => m.n)
      .map((m) => `${m.on ? '*' : ''}${m.n}`);
    bridge.send({ type: 'installed_mods', mods: list.join('|') });
  } catch { /* best-effort - the tile shows an empty list rather than failing */ }
}

// The loader stub asked for the encrypted core assembly. Stream it back as a
// single base64 line (the core never touches disk in the game folder). This is
// idempotent - the stub may re-request after a reconnect.
//
// Cache the base64 so a stuck loader's retry loop doesn't re-read + re-encode
// ~280 KB per request — but key the cache on the .pae's mtime. In dev the mod
// gets rebuilt constantly (`npm run watch:mods` / build:mod), and a lifetime
// cache meant every rebuild required a full app restart before the NEW core
// would stream to the next game launch.
// THE PAID HALVES DO NOT COME FROM THIS APP. Since 2026-08-01 the mod is three
// assemblies: the free core (on disk here, in the installer) plus Excalibur.Pro
// and Excalibur.ProPlus, which the SERVER decides to send based on the account's
// LIVE tier - never the JWT claim, which is seven days stale. They are held in
// memory and never written to disk, which is what stops one month's
// subscription becoming a permanent copy.
//
// The patcher receives one payload_response per assembly and waits for the one
// flagged `last` before loading any of them. Loading the core first and letting
// Pro arrive afterwards would not work: the core fixes its wristband tab list
// (and the rail's slot identity) while it boots, so a tab that turns up later
// gets no slot. All or nothing, in one burst.
let _corePayloadB64 = null;
let _corePayloadMtime = 0;
let _coreSignature = null;

// SERIALIZED. This handler used to be fired without await or an in-flight
// guard, and bridge.send always writes to whichever socket is CURRENT - so a
// slow attempt's responses (the tier fetch can take many seconds) could land
// on a newer connection, where the patcher took the first "last":true it saw
// and booted core-only. A paying account stranded on free by a race, while the
// log for the newer attempt happily said "streamed 3 assemblies". Requests now
// run one at a time, and each response echoes the patcher's `req` id so a
// cross-attempt response can never be mistaken for the current one.
let _payloadRequestChain = Promise.resolve();
function handlePayloadRequest(msg) {
  _payloadRequestChain = _payloadRequestChain
    .then(() => processPayloadRequest(msg))
    .catch((e) => logError('[ModPayload] payload_request chain error:', e.message));
  return _payloadRequestChain;
}

async function processPayloadRequest(msg) {
  // The patcher's per-attempt id, echoed on every response we send back.
  // An older patcher sends none; echoing nothing keeps its behaviour identical.
  const reqEcho = Number.isFinite(msg?.req) ? { req: msg.req } : {};
  try {
    // Anti-dump Layer 2: the patcher sets clean:false when it saw a debugger or a
    // known dump tool at boot. Honour it by serving the FREE core only - the paid
    // bytes then never enter a process someone is actively dumping. Absent (an
    // older patcher) is treated as clean, so this never withholds by surprise.
    //
    // IGNORED IN DEV. A developer testing paid features with dnSpy/ILSpy open (or
    // a debugger attached to the game) would otherwise have paid silently
    // withheld and read it as broken - the exact kind of invisible footgun this
    // project has been bitten by. `isDev` is `!app.isPackaged`, and a shipped
    // build is always packaged, so this bypass CANNOT exist in a user's build -
    // an attacker cannot flip it. The C#-side wipe (Layer 1) still runs in dev;
    // only the desktop's withhold is relaxed.
    const compromised = msg && msg.clean === false && !isDev;
    if (msg && msg.clean === false && isDev) {
      logInfo('[ModPayload] dev build: ignoring the compromised-launch signal so paid features can be tested with tools open');
    }
    if (compromised) {
      logError('[ModPayload] patcher reported this launch as compromised (debugger/dump tool) '
             + '- serving the free core only, withholding the paid assemblies');
      // SAY IT IN THE UI. This fires for anyone with dnSpy/ILSpy/x64dbg merely
      // OPEN in the background - and this app's users are BepInEx modders, so
      // that is common, innocent, and was previously invisible outside a log
      // nobody reads mid-launch. "Paid features missing, no idea why" reports
      // trace back here more than anywhere else.
      try { sendToWindow('mod:paid-withheld', { reason: 'compromised' }); } catch { /* UI only */ }
    }
    let mtime = 0;
    try { mtime = fs.statSync(path.join(modPayload.payloadDir(), 'excalibur-core.pae')).mtimeMs; } catch { }
    if (_corePayloadB64 === null || mtime !== _corePayloadMtime) {
      const buf = modPayload.readEncryptedCore();
      if (!buf) {
        bridge.send({ type: 'payload_response', ok: false, error: 'core payload not built', last: true, ...reqEcho });
        logError('[ModPayload] payload_request but excalibur-core.pae is missing');
        return;
      }
      _corePayloadB64 = buf.toString('base64');
      // Read alongside the bytes and cached on the same mtime key, so a rebuild
      // can never pair a fresh core with a stale signature (which the patcher
      // would reject, surfacing as "the mod stopped loading" with no clue why).
      _coreSignature = modPayload.readCoreSignature();
      _corePayloadMtime = mtime;
      logInfo(`[ModPayload] cached core payload (${buf.length} B, mtime ${mtime}`
            + `, ${_coreSignature ? 'signed' : 'UNSIGNED'}) for streaming`);
    }

    // Open the observe-only integrity session for this launch. Deliberately
    // BEFORE the payload goes out and not awaited into the critical path: the
    // point of opening it first is that a session which then never reports is
    // itself one of the four signals. It cannot delay or fail the launch.
    try {
      modIntegrity.openSession(auth.getToken(), app.getVersion())
        .catch((e) => logError('[integrity] could not open session:', e.message));
    } catch { /* telemetry never blocks a launch */ }

    // Ask the server what this account may load. Everything about this call
    // fails soft: no token, no network, a 500, a timeout - all of them come back
    // as an empty list and the player gets the free mod for this launch. The
    // free core is on disk, so a server blip must never mean no mod at all.
    let paid = [];
    if (!compromised) {
      try {
        paid = await modPayload.fetchTierAssemblies(auth.getToken());
      } catch (e) {
        logError('[ModPayload] tier fetch threw:', e.message);
      }
    }

    // ── WHO IS ASKING? (2026-08-12) ────────────────────────────────────────
    //
    // Everything above establishes what this ACCOUNT is entitled to. It says
    // nothing about what is on the other end of the socket, and until now the
    // answer was "anyone": the bridge handshake is a token in a user-readable
    // file, so a thirty-line script could read it, connect, send
    // payload_request, and walk off with the paid assemblies as plain DLLs
    // (the AES key is a constant in the patcher, which sits on disk in the game
    // folder). No reverse engineering, and the result is redistributable.
    //
    // So the paid half is now also gated on the PEER being Gorilla Tag itself,
    // matched by full executable path against the configured game folder.
    //
    // ONLY THE PAID ASSEMBLIES. The free core is served either way - it already
    // ships inside the installer, so withholding it protects nothing and would
    // turn any misfire of this check into "the mod did not load at all". The
    // worst case here is a launch with the free mod, which is the same degraded
    // state as being offline and is handled everywhere already.
    if (paid.length) {
      try {
        const verdict = await peerProcess.verifyPayloadPeer({
          peerPort:   bridge.peerPort(),
          bridgePort: 52137,
          // BOTH acceptable homes for the game: the configured install AND
          // wherever this launch actually deployed the patcher (a historical
          // build runs from the app's own versions dir, and comparing against
          // the config alone refused paid features on every such launch).
          gamePath:   (() => {
            try {
              const dirs = [loadConfig().gamePath || null, lastPatcherTarget || null];
              return [...new Set(dirs.filter(Boolean))];
            } catch { return lastPatcherTarget ? [lastPatcherTarget] : null; }
          })(),
        });
        if (!verdict.allow) {
          logError('[ModPayload] REFUSING to send the paid assemblies: the process asking for them '
                 + `is not Gorilla Tag (pid ${verdict.pid}, ${verdict.exePath || verdict.imageName || 'unknown'}). `
                 + `${verdict.reason}. Serving the free core only.`);
          // Deliberately LOG ONLY, no telemetry. api/mod-integrity.js accepts
          // features/tabs/assemblies and nothing else, so reporting this would
          // mean a new action, a new column and a change to an observe-only
          // pipeline the owner has explicitly frozen. Not worth coupling a
          // security refusal to that. The log line above is the record - and
          // one toast, so a legitimately entitled user hit by a false refusal
          // (stale gamePath after moving a Steam library, say) knows what to fix
          // instead of reporting "paid mods just don't load".
          try { sendToWindow('mod:paid-withheld', { reason: 'peer', exePath: verdict.exePath || verdict.imageName || null }); } catch { /* UI only */ }
          paid = [];
        } else if (!verdict.determinate) {
          // Not a refusal, but say it out loud. If this line is common in the
          // wild the check is not doing its job and needs revisiting - and that
          // is invisible unless it is logged.
          logInfo('[ModPayload] could not identify the process asking for the payload '
                + `(${verdict.reason}) - allowing, see peer-process.cjs for why this fails open`);
        } else {
          logInfo(`[ModPayload] peer verified as Gorilla Tag (pid ${verdict.pid})`
                + (verdict.weak ? ' by image name only - path was unreadable' : ''));
        }
      } catch (e) {
        // A throw here must never cost a paying customer their features. Same
        // posture as an indeterminate result.
        logError('[ModPayload] peer check threw, allowing:', e.message);
      }
    }

    // Say it in the UI, not only in the log. This is the one moment we KNOW
    // the running paid assemblies are stale, and it happens mid game-launch
    // when nobody is watching a log file.
    try {
      const mismatch = modPayload.getPaidBuildMismatch();
      if (mismatch) sendToWindow('mod:paid-build-stale', mismatch);
    } catch { /* diagnostic only, never blocks a launch */ }

    bridge.send({
      type: 'payload_response', ok: true,
      name: 'Excalibur.Core', data: _corePayloadB64, sig: _coreSignature,
      last: paid.length === 0, ...reqEcho,
    });
    for (let i = 0; i < paid.length; i++) {
      const a = paid[i];
      bridge.send({
        type: 'payload_response', ok: true,
        name: a.name, data: a.dataBase64, sig: a.signature || null,
        last: i === paid.length - 1, ...reqEcho,
      });
    }
    logInfo(`[ModPayload] streamed ${1 + paid.length} assembl${paid.length ? 'ies' : 'y'} to the patcher`);
  } catch (e) {
    bridge.send({ type: 'payload_response', ok: false, error: e.message, last: true, ...reqEcho });
    logError('[ModPayload] payload_request failed:', e.message);
  }
}

// REMOVED 2026-08-08 with the rest of FFmpeg: `handleCameraExport`, which
// turned the camera's keyframe JPEG dump into an MP4 (`ffmpeg.cjs`
// framesToMp4). It had already been unreachable since the SHOOT button
// replaced the export UI - `camera_export_ready` is only sent from
// CamKeyframes.ExportStop, which nothing in game can reach.
//
// The C# sender still exists in mod-pro/Features/CamKeyframes.cs. That is
// deliberate and harmless: it cannot fire, and an unanswered bridge message is
// a no-op. If the export UI ever comes back, BOTH halves need restoring, and
// the encoder is in git (see docs/WORKLOG.md 2026-08-08).

function handleAuthRequest() {
  const token = auth.getToken();
  // Send an authenticated response only if we have a valid JWT; otherwise
  // send an explicit denial so the mod knows to stay locked.
  const msg = {
    type:          'auth_response',
    jwt:           token || '',
    authenticated: !!token,
  };

  // Attach the dev/tester tier override if applicable. The mod gates the
  // override on JWT-verified dev/tester claims, so regular users' overrides
  // are ignored. We still gate here so we don't leak the preview pref for
  // non-eligible users.
  const override = resolveDevTierOverride(token);
  if (override) msg.dev_tier_override = override;

  bridge.send(msg);
}

// Resolves the active Preview-Tier-As selection for the in-game mod.
// Returns one of 'free' | 'pro' | 'pro_plus' | 'dev', or null when not
// applicable (regular user, no preview chosen, or no valid JWT).
function resolveDevTierOverride(jwtToken) {
  try {
    const tok = jwtToken || auth.getToken();
    if (!tok) return null;
    const payload = auth.parseJwtPayload(tok);
    if (!payload) return null;
    const isDev    = payload.app_role === 'developer';
    const isMaster = payload.is_master_tester === true;
    // Developers and MASTER testers only (2026-07-27). Plain testers used to
    // qualify via is_tester — so a stale devPreviewTier left over from the old
    // Tester Panel silently downgraded their IN-GAME tier (camera refused,
    // wristband tabs tier-filtered away) while the desktop showed full Pro+.
    if (!isDev && !isMaster) {
      // Heal the stale pref while we're here so cloud-sync stops carrying it.
      try {
        const cfg = loadConfig();
        if (cfg?.devPreviewTier) { cfg.devPreviewTier = null; saveConfig(cfg); }
      } catch { /* best-effort */ }
      return null;
    }

    const cfg = loadConfig();
    const preview = cfg?.devPreviewTier;
    if (!preview) return null;
    // Master testers can preview free/pro/pro_plus; only devs see 'dev'.
    const allowed = isDev
      ? ['free', 'pro', 'pro_plus', 'dev']
      : ['free', 'pro', 'pro_plus'];
    return allowed.includes(preview) ? preview : null;
  } catch {
    return null;
  }
}

// Pushes a live override update to the mod over the bridge. Called when
// the user flips the Preview-Tier-As dropdown in Settings. A null/empty
// `tier` field tells the mod to revert to the real JWT tier.
function pushDevTierOverride() {
  if (!bridge.isConnected) return;  // mod isn't running - nothing to push
  const override = resolveDevTierOverride();
  bridge.send({
    type:              'dev_tier_override',
    dev_tier_override: override || '',
  });
}

// Wristband FILES page. Two roots: 'obs' (where OBS writes recordings -
// the page's whole reason to exist) and 'excalibur' (our appdata dir).
// Items arrive pre-sorted - folders alphabetical, then files NEWEST first,
// each with a humanized age - so the mod just renders.
function handleBrowseDirectory(msg) {
  const appdataBase = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Excalibur'
  );
  const rootKey  = msg.root === 'excalibur' ? 'excalibur' : 'obs';
  const rootBase = rootKey === 'obs' ? detectObsOutputFolder() : path.join(appdataBase, 'recordings');
  const requested = msg.path && msg.path.trim() ? msg.path.trim() : rootBase;

  // Security: stay inside the chosen root.
  let resolved  = path.resolve(requested);
  const rootNorm = path.resolve(rootBase);
  if (!resolved.startsWith(rootNorm)) resolved = rootNorm;

  const fmtAge = (ms) => {
    const sec = Math.max(0, (Date.now() - ms) / 1000);
    if (sec < 60) return 'now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    return `${Math.floor(sec / 86400)}d`;
  };

  try {
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    const items = fs.readdirSync(resolved)
      .map((name) => {
        try {
          const stat = fs.statSync(path.join(resolved, name));
          return {
            name,
            isDir: stat.isDirectory(),
            size: stat.isDirectory() ? 0 : stat.size,
            age: stat.isDirectory() ? '' : fmtAge(stat.mtimeMs),
            _mtime: stat.mtimeMs,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        if (a.isDir) return a.name.localeCompare(b.name);
        return b._mtime - a._mtime;   // recordings: newest on top
      })
      .map(({ _mtime, ...item }) => item);

    const parent = resolved !== rootNorm ? path.dirname(resolved) : '';
    bridge.send({ type: 'browse_directory_response', root: rootKey, path: resolved, parent, items });
  } catch (e) {
    logError('browse_directory_request failed:', e);
    bridge.send({ type: 'browse_directory_response', root: rootKey, path: resolved, parent: '', items: [] });
  }
}

// Is `target` inside `root`? Uses path.relative, NOT startsWith.
//
// `abs.startsWith(root)` is a prefix test on a STRING, and directory names are
// not delimited in a string. So a root of `C:\Games\GorillaTag` matched
// `C:\Games\GorillaTagOLD\...` and `...\GorillaTag-backup\...`, both of
// which are exactly the folders a person ends up with when they move or
// duplicate a Steam library - which is the entire situation the mod-transfer
// feature exists to handle. Several checks in this file were written that way.
//
// Returns false for `target === root` as well: every caller here means "a file
// or folder UNDER this directory", never the directory itself.
function isInsideDir(root, target) {
  if (!root || !target) return false;
  let rel;
  try { rel = path.relative(path.resolve(root), path.resolve(target)); }
  catch { return false; }
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

ipcMain.handle('util:username', () => {
  try {
    const os = require('os');
    const name = os.userInfo().username || process.env.USERNAME || process.env.USER || 'there';
    return ok(name);
  } catch (e) {
    return fail(e);
  }
});

// ── Mod update checker ───────────────────────────────────────────────────────

// Delegates to github-repo.cjs rather than making its own request.
//
// Both of these ask api.github.com the SAME question about the SAME repos, and
// unauthenticated GitHub allows the whole machine 60 requests an hour. When they
// each kept a private cache, checking updates for a dozen installed mods and
// then reading two of them on the Download page could spend more than half the
// hour's budget on duplicate answers - and the symptom is not an error, it is
// the mod details quietly going blank for everyone until the hour rolls over.
//
// One cache, warmed by whichever surface asks first. The TTL is longer than the
// hour this used to keep, which is fine: an update notice arriving six hours
// late is not a problem worth a rate limit.
async function fetchLatestGithubVersion(gitPath) {
  try {
    const info = await githubRepo.fetchRepoInfo(gitPath);
    const tag = info?.ok ? (info.release?.tag || '') : '';
    return tag.replace(/^v/i, '') || null;
  } catch {
    return null;
  }
}

function normalizeName(s) {
  return (s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// True when version `a` is strictly newer than `b` (numeric, dot/dash/plus split).
function verGt(a, b) {
  const pa = String(a).split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

ipcMain.handle('mods:check-updates', async (_e, mods) => {
  try {
    const registry = downloader.loadRegistry();
    const regMods  = registry.bepinex_mods || [];
    const cfg      = loadConfig();
    const recorded = cfg.modVersions || {};
    const results  = {};

    await Promise.allSettled(mods.map(async (mod) => {
      const modNorm  = normalizeName(mod.displayName || mod.baseName);
      const baseKey  = (mod.baseName || '').replace(/\.dll$/i, '');
      const baseNorm = normalizeName(baseKey);

      const match = regMods.find((r) => {
        const rn = normalizeName(r.name);
        return rn === modNorm || rn === baseNorm;
      });
      if (!match?.gitPath) return;

      const latestVersion = await fetchLatestGithubVersion(match.gitPath);
      if (!latestVersion) return;

      // Prefer the version WE recorded at install/update time. Fall back to the
      // DLL's PE version only when it's a real semver: strip build metadata (the
      // "+<git-hash>" suffix) and leading junk, and reject all-zero like "0.0.0"
      // (these mods stamp "0.0.0+<hash>", which must NOT read as an installed
      // version or every mod falsely shows "update available"). Else = unknown.
      const recVer = recorded[mod.baseName] || recorded[baseKey] || null;
      const peClean = (mod.version || '').replace(/^[v.\s]+/i, '').split('+')[0].trim();
      const peUsable = peClean && !/^0(\.0)*$/.test(peClean);
      const installedVersion = recVer || (peUsable ? peClean : null);
      const hasUpdate = !!(installedVersion && verGt(latestVersion, installedVersion));

      results[mod.baseName] = {
        registryName:   match.name,
        latestVersion,
        currentVersion: installedVersion || '',
        installedKnown: !!installedVersion,
        hasUpdate,
        gitPath:        match.gitPath,
        downloadUrl:    match.downloadUrl,
      };
    }));

    return ok(results);
  } catch (e) {
    return fail(e);
  }
});

// Record the version the app just installed/updated for a mod (baseName → version).
ipcMain.handle('mods:set-installed-version', (_e, { baseName, version }) => {
  try {
    const cfg = loadConfig();
    const key = String(baseName || '').replace(/\.dll$/i, '');
    if (!key) return fail(new Error('baseName required'));
    const mv = { ...(cfg.modVersions || {}), [key]: String(version || '') };
    saveConfig({ ...cfg, modVersions: mv });
    return ok(mv);
  } catch (e) { return fail(e); }
});

// Update a single mod to its latest release: re-download + overwrite in place,
// then record the new version. mod = { baseName, name, downloadUrl, version, currentPath }.
ipcMain.handle('mods:update', async (_e, { gamePath, mod }) => {
  try {
    if (isGorillaTagRunning()) return { ok: false, error: 'Close Gorilla Tag before updating mods.', code: 'GAME_RUNNING' };
    if (!gamePath || !mod?.downloadUrl) return fail(new Error('Missing update info'));
    await downloader.updateMod(gamePath, mod);
    const cfg = loadConfig();
    const key = String(mod.baseName || mod.name || '').replace(/\.dll$/i, '');
    if (key && mod.version) {
      const mv = { ...(cfg.modVersions || {}), [key]: String(mod.version) };
      saveConfig({ ...cfg, modVersions: mv });
    }
    return ok({ baseName: key, version: mod.version });
  } catch (e) { return fail(e); }
});

// ── Mod downloader IPC ────────────────────────────────────────────────────────

// `mainWindow?.webContents.send(...)` guards the WINDOW but not its webContents,
// so a send during teardown (window closing, or a renderer reload mid-install)
// throws from inside a promise callback and surfaces as an unhandled rejection
// in the main process. An install event is best-effort by nature: if the
// renderer is gone there is nobody to tell.
function sendToWindow(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch { /* renderer went away mid-install */ }
}

ipcMain.handle('downloader:registry', () => {
  try { return ok(downloader.loadRegistry()); } catch (e) { return fail(e); }
});

ipcMain.handle('downloader:detect-loader', (_e, gamePath) => {
  try { return ok(downloader.detectLoader(gamePath)); } catch (e) { return fail(e); }
});

ipcMain.handle('downloader:installed', (_e, gamePath) => {
  try { return ok(downloader.getInstalledMods(gamePath)); } catch (e) { return fail(e); }
});

// What GitHub says about a catalogue mod: repo facts, README, latest release.
// Cached hard (see github-repo.cjs) because the whole Download page shares one
// 60-requests-per-hour budget with the update checker. Resolves to ok(...) with
// { ok:false, error } inside it on failure rather than rejecting - the modal
// treats "GitHub could not be reached" as a state to render, not an error.
ipcMain.handle('downloader:repo-info', async (_e, gitPath) => {
  try { return ok(await githubRepo.fetchRepoInfo(gitPath)); } catch (e) { return fail(e); }
});

// AWAITED install. It still streams progress and still emits `downloader:done`
// (CommunityView's pack import waits on that event), but it now also RESOLVES
// with the real outcome.
//
// It used to return `ok(true)` the instant the download started, which broke two
// things that both read as if they were handled:
//
//  1. `await gtmm.downloader.install(...)` in a dependency loop resolved on the
//     IPC acknowledgement, not on completion - so a mod and its dependencies all
//     downloaded at once and could land in any order, and two `done` events
//     arriving together made their profile writes overwrite each other.
//  2. The GAME_RUNNING refusal below returned an error that no caller could act
//     on, because the renderer had nothing to await and no `done` event was ever
//     emitted. The Download page's row sat on "Installing..." forever, with no
//     error, and could not be retried.
//
// A slow install does not block other IPC - `ipcMain.handle` is async - so the
// only behavioural cost is that concurrent installs of the SAME mod now
// serialise per caller, which is what we want anyway.
ipcMain.handle('downloader:install', async (_e, { gamePath, mod } = {}) => {
  if (!mod || !mod.name) return { ok: false, error: 'No mod was supplied to install.' };
  if (isGorillaTagRunning()) {
    return { ok: false, error: 'Close Gorilla Tag before installing mods.', code: 'GAME_RUNNING' };
  }
  try {
    await downloader.installMod(gamePath, mod, {
      onProgress: (msg) => sendToWindow('downloader:progress', { mod: mod.name, msg }),
    });
    sendToWindow('downloader:done', { mod: mod.name, ok: true });
    return ok(true);
  } catch (e) {
    logError('downloader:install failed:', e);
    sendToWindow('downloader:done', { mod: mod.name, ok: false, error: e.message });
    return fail(e);
  }
});

ipcMain.handle('downloader:uninstall', (_e, { gamePath, mod } = {}) => {
  if (!mod || !mod.name) return { ok: false, error: 'No mod was supplied to uninstall.' };
  if (isGorillaTagRunning()) {
    return { ok: false, error: 'Close Gorilla Tag before uninstalling mods.', code: 'GAME_RUNNING' };
  }
  try {
    const res = downloader.uninstallMod(gamePath, mod);
    // Tell the rest of the app the plugins folder changed. Install already did
    // this; uninstall did not, so removing a mod here left the Mods page still
    // listing it (toggling it then failed with "Mod not found") and left a
    // profile member pointing at a file that no longer exists. App.jsx's
    // listener rescans on this event, and a successful non-empty rescan runs
    // purgeMissingMembers, so both heal themselves.
    //
    // `action` distinguishes it from an install: the Download page must NOT add
    // an uninstalled mod to the user's profiles.
    if (res && res.ok) sendToWindow('downloader:done', { mod: mod.name, ok: true, action: 'uninstall' });
    return res;
  } catch (e) { return fail(e); }
});
