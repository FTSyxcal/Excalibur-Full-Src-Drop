'use strict';

// Relays the in-game mod's integrity report to the server. OBSERVE-ONLY.
//
// The mod says what it loaded; this attaches the per-launch nonce and posts it.
// The nonce never reaches the mod, deliberately - it is what proves the report
// belongs to a session the server itself opened, and putting it inside the
// process being measured would hand it to anyone tampering with that process.
//
// ── Everything here fails silently and on purpose ────────────────────────────
// This is telemetry for a review queue that a human reads. It must not be able
// to delay a launch, break a session, or put an error in front of a player who
// has done nothing wrong. Every failure path ends in "no report this session",
// which the server already treats as one of its four signals rather than as a
// fault.
//
// NOTHING built on this may ban, restrict or auto-flag an account. The owner
// deferred enforcement explicitly; see api/mod-integrity.js.

const { logInfo, logError } = require('./logger.cjs');

const API_BASE = process.env.MOD_INTEGRITY_API_URL || 'https://excaliburgtag.com/api/mod-integrity';
const TIMEOUT_MS = 8000;

// One session at a time - a second game cannot be launched while one is running.
let _session = null;   // { nonce, sessionId, seq }

async function post(url, token, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Called when a game launch begins. Opening the session BEFORE the mod reports
// is what makes silence meaningful: the server knows a session started, so one
// that never reports is itself the signal.
async function openSession(token, appVersion) {
  _session = null;
  if (!token) return;
  const out = await post(`${API_BASE}?action=nonce`, token, { appVersion });
  if (!out?.ok || !out.nonce) return;
  _session = { nonce: out.nonce, sessionId: out.sessionId, seq: 0 };
  logInfo('[integrity] session opened for this launch');
}

function closeSession() { _session = null; }

// The mod sent an integrity_report over the bridge.
async function relay(token, msg) {
  if (!_session || !token) return;
  _session.seq += 1;
  const out = await post(`${API_BASE}?action=report`, token, {
    nonce: _session.nonce,
    seq: _session.seq,
    features:   Array.isArray(msg?.features)   ? msg.features   : [],
    tabs:       Array.isArray(msg?.tabs)       ? msg.tabs       : [],
    assemblies: Array.isArray(msg?.assemblies) ? msg.assemblies : [],
  });
  // A rejected report is worth ONE log line, not a retry loop. The most likely
  // causes are a session that expired and a clock that jumped, neither of which
  // a retry fixes, and both of which are already visible server-side.
  if (!out?.ok) logError('[integrity] report was not accepted (seq', _session.seq + ')');
}

module.exports = { openSession, closeSession, relay };
