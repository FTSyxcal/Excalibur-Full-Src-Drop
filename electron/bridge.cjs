'use strict';

// Local TCP server that the BepInEx mod connects to.
// Protocol: newline-delimited JSON (one message per line).
// Only one mod connection is accepted at a time.
//
// Authentication: any local process can dial localhost:52137. Without an
// explicit handshake, malware (or a sibling Electron app) could connect,
// send {type:"auth_request"} and harvest the user's signed JWT - the
// desktop dutifully echoes it back to the mod. To prevent that, we now
// require a per-launch shared token:
//
//   1. On bridge.start(), Electron generates a fresh 32-byte hex token
//      and writes it to %APPDATA%\Excalibur\bridge.token (user-readable).
//   2. The mod reads the token on connect and sends it as the FIRST
//      message: {type:"bridge_auth", token:"<hex>"}.
//   3. Any client whose first line doesn't match the current token is
//      disconnected before any further messages are processed.
//
// The token only lives in memory (and on disk for the mod to read).
// Other local processes can read the file too, but they'd need to be
// running as the same user - which is already the security boundary
// of the user's account. Keeps the JWT-leak hole closed.

const net = require('net');
const fs  = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { getWritableBaseDir, logInfo, logError } = require('./logger.cjs');

const PORT = 52137;
const HOST = '127.0.0.1';

function bridgeTokenPath() {
  return path.join(getWritableBaseDir(), 'bridge.token');
}

class ExcaliburBridge extends EventEmitter {
  constructor() {
    super();
    this._server = null;
    this._socket = null;
    this._buf    = '';
    this._token  = null;
    this._authed = false;
    this._peerPort = null;
  }

  // The ephemeral port of the currently (or most recently) connected client.
  //
  // Deliberately NOT cleared when the socket closes. handlePayloadRequest is
  // async - it waits on a Cloudflare round trip before it answers - so the
  // socket can legitimately be gone by the time the peer check runs. Keeping the
  // last value means the check still has something to look up; if that
  // connection really has closed, netstat finds no ESTABLISHED row, the result
  // is "indeterminate", and the caller allows it. Overwritten on every new
  // connection, and the bridge is single-client, so it cannot drift.
  peerPort() { return this._peerPort; }

  // Generate a fresh token for this app run. IMPORTANT: the token is only
  // PERSISTED to disk after listen() succeeds (see start) — a second app
  // instance that loses the port race must never overwrite the live
  // server's token file, or every mod handshake fails until the app is
  // restarted. That exact failure happened: a throwaway Test Lab instance
  // survived ~300ms past the single-instance quit, clobbered bridge.token,
  // and silently broke core delivery for every subsequent game launch.
  _initToken() {
    this._token = crypto.randomBytes(32).toString('hex');
  }

  _persistToken() {
    // Mode 0o600 makes it user-only on POSIX; on Windows the user-profile
    // ACL achieves the same effect by default.
    try {
      fs.writeFileSync(bridgeTokenPath(), this._token, { encoding: 'utf8', mode: 0o600 });
      logInfo('[Bridge] token persisted');
    } catch (e) {
      logError('[Bridge] failed to write bridge.token:', e.message);
    }
  }

  start() {
    this._initToken();

    this._server = net.createServer((socket) => {
      if (this._socket) {
        // Single-client bridge: a second GT process (Test Lab build +
        // Steam copy at once) gets dropped here on every retry. Log it —
        // this was previously silent and undiagnosable.
        logInfo('[Bridge] extra client rejected (a session already holds the socket)');
        socket.destroy();
        return;
      }
      this._socket = socket;
      this._buf    = '';
      this._authed = false;
      // The peer's ephemeral port, captured HERE and not read back off the
      // socket later. It identifies the connecting process while the connection
      // is open (see electron/peer-process.cjs), and main.js uses it to decide
      // whether the PAID assemblies may be handed over. Reading socket.remotePort
      // at request time would return undefined once the socket has closed, which
      // is exactly the moment a decision still has to be made.
      this._peerPort = socket.remotePort || null;

      // ── Pre-auth limits ────────────────────────────────────────────────
      // The slot is claimed ABOVE, before the handshake, and both consequences
      // were reachable by any local process:
      //
      //   1. SQUATTING. Connect, send nothing, hold the only slot forever.
      //      Every later client - including the real mod - is turned away as
      //      "extra client", so the in-game mod never connects and every
      //      feature is dead with no error anywhere. There was no timeout.
      //   2. MEMORY. `this._buf += chunk` was unbounded while unauthenticated,
      //      so a client could stream endlessly with no newline and grow a
      //      string in the MAIN process until the app died.
      //
      // The auth line is a fixed, tiny JSON object, so a small cap and a short
      // deadline cost a legitimate client nothing. The mod reconnects on a
      // timer, so dropping a squatter hands the slot straight back to it.
      const AUTH_DEADLINE_MS  = 5_000;
      const MAX_PREAUTH_BYTES = 4096;
      let authTimer = setTimeout(() => {
        if (!this._authed) {
          logError('[Bridge] client never authenticated within '
            + `${AUTH_DEADLINE_MS}ms - dropping it so the slot is free again`);
          try { socket.destroy(); } catch { /* already gone */ }
        }
      }, AUTH_DEADLINE_MS);
      // Never keep the app alive just to wait on a handshake.
      if (typeof authTimer.unref === 'function') authTimer.unref();
      const clearAuthTimer = () => { if (authTimer) { clearTimeout(authTimer); authTimer = null; } };
      socket.once('close', clearAuthTimer);
      socket.once('error', clearAuthTimer);

      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        this._buf += chunk;
        if (!this._authed && this._buf.length > MAX_PREAUTH_BYTES) {
          logError('[Bridge] pre-auth data exceeded '
            + `${MAX_PREAUTH_BYTES} bytes - dropping client`);
          this._buf = '';
          try { socket.destroy(); } catch { /* already gone */ }
          return;
        }
        let nl;
        while ((nl = this._buf.indexOf('\n')) !== -1) {
          const line = this._buf.slice(0, nl).trim();
          this._buf  = this._buf.slice(nl + 1);
          if (!line) continue;

          // Auth gate: first line MUST be a valid bridge_auth or the
          // socket gets killed. Until authed, no message escapes to
          // listeners - so a hostile process can't dial in and grab
          // the user's JWT via {type:"auth_request"}.
          if (!this._authed) {
            try {
              const msg = JSON.parse(line);
              if (msg && msg.type === 'bridge_auth' && msg.token === this._token) {
                this._authed = true;
                clearAuthTimer();
                try { socket.write(JSON.stringify({ type: 'bridge_auth_ok' }) + '\n'); } catch {}
                this.emit('connected');
                continue;
              }
            } catch { /* fallthrough */ }
            logError('[Bridge] handshake failed - dropping client (token mismatch: '
              + 'if this repeats, bridge.token on disk is stale - restart the app)');
            socket.destroy();
            return;
          }

          try { this.emit('message', JSON.parse(line)); } catch { /* ignore malformed */ }
        }
      });

      socket.on('close', () => {
        const wasAuthed = this._authed;
        this._socket = null;
        this._authed = false;
        if (wasAuthed) this.emit('disconnected');
      });
      socket.on('error', () => {
        const wasAuthed = this._authed;
        this._socket = null;
        this._authed = false;
        if (wasAuthed) this.emit('disconnected');
      });
    });

    // EADDRINUSE here means another live instance owns the bridge — do
    // NOT touch the token file in that case (see _initToken).
    this._server.on('error', (e) => logError('[Bridge] server error:', e.message));
    // exclusive:true - Windows happily lets TWO processes bind the same
    // port without it, which SPLIT-BRAINED the bridge (the game's socket
    // in one instance, the renderer's pushes in the other, every push
    // silently dropped). With exclusive binding the second instance fails
    // loudly here instead.
    this._server.listen({ port: PORT, host: HOST, exclusive: true }, () => {
      logInfo(`[Bridge] listening on ${HOST}:${PORT}`);
      // Persist the token ONLY once the port is truly ours.
      this._persistToken();
    });
  }

  send(msg) {
    if (!this._socket || this._socket.destroyed || !this._authed) {
      // A dropped push used to vanish silently - that hid every
      // app->game outage. One throttled line makes it greppable.
      const now = Date.now();
      if (!this._lastDropLog || now - this._lastDropLog > 5000) {
        this._lastDropLog = now;
        logError(`[Bridge] send DROPPED (no authed game socket): ${msg && msg.type}`);
      }
      return false;
    }
    try { this._socket.write(JSON.stringify(msg) + '\n'); return true; }
    catch (e) {
      const now = Date.now();
      if (!this._lastDropLog || now - this._lastDropLog > 5000) {
        this._lastDropLog = now;
        logError(`[Bridge] send FAILED (${e.message}): ${msg && msg.type}`);
      }
      return false;
    }
  }

  // Only consider us "connected" once the handshake has cleared.
  get isConnected() { return !!this._socket && !this._socket.destroyed && this._authed; }

  stop() {
    this._socket?.destroy(); this._socket = null;
    this._authed = false;
    this._server?.close();   this._server = null;
    // Best-effort: blank the token file on shutdown so a stale handle
    // can't be used after Excalibur exits.
    try { fs.unlinkSync(bridgeTokenPath()); } catch {}
  }
  // The per-launch token, for other local channels that need to prove the same
  // thing this one does. electron/luma-bridge.cjs uses it to authenticate to the
  // Luma engine's control socket, which previously accepted any local client.
  // Null before start() has minted one; callers must handle that.
  get token() { return this._token || null; }
}

module.exports = new ExcaliburBridge();
