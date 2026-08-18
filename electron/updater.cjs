// App auto-update. One feed, two channels, and a policy the user controls.
//
// ── The channel is decided HERE, at runtime, not at build time ──────────────
//
// There is ONE installer and ONE feed repo (scripts/release-config.mjs). What
// separates a tester from a regular user is which channel file their app asks
// for:
//
//   tester        channel 'beta',   allowPrerelease true
//                 -> reads beta.yml off the newest release, prereleases included
//   everyone else channel 'latest', allowPrerelease false
//                 -> resolves through GitHub /releases/latest, which EXCLUDES
//                    prereleases, so a tester-only build is invisible to them
//
// Deciding this at runtime rather than baking it into the build is the whole
// reason the system is not a mess: nobody needs a special installer, nobody
// reinstalls when they are made a tester, and there is no per-person repo. The
// signal is the `is_tester` / `app_role` claim on the RS256 JWT, which is
// server-signed and locally signature-verified (electron/auth.cjs), so a user
// cannot promote themselves onto the tester channel by editing a config file.
//
// Consequence worth knowing: at cold start the token has not been read yet, so
// the channel is unknown. The first check is therefore DEFERRED until the
// channel is known (see `setChannelFromAuth`), rather than firing on the stable
// channel and then correcting itself. Firing early would show a tester the
// stable build, and then a second, different update prompt seconds later.
//
// If someone stops being a tester while running a build newer than stable, they
// simply stay on it: electron-updater will not downgrade, and silently rolling
// a user back to older code is worse than leaving them ahead.
//
// ── The policy ──────────────────────────────────────────────────────────────
//
//   'ask'  (default)  autoDownload OFF. The renderer is told an update exists
//                     and shows the prompt with the changelog. Nothing is
//                     downloaded until the user says yes. Later dismisses for
//                     this session only.
//   'auto'            download and install without asking.
//
// `mandatory` releases (src/lib/whats-new.js) are installed even on 'ask'. The
// prompt still appears and still explains itself; it just has no Later.
//
// ── State machine the renderer sees via `updater:state` IPC pushes ─────────
//
//   idle          nothing pending
//   checking      contacting the feed
//   up-to-date    feed responded, nothing newer on this channel
//   available     an update exists. On 'ask' this is a RESTING state and waits
//                 for a decision; on 'auto' the download starts immediately
//   downloading   { percent, transferred, total, bps }
//   downloaded    on disk, ready to install
//   error         { message }
//   no-feed       no app-update.yml (electron-packager build) - not an error
//   dev           unpackaged build, updater is a no-op

const { app, ipcMain, BrowserWindow } = require('electron');
const fs   = require('fs');
const path = require('path');
const { loadConfig, saveConfig } = require('./config.cjs');
// The decisions live in a module with no Electron in it, so they can be unit
// tested (electron/update-policy.test.cjs). This file is the plumbing.
const {
  BETA_CHANNEL, STABLE_CHANNEL,
  resolveChannel, normalizePolicy, shouldAutoInstall,
  classifySeverity, isNoFeedError,
} = require('./update-policy.cjs');

// How long a graceful quit gets before we force the process down during an
// update. Short on purpose: the installer is ALREADY running by then (see
// install()), so every extra second is a second it can fail in. Long enough
// that a normal clean shutdown finishes first and this never fires.
const INSTALL_FORCE_EXIT_MS = 3000;

let _autoUpdater = null;
let _mainWindow  = null;
let _status = { state: 'idle' };
let _logger = null;

// Set by main.js from the persisted config, then by the renderer when the user
// changes it in Settings. 'ask' is the default and the value used if the config
// read fails, because the safe failure for "should I install software without
// asking" is to ask.
let _policy = 'ask';

// Resolved from the verified JWT. `null` means not known yet, which is NOT the
// same as 'latest': see the deferred-first-check note above.
let _channel = null;
let _firstCheckDone = false;
let _firstCheckTimer = null;

// Set by the renderer when a mandatory version is on offer. The renderer is the
// side that has the changelog (it fetches /api/changelog), so it tells us, and
// this flag then overrides 'ask' for the download+install decision.
let _mandatory = false;

// Armed by updater:download-and-install so the single update-downloaded handler
// finishes the job. Declared up here with the rest of the module state: it is
// referenced inside an IPC handler defined further down, and `let` is in TDZ
// until its declaration runs, which lint:crash's no-use-before-define catches.
let _installWhenReady = false;

// Periodic re-check. FIVE MINUTES during the closed beta (owner call
// 2026-08-04), down from the six hours electron-updater recommends.
//
// Six hours is tuned for a shipped product that updates every few weeks. This
// one currently ships several builds a day to eight testers, and a tester
// sitting on a build for six hours after a fix landed is six hours of reports
// about something already fixed. The cadence should match how often the thing
// actually changes.
//
// Why this is cheap: a check is a fetch of releases.atom plus beta.yml, a few
// KB, served by GitHub at no cost to us. It goes from ~4 checks a day to ~288,
// which is about 35 KB an hour per person - less than one album-art thumbnail.
// Nothing is DOWNLOADED by a check; autoDownload is off in both policies and
// the installer is only fetched after the user agrees.
//
// Why it does not nag: `dismissed` in UpdatePrompt.jsx is session-only React
// state, so pressing Later silences that version for the rest of the app
// session no matter how many times the check runs behind it. Without that this
// interval would put the modal back every five minutes, which is why it was
// checked before changing this number rather than after.
//
// PUT THIS BACK UP at public launch - the argument above is entirely about a
// handful of testers during a period of rapid change.
const RECHECK_INTERVAL_MS = 5 * 60 * 1000;
// Wait this long after the channel is known before the first check, so it does
// not compete with startup work (Sentry init, bridge spin-up, config load).
const FIRST_CHECK_DELAY_MS = 8 * 1000;
// If auth never resolves (someone who never signs in), check anyway on the
// stable channel rather than never checking at all. A signed-out user is not a
// tester by definition, so stable is the correct guess once we accept we have
// to guess.
const AUTH_WAIT_TIMEOUT_MS = 45 * 1000;

function isDev() { return !app.isPackaged; }

// electron-packager builds do NOT inject app-update.yml, which the GitHub
// provider requires. Without it every checkForUpdates() throws and the renderer
// shows a confusing "Update check failed". Detect it up front and treat the
// build as having no update channel, the same UX as a dev build.
function hasUpdateFeed() {
  try {
    const candidates = [
      path.join(process.resourcesPath || '', 'app-update.yml'),
      path.join(app.getAppPath(), 'app-update.yml'),
    ];
    return candidates.some((p) => p && fs.existsSync(p));
  } catch { return false; }
}

function setStatus(next) {
  // The channel and policy ride along on every push so the renderer never has
  // to ask for them separately and can never render a prompt that disagrees
  // with what this module is about to do.
  _status = { ...next, channel: _channel, policy: _policy };
  try { _mainWindow?.webContents?.send('updater:state', _status); } catch { /* window may be gone */ }
}

function pushProgress(p) {
  setStatus({
    state: 'downloading',
    percent: Math.round(p.percent || 0),
    transferred: p.transferred || 0,
    total: p.total || 0,
    bps: Math.round(p.bytesPerSecond || 0),
    version: _status.version,
  });
}

// True when this update should proceed with no user interaction. The rule itself
// is in update-policy.cjs; this just binds it to the current module state.
function shouldInstallWithoutAsking() {
  return shouldAutoInstall({ policy: _policy, mandatory: _mandatory });
}

function attachHandlers(autoUpdater) {
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));

  autoUpdater.on('update-not-available', (info) => setStatus({
    state: 'up-to-date',
    currentVersion: app.getVersion(),
    latestVersion: info?.version || app.getVersion(),
  }));

  autoUpdater.on('update-available', (info) => {
    setStatus({
      state: 'available',
      version: info?.version,
      releaseDate: info?.releaseDate,
      // electron-updater hands us the GitHub release body. The renderer prefers
      // /api/changelog (structured, correctable after the fact) and falls back
      // to this when the API is unreachable, so a user is never asked to accept
      // an update that cannot say what it is.
      releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
      severity: classifySeverity(app.getVersion(), info?.version),
    });
    // autoDownload is off (see init), so on 'auto' the download is started here
    // explicitly. On 'ask' nothing happens until the renderer calls download().
    if (shouldInstallWithoutAsking()) startDownload();
  });

  autoUpdater.on('download-progress', pushProgress);

  // ONE listener for this event. There used to be a second one registered in
  // init() for the download-and-install path, which meant two independent
  // timers could both call quitAndInstall for the same update.
  autoUpdater.on('update-downloaded', (info) => {
    setStatus({
      state: 'downloaded',
      version: info?.version,
      releaseDate: info?.releaseDate,
      severity: classifySeverity(app.getVersion(), info?.version),
    });
    // Two ways to end up installing without another click:
    //   - policy 'auto' (or a mandatory release): the user asked not to be
    //     involved, so finish rather than leaving a pill they have to notice
    //   - the user already pressed Update in the prompt, which armed
    //     _installWhenReady, so waiting for a second click would be nagging
    const armed = _installWhenReady;
    _installWhenReady = false;
    if (armed || shouldInstallWithoutAsking()) {
      // The renderer gets the 'downloaded' push first and paints its brief
      // "restarting" state, so this does not read as a crash.
      setTimeout(() => install({ silent: shouldInstallWithoutAsking() }), 1200);
    }
  });

  autoUpdater.on('error', (err) => {
    _logger?.error?.('updater error:', err);
    if (isNoFeedError(err)) { setStatus({ state: 'no-feed' }); return; }
    setStatus({ state: 'error', message: err?.message || String(err) });
  });
}

// ── Policy + channel ────────────────────────────────────────────────────────

function setPolicy(v) {
  const next = normalizePolicy(v);
  _policy = next;
  try {
    if (_autoUpdater) {
      // autoDownload stays OFF in both modes. 'auto' downloads via the explicit
      // startDownload() in the update-available handler, which keeps one code
      // path for "start downloading" and means a policy change mid-session
      // cannot leave the library and this module disagreeing.
      _autoUpdater.autoDownload = false;
      // If an update is already sitting downloaded and the user switches to
      // 'auto', honour it on quit rather than requiring another interaction.
      _autoUpdater.autoInstallOnAppQuit = next === 'auto';
    }
  } catch { /* library not loaded (dev / no-feed) */ }
  return _policy;
}

// Called by main.js once the verified JWT claims are available. `user` is the
// object from auth.getStatus().user, or null when signed out.
//
// Testers AND developers ride the beta channel: a developer running a packaged
// build wants to see what testers see. Developers are separately excluded from
// the auto-popup changelog in WhatsNewToast, which is the annoying part, not
// this.
function setChannelFromAuth(user) {
  const next = resolveChannel(user);
  const changed = next !== _channel;
  _channel = next;

  try {
    if (_autoUpdater) {
      _autoUpdater.channel = next;
      // allowPrerelease is what makes the provider read releases.atom (which
      // includes prereleases) instead of /releases/latest (which does not).
      // Without it, setting channel='beta' alone would still never see a
      // tester build.
      _autoUpdater.allowPrerelease = next === BETA_CHANNEL;
      // Never move someone backwards. If a tester loses tester status while
      // running a build ahead of stable, they keep it.
      _autoUpdater.allowDowngrade = false;
    }
  } catch { /* library not loaded */ }

  _logger?.info?.(`updater: channel = ${next} (${user ? 'signed in' : 'signed out'})`);
  // Re-push so the renderer's copy of `channel` is correct even if no check
  // runs (dev builds, no-feed builds).
  setStatus(_status);

  if (!_firstCheckDone) scheduleFirstCheck();
  else if (changed) checkNow();   // moved channels mid-session, re-resolve
}

function scheduleFirstCheck() {
  if (_firstCheckDone || isDev() || !_autoUpdater) return;
  clearTimeout(_firstCheckTimer);
  _firstCheckTimer = setTimeout(() => {
    _firstCheckDone = true;
    checkNow();
    setInterval(() => checkNow(), RECHECK_INTERVAL_MS);
  }, FIRST_CHECK_DELAY_MS);
}

function checkNow() {
  if (isDev() || !_autoUpdater) return Promise.resolve({ ok: false, dev: true });
  return _autoUpdater.checkForUpdates()
    .then(() => ({ ok: true }))
    .catch((e) => {
      if (isNoFeedError(e)) { setStatus({ state: 'no-feed' }); return { ok: false, error: 'no_feed' }; }
      setStatus({ state: 'error', message: e?.message || String(e) });
      return { ok: false, error: e?.message || String(e) };
    });
}

function startDownload() {
  if (isDev() || !_autoUpdater) return Promise.resolve({ ok: false, dev: true });
  if (_status.state === 'downloading' || _status.state === 'downloaded') {
    return Promise.resolve({ ok: true, already: true });
  }
  return _autoUpdater.downloadUpdate()
    .then(() => ({ ok: true }))
    .catch((e) => {
      setStatus({ state: 'error', message: e?.message || String(e) });
      return { ok: false, error: e?.message || String(e) };
    });
}

function install({ silent = false } = {}) {
  if (isDev() || !_autoUpdater) return { ok: false, dev: true };
  if (_status.state !== 'downloaded') return { ok: false, error: 'no_update_ready' };

  // ── isSilent MUST be true. ───────────────────────────────────────────────
  //
  // This used to pass `false`, with a comment claiming it would "show the
  // installer briefly so the user has visual confirmation". That is not what
  // false does. Verified in electron-updater's NsisUpdater.doInstall: the only
  // thing isSilent controls is whether `/S` is appended to the installer
  // arguments. Without it, NSIS runs with its full UI - and our installer is
  // configured `oneClick: false` with `allowToChangeInstallationDirectory: true`
  // (package.json build.nsis), which means a multi-page wizard with a directory
  // picker.
  //
  // So every single update, on both policies, would have stopped and demanded
  // the user click through an install wizard. On 'auto' that is absurd: the
  // whole point is that they asked not to be involved. On 'ask' it means
  // pressing "Update now" gets you a wizard rather than an update.
  //
  // Silent is safe here because `perMachine: false`, so this is a per-user
  // install and needs no elevation - nothing triggers a UAC prompt.
  // isForceRunAfter=true relaunches into the new version afterwards, so the
  // visible behaviour is: window closes, comes back on the new version.
  // ── We are RACING the installer from the next line onward ────────────────
  //
  // electron-updater does NOT quit and then install. Read BaseUpdater.quitAndInstall:
  //
  //     const isInstalled = this.install(isSilent, ...)   // spawns the installer
  //     if (isInstalled) setImmediate(() => this.app.quit())
  //
  // The NSIS installer is spawned FIRST and app.quit() is merely requested
  // afterwards. So from the moment we call this, a separate process is already
  // trying to delete our install directory while we are still running out of it.
  //
  // On Windows the lock on a running .exe is only released when the PROCESS
  // EXITS - closing windows is not enough. And the installer runs with /S, so
  // when it finds the files locked it does not wait and it does not retry: it
  // aborts with "Failed to uninstall old application files. Please try running
  // the installer again.: 2" and the user stays on the old version forever.
  //
  // That is exactly what happened on 2026-08-15. Reproduced on a clean machine:
  // 1.0.1 -> 1.0.3 silently is EXIT 0 and upgrades fine with nothing running,
  // and fails with that dialog when a single file in the install dir is held
  // open. The trigger that day was the API outage - the app could not finish
  // shutting down while a request hung - but the race is permanent and any
  // slow teardown re-arms it.
  //
  // So: tear down everything that can hold the process open, then guarantee
  // the exit rather than hoping for it.
  try {
    // A hidden or tray-owned window keeps 'window-all-closed' from firing,
    // which is the documented deadlock in main.js that once left the process
    // alive with no window and no tray icon. Destroy rather than close: close
    // is interceptable, and our own close handler deliberately intercepts it
    // to hide to tray.
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.destroy(); } catch { /* already gone */ }
    }
  } catch { /* never let teardown stop the update */ }

  _autoUpdater.quitAndInstall(true, true);

  // Last resort. If a graceful quit stalls - a pending request, a lingering
  // handle, a listener that never settles - force the process down so the
  // installer wins the race instead of losing it. app.exit() skips 'before-quit'
  // entirely, which is the point: at this stage the update matters more than
  // an orderly shutdown, and the installer relaunches us straight after.
  setTimeout(() => {
    try { app.exit(0); } catch { /* already exited, which is the good case */ }
  }, INSTALL_FORCE_EXIT_MS).unref?.();

  return { ok: true, silent };
}

// ── IPC ─────────────────────────────────────────────────────────────────────

function registerIpc() {
  ipcMain.handle('updater:status', () => _status);
  ipcMain.handle('updater:check',  () => checkNow());

  ipcMain.handle('updater:install', () => install());

  // One call, so the renderer can accept an update in a single round trip:
  // download and then install as soon as it lands, without waiting for a
  // 'downloaded' push and calling back.
  ipcMain.handle('updater:download-and-install', async () => {
    if (_status.state === 'downloaded') return install();
    // Armed BEFORE the download starts. downloadUpdate() can resolve after the
    // update-downloaded event has already fired, so arming afterwards would
    // race and leave the user staring at a finished download that never
    // installs.
    _installWhenReady = true;
    const r = await startDownload();
    if (!r.ok) { _installWhenReady = false; return r; }
    return { ok: true, installing: true };
  });

  ipcMain.handle('updater:set-config', (_e, cfg = {}) => {
    let policyChanged = false;
    if (typeof cfg.policy === 'string') { setPolicy(cfg.policy); policyChanged = true; }
    // Legacy shape from the old Settings toggle, kept so an in-flight renderer
    // build cannot silently stop working: autoInstall true meant 'auto'.
    else if (typeof cfg.autoInstall === 'boolean') {
      setPolicy(cfg.autoInstall ? 'auto' : 'ask');
      policyChanged = true;
    }
    if (typeof cfg.mandatory === 'boolean') _mandatory = cfg.mandatory;

    // PERSIST it. The previous version of this module kept the value in a plain
    // variable and its comment claimed it survived restart. It did not: every
    // launch reset to the default, so anyone who turned auto-install off found
    // it back on the next time they opened the app, with nothing to indicate
    // why. The setting is only meaningful if it is remembered.
    if (policyChanged) {
      try {
        const c = loadConfig();
        if (c.updatePolicy !== _policy) saveConfig({ ...c, updatePolicy: _policy });
      } catch (e) {
        _logger?.error?.('updater: could not persist updatePolicy:', e?.message || e);
      }
    }
    return { ok: true, policy: _policy, channel: _channel };
  });

  ipcMain.handle('updater:get-config', () => ({
    policy: _policy,
    channel: _channel,
    // Kept for the old renderer contract.
    autoInstall: _policy === 'auto',
  }));
}

// ── Init ────────────────────────────────────────────────────────────────────

function init({ logger, policy } = {}) {
  _logger = logger;
  registerIpc();
  if (typeof policy === 'string') setPolicy(policy);

  if (isDev()) {
    setStatus({ state: 'dev' });
    logger?.info?.('updater: dev build, auto-update disabled');
    return;
  }
  if (!hasUpdateFeed()) {
    setStatus({ state: 'no-feed' });
    logger?.info?.('updater: no app-update.yml present - auto-update disabled');
    return;
  }
  try {
    // Lazy-require so dev runs never load electron-updater.
    const { autoUpdater } = require('electron-updater');
    _autoUpdater = autoUpdater;
    if (logger) autoUpdater.logger = logger;

    // OFF in both policies. Every download is started explicitly, so there is
    // exactly one place that decides to spend someone's bandwidth. This is a
    // behaviour change: it used to be true unconditionally, which meant an
    // 'ask' user had already paid for the download before being asked.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = _policy === 'auto';
    autoUpdater.allowDowngrade = false;

    attachHandlers(autoUpdater);

    // No check yet. setChannelFromAuth() starts it once the channel is known.
    // The fallback below covers "auth never resolves", so an app that is never
    // signed in still updates.
    setTimeout(() => {
      if (_channel === null && !_firstCheckDone) {
        logger?.info?.('updater: auth never resolved, defaulting to the stable channel');
        setChannelFromAuth(null);
      }
    }, AUTH_WAIT_TIMEOUT_MS);
  } catch (e) {
    setStatus({ state: 'error', message: `init_failed: ${e?.message || e}` });
    logger?.error?.('updater init failed:', e);
  }
}

// Called after createWindow() so push events can reach the renderer.
function setMainWindow(win) {
  _mainWindow = win;
  // Re-emit current status to the freshly-attached window so the UI can paint
  // immediately (e.g. if a check completed before the renderer subscribed).
  try { win?.webContents?.send('updater:state', _status); } catch { /* nbd */ }
}

module.exports = {
  init,
  setMainWindow,
  setChannelFromAuth,
  setPolicy,
  getChannel: () => _channel,
  getPolicy:  () => _policy,
};
