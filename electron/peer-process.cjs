'use strict';

// Who is on the other end of the bridge socket?
//
// ── Why this exists (2026-08-12) ────────────────────────────────────────────
// The paid in-game assemblies (Excalibur.Pro / Excalibur.ProPlus) are handed to
// whoever asks for them over the local bridge. Until now "whoever asks" was
// literally anyone: the handshake is a 32-byte token in
// %APPDATA%\...\bridge.token, a file readable by any process running as the
// user. So harvesting a paying account's paid DLLs took no reverse engineering
// at all - read the token, connect to 127.0.0.1:52137, send
// {"type":"payload_request"}, base64-decode the reply, and decrypt it with the
// AES key that is a `readonly byte[]` constant in mod-patcher/ExcaliburBootstrap.cs
// (a file that ships, unencrypted, on disk in the game folder - its own comments
// admit the key "is effectively public").
//
// That is a thirty-line script, and the result is the paid product as plain
// DLLs, permanently, signed and ready to redistribute.
//
// This module answers the question that closes it: is the process on the other
// end actually Gorilla Tag? An attacker's helper.exe is not, and gets nothing.
//
// ── What this is NOT ────────────────────────────────────────────────────────
// It is not a wall. Someone determined can inject into the real game process and
// read the plaintext out of memory - but at that point they are already inside
// the process where the decrypted assembly lives, so there is nothing left for
// this check to protect. The point is to move the cheapest attack from "a script
// anyone can run and share" to "write a game-process injector", which is a
// different population of people entirely.
//
// ── How ─────────────────────────────────────────────────────────────────────
// The bridge is bound to 127.0.0.1 only (bridge.cjs HOST), so every peer is an
// IPv4 loopback socket and its ephemeral port identifies it uniquely while the
// connection is open. `netstat -ano` maps that port to an owning PID, and
// PowerShell's CIM gives that PID's full executable path.
//
// PATH, not image name. `tasklist` is faster but only reports "Gorilla Tag.exe",
// and naming your own binary that is free. Comparing the full path against the
// game folder the app is configured to launch means impersonation requires
// writing into the user's actual Steam install.
//
// ── Cost ────────────────────────────────────────────────────────────────────
// Measured on the dev machine: netstat ~200 ms, PowerShell CIM ~600 ms. This
// runs ONCE per game launch, on a path that already tolerates a 12 s Cloudflare
// round trip and whose client-side budget is 40 s. It is not on any per-frame or
// per-message path.
//
// `wmic` is deliberately not used: it has been removed from current Windows 11
// builds (verified ENOENT on 26200), so it is not a fallback, it is a failure.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Windows only, which matches the app (win32). On any other platform we cannot
// answer, and the caller treats "cannot answer" as indeterminate rather than as
// an attack - see decidePayloadPeer.
const IS_WINDOWS = process.platform === 'win32';

const EXEC_TIMEOUT_MS = 5000;

function run(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(
        file, args,
        { encoding: 'utf8', windowsHide: true, timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout || '')),
      );
    } catch {
      resolve(null);
    }
  });
}

// ── Parsers (pure, exported for electron/peer-process.test.cjs) ─────────────

// Find the PID that owns the CLIENT side of a loopback connection to our bridge.
//
// Real `netstat -ano -p tcp` output, captured on the dev machine:
//
//   TCP    127.0.0.1:49330        127.0.0.1:52999        ESTABLISHED     6624
//   TCP    127.0.0.1:52999        0.0.0.0:0              LISTENING       6624
//   TCP    127.0.0.1:52999        127.0.0.1:49330        ESTABLISHED     6624
//
// We want the FIRST shape: local = the peer's ephemeral port, foreign = the
// bridge port. Matching on the peer port alone would also match the third row
// (our own listening socket's view of the same connection), whose PID is the
// DESKTOP APP - which would make every request look like it came from ourselves.
//
// ── Why the STATE is not required to be ESTABLISHED ─────────────────────────
// It was, in the first cut, and that was a bypass. TCP lets a client close its
// SENDING half while still receiving: send payload_request, shutdown(SHUT_WR),
// keep reading. The peer's row then reads FIN_WAIT_1/FIN_WAIT_2 instead of
// ESTABLISHED, an ESTABLISHED-only match finds nothing, the result is
// "indeterminate", and the fail-open posture hands over the paid assemblies -
// which that socket is still perfectly able to receive.
//
// So the address PAIR is the identity and the state is not filtered on. This is
// safe in the other direction too: a row can only carry a real owning PID while
// the socket still belongs to a live process, and the states where it does not
// (TIME_WAIT, which reports PID 0) are states where nothing can be delivered
// anyway. LISTENING is excluded explicitly, though the pair match already
// rules it out - its foreign address is 0.0.0.0:0.
function parseNetstatForPeerPid(stdout, peerPort, bridgePort) {
  if (!stdout || !peerPort || !bridgePort) return null;
  const local   = `127.0.0.1:${peerPort}`;
  const foreign = `127.0.0.1:${bridgePort}`;
  for (const line of String(stdout).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // proto, local, foreign, state, pid
    if (cols.length < 5) continue;
    if (!/^TCP$/i.test(cols[0])) continue;
    if (cols[1] !== local || cols[2] !== foreign) continue;
    if (/^LISTENING$/i.test(cols[3])) continue;
    const pid = Number.parseInt(cols[4], 10);
    // PID 0 is the kernel placeholder on a connection with no owning process
    // left (TIME_WAIT). Nothing can receive on it, so there is nothing to gate.
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }
  return null;
}

// PowerShell prints the bare path plus a trailing newline, or nothing at all if
// the process is gone or its path is unreadable (a protected process).
function parseExecutablePath(stdout) {
  if (!stdout) return null;
  const line = String(stdout).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line || null;
}

// `tasklist /NH /FO CSV` -> "Gorilla Tag.exe","1234","Console","1","110,508 K"
// Used only as a weaker fallback when the path is unavailable.
function parseTasklistImageName(stdout) {
  if (!stdout) return null;
  const m = String(stdout).match(/^"([^"]+)"/m);
  return m ? m[1] : null;
}

// ── Resolution ──────────────────────────────────────────────────────────────

// exec is injectable so the tests never spawn anything.
async function resolvePeerProcess(peerPort, bridgePort, exec = run) {
  if (!IS_WINDOWS) return { determinate: false, why: 'not windows' };
  if (!peerPort)   return { determinate: false, why: 'no peer port on the socket' };

  const netstat = await exec('netstat', ['-ano', '-p', 'tcp']);
  if (netstat === null) return { determinate: false, why: 'netstat failed' };

  const pid = parseNetstatForPeerPid(netstat, peerPort, bridgePort);
  // A closed connection is the common benign case: the patcher can disconnect
  // between the request arriving and this lookup running. Indeterminate, not
  // hostile.
  if (!pid) return { determinate: false, why: 'no established row for the peer port' };

  const psOut = await exec('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`,
  ]);
  const exePath = parseExecutablePath(psOut);
  if (exePath) return { determinate: true, pid, exePath };

  // No path. Fall back to the image name, which is weak (trivially spoofed by
  // renaming a binary) but still refuses the obvious "python.exe asked us for
  // the paid DLLs" case.
  const tl = await exec('tasklist', ['/NH', '/FO', 'CSV', '/FI', `PID eq ${pid}`]);
  const imageName = parseTasklistImageName(tl);
  if (imageName) return { determinate: true, pid, imageName, weak: true };

  return { determinate: false, why: `could not read the image of pid ${pid}` };
}

// ── The decision ────────────────────────────────────────────────────────────
//
// THE FAILURE POSTURE, which is the whole design and is deliberately asymmetric:
//
//   determinate + matches the game  -> ALLOW
//   determinate + does NOT match    -> REFUSE   (this is the attack we can see)
//   indeterminate (any reason)      -> ALLOW, loudly
//
// Refusing when we simply could not tell would mean a Windows quirk, a locked-down
// machine or a protected process silently costs a paying customer their paid
// features. Weighed against an attacker who can, at worst, make the lookup fail
// and land back exactly where the product was before this check existed, that
// trade is not close.
//
// AND CRUCIALLY: a refusal only ever withholds the PAID assemblies. The free core
// is served regardless (see main.js handlePayloadRequest). The worst outcome of
// this whole mechanism misfiring is a launch with the free mod - which is already
// a normal, handled state (it is what happens offline, and what every free
// account gets every launch).
// Canonicalize a path for comparison. path.resolve alone is NOT enough here:
// it never touches the filesystem, so a Steam library reached through a
// junction/symlink (or an 8.3 short path) compares unequal to the same folder's
// real path - and that mismatch REFUSED the paid assemblies to genuinely
// entitled users whose only sin was a relocated Steam library. realpath follows
// links; falling back to resolve keeps this total on paths that do not exist
// (tests, unreadable exe paths).
function canonicalPath(p) {
  try { return fs.realpathSync.native(p).toLowerCase(); }
  catch {
    try { return fs.realpathSync(p).toLowerCase(); }
    catch { return path.resolve(p).toLowerCase(); }
  }
}

// `gamePath` may be a single configured folder or a LIST of acceptable folders.
// The list exists because the app can launch a HISTORICAL build from its own
// versions dir - the peer is then genuinely Gorilla Tag, launched by us, from a
// path that is not config.gamePath, and comparing against the config alone
// refused paid features on every downgraded-version launch.
function decidePayloadPeer(proc, gamePath) {
  if (!proc || !proc.determinate) {
    return { allow: true, determinate: false, reason: (proc && proc.why) || 'unknown' };
  }

  const dirs = (Array.isArray(gamePath) ? gamePath : [gamePath]).filter(Boolean);
  const expected = dirs.map((d) => path.join(d, 'Gorilla Tag.exe'));

  if (proc.exePath && expected.length) {
    const got = canonicalPath(proc.exePath);
    return expected.some((e) => canonicalPath(e) === got)
      ? { allow: true,  determinate: true, pid: proc.pid, exePath: proc.exePath }
      : { allow: false, determinate: true, pid: proc.pid, exePath: proc.exePath,
          reason: `not the configured game exe (expected ${expected.join(' or ')})` };
  }

  // No configured game path to compare against (the user has not picked a
  // folder yet). Fall back to the file NAME of the peer's exe.
  if (proc.exePath && !expected.length) {
    const base = path.basename(proc.exePath).toLowerCase();
    return base === 'gorilla tag.exe'
      ? { allow: true,  determinate: true, pid: proc.pid, exePath: proc.exePath, weak: true }
      : { allow: false, determinate: true, pid: proc.pid, exePath: proc.exePath,
          reason: 'peer is not Gorilla Tag.exe (no game folder configured to compare paths)' };
  }

  if (proc.imageName) {
    return proc.imageName.toLowerCase() === 'gorilla tag.exe'
      ? { allow: true,  determinate: true, pid: proc.pid, imageName: proc.imageName, weak: true }
      : { allow: false, determinate: true, pid: proc.pid, imageName: proc.imageName,
          reason: `peer image is ${proc.imageName}, not Gorilla Tag.exe` };
  }

  return { allow: true, determinate: false, reason: 'nothing identifying came back' };
}

// One resolution per peer port, briefly cached: the patcher retries on a backoff
// and each retry would otherwise cost another netstat + PowerShell pair. Short
// enough that a genuinely new connection (a new ephemeral port) always re-checks.
const CACHE_MS = 30_000;
let _cache = null;   // { key, at, verdict }

async function verifyPayloadPeer({ peerPort, bridgePort, gamePath, exec = run, now = Date.now }) {
  const key = `${peerPort}:${bridgePort}`;
  const t = now();
  if (_cache && _cache.key === key && t - _cache.at < CACHE_MS) return _cache.verdict;

  const proc    = await resolvePeerProcess(peerPort, bridgePort, exec);
  const verdict = decidePayloadPeer(proc, gamePath);
  _cache = { key, at: t, verdict };
  return verdict;
}

function _resetPeerCache() { _cache = null; }

module.exports = {
  parseNetstatForPeerPid,
  parseExecutablePath,
  parseTasklistImageName,
  resolvePeerProcess,
  decidePayloadPeer,
  verifyPayloadPeer,
  _resetPeerCache,
};
