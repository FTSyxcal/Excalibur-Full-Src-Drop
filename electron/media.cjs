// System media bridge - feeds the wristband MUSIC tab.
//
// Spawns media-agent.ps1 (Windows media session + Spotify's per-app session
// meter and volume - never the device master) as a hidden child, forwards its
// JSON lines onto the game bridge as `media_state` / `audio_level`, and writes
// commands (`media_cmd`) to its stdin. The agent needs no credentials and
// never touches the network. stop() must run on app quit: it tells the agent
// to restore any mixer level it changed before exiting.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let child = null;
let bridge = null;
let logInfo = () => {};
let logError = () => {};
let stopped = false;
let lastState = null;      // resent on mod hello so a late game gets art
let lastArt = null;        // art rides only on change; keep it for resends
let restartTimer = null;
// The playlist an app is playing is not exposed by any Windows API, so
// the honest queue is HISTORY: every track that actually plays is recorded
// and the wristband shows the session's play order.
let history = [];          // [{ title, artist }]
let lastHistorySig = '';
let lastHistoryMsg = null; // resent on mod hello

function init(deps) {
  bridge = deps.bridge;
  logInfo = deps.logInfo || logInfo;
  logError = deps.logError || logError;
  start();
  // HOT-RELOAD the agent when its script changes on disk. The agent is
  // spawned once at app start and lives as long as the app - which meant
  // every agent fix silently required a full desktop restart, and "the
  // playhead doesn't work" turned out to be an agent from BEFORE the playhead
  // existed, still faithfully running hours later. Watching the file makes an
  // agent edit take effect within seconds, in dev and in prod alike.
  try {
    fs.watchFile(agentScriptPath(), { interval: 2000 }, () => {
      if (stopped || !child) return;
      logInfo('[media] agent script changed on disk - restarting agent');
      try { child.kill(); } catch { }
      // The exit handler schedules the restart; nothing else to do here.
    });
  } catch { /* watching is best-effort */ }
}

// Where powershell.exe can ACTUALLY read the agent from.
//
// In a packaged build __dirname is inside app.asar, and an asar is a virtual
// filesystem that only Electron's own patched `fs` understands. powershell.exe
// is an ordinary external process, so handing it a path inside the archive
// fails with "the argument ... does not exist" - which is exactly what a
// tester's log showed on 0.9.3, once every five seconds, forever, because the
// exit handler dutifully restarted it each time.
//
// package.json `build.asarUnpack` copies the script out to app.asar.unpacked/,
// and this rewrite points at that copy. In dev there is no asar in the path, so
// the replace is a no-op and nothing changes.
function agentScriptPath() {
  return path.join(__dirname, 'media-agent.ps1')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function start() {
  if (child || stopped) return;
  const script = agentScriptPath();
  // Do not spawn a process that provably cannot work. Without this the failure
  // is a restart loop that fills the log and hides everything else in it.
  if (!fs.existsSync(script)) {
    logError('[media] agent script not found at', script,
             '- media info (the wristband MUSIC tab) is unavailable this session.');
    stopped = true;
    return;
  }
  try {
    child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    logError('[media] failed to spawn agent:', e.message);
    scheduleRestart();
    return;
  }
  logInfo('[media] agent started (pid', child.pid + ')');

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) logError('[media] agent stderr:', s.slice(0, 300));
  });
  child.on('exit', (code) => {
    logError('[media] agent exited (code', code + '), restarting in 5s');
    child = null;
    scheduleRestart();
  });
}

function scheduleRestart() {
  if (restartTimer || stopped) return;
  restartTimer = setTimeout(() => { restartTimer = null; start(); }, 5000);
}

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.t === 'level') {
    bridge?.send({ type: 'audio_level', v: msg.v });
  } else if (msg.t === 'pos') {
    // Playhead position/duration, ~1 Hz. Its own message type so it does
    // not drag the whole media_state (album art included) along with it.
    bridge?.send({ type: 'media_state', pos: msg.p, dur: msg.d });
  } else if (msg.t === 'log') {
    // Diagnostics the agent wants in the app log rather than on stderr (which
    // is logged as an error and reads like a fault).
    logInfo('[media]', String(msg.m || '').slice(0, 200));
  } else if (msg.t === 'state') {
    const { t, art, ...rest } = msg;
    if (art) lastArt = { art, art_sig: msg.art_sig };
    if (msg.art_clear) lastArt = null;
    lastState = rest;
    bridge?.send({ type: 'media_state', ...rest, ...(art ? { art } : {}) });
    recordHistory(msg.title, msg.artist);
  }
}

// The wristband opens mid-track: replay the last known state WITH art so the
// page isn't blank until the next track change.
function resend() {
  if (!lastState) return;
  bridge?.send({
    type: 'media_state', ...lastState,
    ...(lastArt ? { art: lastArt.art, art_sig: lastArt.art_sig } : {}),
  });
  if (lastHistoryMsg) bridge?.send(lastHistoryMsg);
}

function recordHistory(title, artist) {
  const t = String(title || '').trim();
  if (!t) return;
  // Spotify ads surface as titles with no artist ("LISTEN NOW") - not music.
  if (!String(artist || '').trim()) return;
  const sig = `${t}|${artist || ''}`;
  if (sig === lastHistorySig) return;
  lastHistorySig = sig;
  // Re-playing an earlier song moves it to the end (it IS the newest play).
  history = history.filter((h) => `${h.title}|${h.artist}` !== sig);
  history.push({ title: t.slice(0, 60), artist: String(artist || '').slice(0, 40) });
  if (history.length > 40) history = history.slice(-40);
  lastHistoryMsg = { type: 'media_history', tracks: history };
  bridge?.send(lastHistoryMsg);
}

// The wristband music page just opened: replay the last known state (art
// included) immediately, and poke the agent for a fresh poll so a track that
// started while the page was closed shows up within a beat. 'refresh' is not
// a recognised command in the agent's switch - it matches nothing - but the
// drain still marks it forceState, which is exactly the poke wanted.
function requestState() {
  resend();
  if (child && child.stdin.writable) {
    try { child.stdin.write('refresh\n'); } catch { }
  }
}

function command(cmd, value) {
  if (!child || !child.stdin.writable) return;   // agent mid-restart
  // vol_set carries an absolute 0..1 level (the wristband's finger-drag on the
  // volume bar). Validated HERE rather than trusted: the agent writes straight
  // to the app's mixer level, and a NaN or an out-of-range number would be a
  // silent way to mute someone.
  if (cmd === 'seek') {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return;
    try { child.stdin.write(`seek ${v.toFixed(2)}\n`); } catch { }
    return;
  }
  // prev carries the wristband's live position so the agent can decide
  // single-vs-double without consulting Spotify's stale SMTC timeline. A bare
  // 'prev' (no usable position) is the safe fallback: single press only.
  if (cmd === 'prev') {
    const v = Number(value);
    const line = Number.isFinite(v) && v >= 0 ? `prev ${v.toFixed(1)}` : 'prev';
    try { child.stdin.write(line + '\n'); } catch { }
    return;
  }
  if (cmd === 'vol_set') {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(0, Math.min(1, v));
    try { child.stdin.write(`vol_set ${clamped.toFixed(3)}\n`); } catch { }
    return;
  }
  if (!['play_pause', 'next', 'prev', 'vol_up', 'vol_down', 'source_next'].includes(cmd)) return;
  try { child.stdin.write(cmd + '\n'); } catch { /* agent mid-restart */ }
}

function stop() {
  stopped = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  try { fs.unwatchFile(agentScriptPath()); } catch { }
  const c = child;
  child = null;
  if (!c) return;
  // Ask, don't kill. child.kill() is TerminateProcess on Windows - the agent
  // gets no chance to restore the Spotify mixer level it changed. 'quit' makes
  // it restore and exit itself (its loop turns every 16 ms); the kill is only
  // a backstop for a wedged agent. If our own process dies before the backstop
  // fires, the agent still sees stdin EOF and runs the same restore+exit.
  try { c.removeAllListeners('exit'); } catch { }
  try { if (c.stdin.writable) c.stdin.write('quit\n'); } catch { }
  const backstop = setTimeout(() => { try { c.kill(); } catch { } }, 1500);
  c.on('exit', () => clearTimeout(backstop));
  if (backstop.unref) backstop.unref();
}

module.exports = { init, command, requestState, resend, stop };
