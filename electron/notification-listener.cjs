'use strict';

// Windows notification mirror. Spawns notification-listener.ps1, a small
// PowerShell/WinRT listener that reports EVERY toast notification Windows
// shows (Discord, and anything else the user allow-lists). This module owns
// the allow-list filter and forwards only permitted notifications over the
// bridge to the in-game NotificationMirrorModule, which shows them as a toast.
//
// The listener process applies no filtering of its own - see the .ps1's own
// header comment - so this module can also track every app NAME it has ever
// seen (regardless of allow-list state), which is what powers the "add an
// app" picker in Settings: pick from apps that have actually notified you,
// rather than guessing at names.

const path = require('path');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const { logInfo, logWarn, logError } = require('./logger.cjs');
const bridge = require('./bridge.cjs');

// Where powershell.exe can ACTUALLY read the script from. In a packaged build
// __dirname is inside app.asar, a virtual filesystem only Electron's patched
// fs understands - an external powershell.exe handed that path fails with
// "the argument does not exist", and the exit handler restarts it every 5s,
// forever. Same bug and same fix as media.cjs's agentScriptPath (0.9.3):
// build.asarUnpack copies the script to app.asar.unpacked/, and this rewrite
// points there. In dev there is no asar in the path and the replace no-ops.
const SCRIPT_PATH = path.join(__dirname, 'notification-listener.ps1')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const RESTART_DELAY_MS = 5000;
const MAX_RECENT_APPS = 40;

// A storm guard, and the reason it is here rather than in the game: an in-game
// toast takes ~5s to fade in, hold and fade out, so more than a dozen a minute
// can never actually be READ. NotificationMirrorModule queues what it cannot
// show yet and that queue has no bound, so a burst does not just spam - it
// keeps firing long after the burst is over.
//
// This is deliberately a RATE limit and not a de-duplicator. Dropping repeats
// by content would eat a real second message that happens to say the same
// thing; a rate cap only ever bites when nobody could have read them anyway.
// Nothing should reach it now that the restart loop is fixed - it exists so
// that the next bug upstream is an entry in the log instead of an unusable
// headset.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;

// Exported for tests. `now` is passed in rather than read from the clock so the
// window can be exercised without waiting a real minute.
function createRateLimiter({ windowMs = RATE_WINDOW_MS, max = RATE_MAX } = {}) {
  let times = [];
  return function allow(now) {
    times = times.filter((t) => now - t < windowMs);
    if (times.length >= max) return false;
    times.push(now);
    return true;
  };
}

const allowByRate = createRateLimiter();
let stormDropped = 0;

let child = null;
let stopping = false;
let restartTimer = null;
let status = 'Unknown'; // 'Unknown' | 'Allowed' | 'Denied' | 'Unspecified'
let allowedApps = new Set();       // lower-cased app names the user opted in
const recentApps = [];             // display-cased app names seen, most recent first

function normalizeList(list) {
  return new Set((list || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
}

function rememberApp(appName) {
  if (!appName) return;
  const idx = recentApps.findIndex((a) => a.toLowerCase() === appName.toLowerCase());
  if (idx !== -1) recentApps.splice(idx, 1);
  recentApps.unshift(appName);
  if (recentApps.length > MAX_RECENT_APPS) recentApps.length = MAX_RECENT_APPS;
}

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'status') {
    status = msg.status || 'Unknown';
    logInfo(`[notification-mirror] access status: ${status}`);
    return;
  }
  if (msg.type === 'error') {
    logWarn('[notification-mirror] listener error:', msg.message);
    return;
  }
  if (msg.type !== 'notification') return;

  const app = (msg.app || '').trim();
  rememberApp(app);
  if (!app || !allowedApps.has(app.toLowerCase())) return; // not opted in - only tracked, not mirrored

  if (!allowByRate(Date.now())) {
    if (stormDropped === 0) {
      logWarn(`[notification-mirror] more than ${RATE_MAX} notifications in a minute - dropping the excess. ` +
              'The in-game toast cannot show them faster than this, so they would only pile up.');
    }
    stormDropped++;
    return;
  }
  if (stormDropped > 0) {
    logWarn(`[notification-mirror] storm over - ${stormDropped} notification(s) were dropped`);
    stormDropped = 0;
  }

  bridge.send({
    type: 'notification_mirror',
    app,
    title: (msg.title || '').slice(0, 120),
    body: (msg.body || '').slice(0, 200),
  });
}

function spawnChild() {
  try {
    child = spawn('powershell.exe',
      // -ParentPid is how the listener knows to die with us. It used to infer
      // that from stdin closing, which never worked - see the .ps1's own
      // parent-death comment.
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH,
       '-ParentPid', String(process.pid)],
      { windowsHide: true });
  } catch (e) {
    logError('[notification-mirror] failed to spawn listener:', e.message);
    child = null;
    return;
  }

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', handleLine);

  child.stderr.on('data', (d) => logWarn('[notification-mirror] stderr:', d.toString().trim()));

  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    logWarn(`[notification-mirror] listener exited (code ${code}) - restarting in ${RESTART_DELAY_MS}ms`);
    restartTimer = setTimeout(spawnChild, RESTART_DELAY_MS);
  });

  child.on('error', (e) => logError('[notification-mirror] process error:', e.message));
}

// Start the listener if it isn't already running. Safe to call repeatedly -
// e.g. every time the allow-list changes, so RequestAccessAsync also gets
// re-attempted after the user grants access in Windows Settings.
function ensureRunning() {
  stopping = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) return;
  spawnChild();
}

function stop() {
  stopping = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) { try { child.kill(); } catch { /* already gone */ } child = null; }
}

function setAllowedApps(list) {
  allowedApps = normalizeList(list);
}

function getStatus() {
  return { status, running: !!child, recentApps: [...recentApps] };
}

// One-shot enumeration of every app Windows would show on its own
// notification-settings page - the "View all apps" list. Get-StartApps is
// the same source Windows' own Settings > Notifications page draws from, so
// this app list matches what the user already expects to see there.
// Independent of the long-running listener above - no allow-list filtering,
// just names.
function listAllApps() {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        'Get-StartApps | Select-Object Name | ConvertTo-Json -Compress',
      ], { windowsHide: true });
    } catch (e) {
      logError('[notification-mirror] listAllApps spawn failed:', e.message);
      resolve([]);
      return;
    }
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', (e) => { logError('[notification-mirror] listAllApps error:', e.message); resolve([]); });
    proc.on('exit', () => {
      try {
        const parsed = JSON.parse(out || '[]');
        const arr = Array.isArray(parsed) ? parsed : [parsed]; // Get-StartApps returns a bare object for a single result
        const names = [...new Set(arr.map((x) => (x?.Name || '').trim()).filter(Boolean))];
        names.sort((a, b) => a.localeCompare(b));
        resolve(names);
      } catch (e) {
        logWarn('[notification-mirror] listAllApps parse failed:', e.message);
        resolve([]);
      }
    });
  });
}

// The user's default web browser sends its OWN toasts through the same
// Windows Action Center system this module already listens to (Chrome, Edge
// and Firefox all do this for web push - e.g. YouTube), so it's a good
// curated-default candidate. Unlike Discord, WHICH browser that is varies
// per machine, so this reads the actual default from the registry (same
// `reg query` technique steam.cjs already uses) instead of guessing one.
// Returns null for an unrecognized/unset default rather than showing a raw
// ProgId string as if it were an app name.
const BROWSER_PROG_IDS = [
  [/^ChromeHTML/i,   'Google Chrome'],
  [/^MSEdgeHTM/i,     'Microsoft Edge'],
  [/^FirefoxURL/i,   'Firefox'],
  [/^BraveHTML/i,     'Brave'],
  [/^Opera/i,         'Opera'],
];
function getDefaultBrowserName() {
  try {
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId',
    ], { encoding: 'utf8' });
    const match = out.match(/ProgId\s+REG_SZ\s+(.+)/i);
    if (!match) return null;
    const progId = match[1].trim();
    const known = BROWSER_PROG_IDS.find(([re]) => re.test(progId));
    return known ? known[1] : null;
  } catch (e) {
    logWarn('[notification-mirror] default browser lookup failed:', e.message);
    return null;
  }
}

module.exports = {
  ensureRunning, stop, setAllowedApps, getStatus, listAllApps, getDefaultBrowserName,
  createRateLimiter, RATE_WINDOW_MS, RATE_MAX, // tests
};
