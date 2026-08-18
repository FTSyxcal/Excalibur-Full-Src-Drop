'use strict';
// LUMA LOOKS engine client (2026-07-31). The Luma realism engine — now hosted inside the Excalibur
// mod (built-in feature 'luma-looks') — keeps its own loopback control server on TCP 47800, speaking
// the same newline-delimited JSON the standalone Luma app uses:
//   server → {"type":"hello","version":..,"settings":{master,effects:{...}}}   (once, on connect)
//   server → {"type":"stats",...}                                              (periodic, fps/cpu/gpu)
//   client → {"type":"apply","settings":{...}}                                 (on any control change)
//   client → {"type":"ping"} / server → {"type":"pong"}
// This is the desktop app's client of that server: it connects while the Luma feature is enabled,
// surfaces the engine's live settings to the renderer, and forwards the panel's edits back. It
// deliberately reuses the engine's own, tested settings path instead of the 52137 mod bridge, so no
// bridge-contract change is required. (Only ONE client at a time — if the standalone Luma app is
// also open and connected, close it first.)

const net = require('net');
const { EventEmitter } = require('events');
// The Luma control socket is authenticated with the SAME per-launch token the
// main bridge mints - see the handshake in _open() below.
const bridge = require('./bridge.cjs');
const { logError, logInfo } = require('./logger.cjs');

const HOST = '127.0.0.1';
const PORT = 47800;
const RETRY_MS = 1000;

class LumaEngineClient extends EventEmitter {
  constructor() {
    super();
    this._sock = null;
    this._buf = '';
    this._want = false;
    this._retry = null;
    this.connected = false;
    this.settings = null;   // last settings the engine reported/acknowledged
    // The newest settings the engine has NOT yet acknowledged - offline edits, plus any live
    // apply whose {"type":"ack"} (Engine Plugin.cs replies one per apply) hasn't arrived.
    // A socket write only proves bytes entered Node's buffer, so clearing on write would lose
    // edits when the game dies before draining them; only an ack proves the engine applied.
    // Survives stop() on purpose (the game closing is exactly when these accumulate) and is
    // flushed on the next hello, where it WINS over the engine's saved state.
    this.pendingSettings = null;
    this._unackedWrites = 0;
  }

  connect() { this._want = true; this._open(); }

  stop() {
    this._want = false;
    if (this._retry) { clearTimeout(this._retry); this._retry = null; }
    if (this._sock) { try { this._sock.destroy(); } catch { /* ignore */ } this._sock = null; }
    this.connected = false;
    this._unackedWrites = 0;   // see the close handler; pendingSettings survives stop()
  }

  // pendingSettings first: a panel mounting while the game is closed must see its own offline
  // edits, not the last state the dead engine reported.
  status() { return { connected: this.connected, settings: this.pendingSettings || this.settings }; }

  _open() {
    if (this._sock || !this._want) return;
    let sock;
    try {
      sock = net.createConnection({ host: HOST, port: PORT }, () => {
        // Handshake FIRST, before anything else goes down the wire.
        //
        // The engine's control socket used to accept any local connection,
        // greet it with the full current settings, and take commands from it -
        // and "newest connection wins", so another local process could also
        // kick this client off and keep the engine. Every other local channel
        // here is authenticated; this one was not.
        //
        // Same per-launch token electron/bridge.cjs already mints and writes
        // mode 0600, so nothing new is distributed. The engine fails OPEN when
        // it cannot read the token file, so an older engine (or a layout where
        // the token is unreadable) still works - it simply ignores this line as
        // unknown input.
        try {
          const token = bridge.token;
          if (token) logInfo(`[luma] handshake with token ${token.slice(0, 6)}..(${token.length})`);
          if (token) sock.write(`${JSON.stringify({ type: 'luma_auth', token })}
`);
          else logError('[luma] no bridge token available - the engine will accept us unauthenticated');
        } catch (e) {
          logError('[luma] handshake write failed:', e && e.message);
        }
        this.connected = true;
        this.emit('state', { connected: true });
      });
    } catch {
      this._scheduleRetry();
      return;
    }
    sock.setNoDelay(true);
    sock.on('data', (chunk) => this._onData(chunk));
    sock.on('error', () => { /* surfaced via close */ });
    sock.on('close', () => {
      // DIAG (2026-08-15): the close is the moment applies start queueing offline; it was silent.
      if (this.connected) logInfo('[luma] engine socket closed - edits will queue until the next hello');
      this._sock = null;
      // Acks from this socket will never arrive; without the reset, the next
      // session's flush ack could never drain the counter and pending would
      // stay stuck forever. pendingSettings itself survives - that's the point.
      this._unackedWrites = 0;
      if (this.connected) { this.connected = false; this.emit('state', { connected: false }); }
      this._scheduleRetry();
    });
    this._sock = sock;
  }

  _scheduleRetry() {
    if (!this._want || this._retry) return;
    this._retry = setTimeout(() => { this._retry = null; this._open(); }, RETRY_MS);
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'hello') {
        // DIAG (2026-08-15, "panel edits never reach the engine"): one line per hello, saying
        // which branch it took. Cheap, once per engine session, and it is the exact fork that
        // decides whether the panel sees the engine's state or its own queued edits.
        try {
          const fx = msg?.settings?.effects;
          const on = fx ? Object.keys(fx).filter((k) => fx[k] && fx[k].enabled).length : -1;
          logInfo(`[luma] hello: engine reports ${on} effect(s) on; ${this.pendingSettings ? 'FLUSHING queued offline edits over it' : 'adopting engine state'}`);
        } catch { /* diagnostic only */ }
        if (this.pendingSettings) {
          // Un-acked edits win over the engine's saved state: flush them as the first apply of
          // the session and hand THEM to the panel, not the stale hello snapshot. This also
          // covers an apply that raced into the connect-to-hello gap (it sits in pending until
          // its ack, so the hello can never revert the panel to the boot snapshot). Cleared by
          // the ack, not here, so a flush the engine never drains retries on the next hello.
          const pending = this.pendingSettings;
          this.settings = pending;
          if (this._write({ type: 'apply', settings: pending })) this._unackedWrites++;
          // fromPending: the settings carried here are queued USER edits, not
          // the engine's saved state - main.js must not stomp them with a
          // configured starting preset.
          this.emit('hello', { version: msg.version, settings: pending, fromPending: true });
        } else {
          this.settings = msg.settings || null;
          this.emit('hello', { version: msg.version, settings: this.settings, fromPending: false });
        }
      } else if (msg.type === 'ack') {
        // One ack per apply. Only when every write in flight is acknowledged is the
        // pending copy safe to drop - an earlier ack must not release edits that a
        // newer, still-unacked write carries.
        if (this._unackedWrites > 0) this._unackedWrites--;
        if (this._unackedWrites === 0 && this.pendingSettings) {
          this.pendingSettings = null;
          // DIAG (2026-08-15): the ack that drains the queue is the proof an edit LANDED.
          logInfo('[luma] engine acked - all writes drained, pending cleared');
        }
      } else if (msg.type === 'stats') {
        this.emit('stats', msg);
      }
    }
  }

  _write(obj) {
    if (!this._sock || !this.connected) return false;
    try { this._sock.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  apply(settings) {
    if (!this._sock || !this.connected) {
      // Game closed: keep the edit instead of dropping it. Every apply carries the FULL
      // settings object, so the latest offline edit simply replaces the previous one;
      // it is flushed to the engine on the next hello (see _onData).
      // DIAG (2026-08-15): log the FIRST queue of a burst, not every slider tick — the
      // transition into offline queueing is the fact that matters, and it was invisible:
      // a user clicking toggles with no engine saw them "move" while nothing was sent.
      if (!this._loggedQueueing) {
        this._loggedQueueing = true;
        logInfo(`[luma] apply queued OFFLINE (sock=${!!this._sock} connected=${this.connected}) - held until the next engine hello`);
      }
      this.pendingSettings = settings;
      return true;   // stored — will reach the engine when it comes back
    }
    this._loggedQueueing = false;
    if (this._write({ type: 'apply', settings })) {
      this.settings = settings;
      // Held as pending until the engine's ack lands (see _onData): if the game dies with
      // this write undrained, the edit survives and re-flushes next session's hello.
      this.pendingSettings = settings;
      this._unackedWrites++;
      return true;
    }
    // DIAG (2026-08-15): a live-looking socket refusing the write is the silent failure mode.
    logError('[luma] apply WRITE FAILED on a connected socket');
    return false;
  }
}

module.exports = { LumaEngineClient };
