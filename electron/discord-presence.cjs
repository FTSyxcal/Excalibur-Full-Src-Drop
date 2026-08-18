const RPC = require('discord-rpc');

const CLIENT_ID = '1511900835939090574';

let client    = null;
let ready     = false;
let paused    = false;
let startTime = null;
let destroyed = false;
let currentRoute = 'mods';
let devStatusActive = false;
// Honours the user's "Show desktop client presence" toggle in Discord RPC settings.
// When false, we clear any existing activity and never publish until turned back on.
let showClientRpc = true;

const ROUTE_STATES = {
  mods:     'Managing Mods',
  download: 'Downloading Mods',
  friends:  'Viewing Friends',
  profiles: 'Viewing Profiles',
  settings: 'In Settings',
};

function buildActivity() {
  if (devStatusActive) {
    return {
      details:        'Excalibur',
      state:          'Developing...',
      startTimestamp: startTime,
      largeImageKey:  'excalibur_logo',
      largeImageText: 'Excalibur',
      instance:       false,
    };
  }
  return {
    details:        'Gorilla Tag Launcher',
    state:          ROUTE_STATES[currentRoute] || 'Managing Mods',
    startTimestamp: startTime,
    largeImageKey:  'excalibur_logo',
    largeImageText: 'Excalibur',
    instance:       false,
  };
}

// ── Closed-beta lockdown — LIFTED AT PUBLIC LAUNCH, 2026-08-15 ──────────────
// Rich Presence was OFF for every account through the closed beta (owner call
// 2026-08-03) and was deliberately not a setting anyone could win: Excalibur
// was invite-only, and a tester's friends list was the one surface that
// advertised it to people who could not have it. Launch removes that reason.
//
// LEFT AS A NAMED CONSTANT rather than deleted along with the branches it
// guards. The branches are three lines, and they are what makes switching
// presence off again a one-word edit in the process that actually talks to
// Discord. Deleting them would mean re-deriving this file's reasoning under
// whatever pressure prompted the next lockdown.
//
// It is enforced HERE rather than in the renderer on purpose, and that stays
// true in both directions. The Settings toggle is only a picture of the state;
// config.json is a text file anyone can edit, and `features['rich-presence']`
// defaults to ON when absent. Gating the UI alone would leave the feature one
// hand-edit (or one stale config) away from broadcasting anyway.
//
// Moves together with RPC_ENABLED in src/lib/flags.js and the one-time
// rich-presence heal in electron/config.cjs. See the comment on RPC_ENABLED for
// why all three exist and what each one alone fails to do.
const BETA_LOCKDOWN = false;

let rpcEnabled = !BETA_LOCKDOWN;   // the 'rich-presence' feature flag, applied LIVE

function trySetActivity() {
  if (!client || !ready || destroyed) return;
  if (BETA_LOCKDOWN || paused || !showClientRpc || !rpcEnabled) {
    swallow(() => client.clearActivity());
    return;
  }
  swallow(() => client.setActivity(buildActivity()));
}

// Feature-flag switch: flipping OFF clears the Discord activity right away,
// flipping ON repaints it. The RPC connection itself stays up - Discord
// treats connect/disconnect churn far worse than an empty activity.
function setEnabled(enabled) {
  // During the closed beta this is deliberately a no-op that always lands on
  // OFF, so neither a saved config nor an IPC call can turn presence back on.
  rpcEnabled = BETA_LOCKDOWN ? false : !!enabled;
  trySetActivity();
}

function setShowClientRpc(enabled) {
  showClientRpc = !!enabled;
  trySetActivity();
}

// ── Reconnect, with exactly one attempt and one timer in flight ────────────
//
// There were THREE independent `setTimeout(connect, 15000)` calls and no guard
// of any kind, so reconnects multiplied instead of retrying:
//
//   * `login().catch()` and the `disconnected` event BOTH fire for a single
//     failed attempt when Discord goes away mid-handshake. Two timers, two
//     connect() calls 15 s later, two RPC clients - and each of those has its
//     own pair of failure paths. It doubles per round.
//   * Nothing ever tore down the previous client. `client = new RPC.Client()`
//     just overwrote the reference, leaving the old one holding an IPC socket
//     and its listeners alive forever.
//   * A stale client's late `disconnected` could schedule a reconnect on top of
//     a connection that had already succeeded, killing a working one.
//
// Quitting Discord and reopening it a few times was enough to reach dozens of
// live clients and timers in the main process. The fixes are: one retry timer,
// an in-flight flag, explicit teardown of the old client, and every handler
// checking it is still the CURRENT client before acting.
let retryTimer = null;
let connecting = false;

function scheduleReconnect() {
  if (destroyed || retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 15000);
  // Never hold the app open just to retry a presence connection.
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

// Every discord-rpc call below returns a PROMISE, and a dead IPC socket makes
// them REJECT rather than throw. `try { c.destroy(); } catch {}` therefore
// caught nothing: the rejection escaped as an unhandled rejection, which in
// the Electron main process is fatal - the whole app exits, taking the window
// and (in dev) vite with it. Observed twice in a row: Discord was closed, the
// 15s reconnect fired, dropClient -> destroy() rejected "connection closed",
// app gone. Losing rich presence is a non-event; losing the app is not.
function swallow(fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { /* sync throw - equally non-fatal */ }
}
function dropClient(c) {
  if (!c) return;
  try { c.removeAllListeners?.(); } catch { }
  swallow(() => c.destroy?.());
}

function connect() {
  if (destroyed || connecting) return;
  connecting = true;

  // Retire the previous client BEFORE replacing the reference.
  const prev = client;
  client = null;
  ready  = false;
  dropClient(prev);

  let c = null;
  try {
    c = new RPC.Client({ transport: 'ipc' });
    client = c;
    // `client !== c` means a newer attempt has superseded this one, so this
    // callback belongs to a client nobody is using any more.
    c.on('ready', () => {
      if (client !== c || destroyed) return;
      ready = true;
      connecting = false;
      trySetActivity();
    });
    c.on('disconnected', () => {
      if (client !== c || destroyed) return;
      ready = false;
      connecting = false;
      scheduleReconnect();
    });
    startTime = new Date();
    c.login({ clientId: CLIENT_ID }).catch(() => {
      if (client !== c || destroyed) return;
      connecting = false;
      scheduleReconnect();
    });
  } catch {
    if (client === c) client = null;
    dropClient(c);
    connecting = false;
    scheduleReconnect();
  }
}

function setRoute(route) {
  currentRoute = route;
  trySetActivity();
}

function pause() {
  paused = true;
  if (client && ready) swallow(() => client.clearActivity());
}

function resume() {
  paused = false;
  trySetActivity();
}

function destroy() {
  destroyed = true;
  if (client && ready) swallow(() => client.clearActivity());
  ready = false;
  // A pending reconnect used to survive destroy() and build a fresh client
  // 15 s into shutdown. `destroyed` guards connect() itself, but leaving the
  // timer armed also kept the process's event loop referenced.
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  connecting = false;
  const prev = client;
  client = null;
  dropClient(prev);
}

connect();

function setDevStatus(enabled) {
  devStatusActive = !!enabled;
  trySetActivity();
}

module.exports = { pause, resume, destroy, setRoute, setDevStatus, setShowClientRpc, setEnabled };
