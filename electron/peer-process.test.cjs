'use strict';

// Tests for electron/peer-process.cjs - the check that decides whether the
// process asking for the PAID in-game assemblies is actually Gorilla Tag.
//
// The netstat fixture below is REAL output, captured on a Windows 11 dev machine
// from a live loopback connection, not hand-written from memory. That matters:
// the parser's whole job is to tell the client row apart from the server row,
// and those two rows differ only in the order of the two addresses.
//
// Nothing here spawns a process - `exec` is injected everywhere.

const assert = require('assert');
const path   = require('path');
const {
  parseNetstatForPeerPid,
  parseExecutablePath,
  parseTasklistImageName,
  resolvePeerProcess,
  decidePayloadPeer,
  verifyPayloadPeer,
  _resetPeerCache,
} = require('./peer-process.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}
async function ta(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}

// Real `netstat -ano -p tcp` output. Peer 49330 -> bridge 52999, plus the
// listening socket and the server's view of the same connection.
const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:49330        127.0.0.1:52999        ESTABLISHED     6624',
  '  TCP    127.0.0.1:52999        0.0.0.0:0              LISTENING       6624',
  '  TCP    127.0.0.1:52999        127.0.0.1:49330        ESTABLISHED     6624',
  '  TCP    192.168.1.9:51000      140.82.121.4:443       ESTABLISHED     9001',
].join('\r\n');

// ── parseNetstatForPeerPid ──────────────────────────────────────────────────

t('finds the PID owning the client side of the connection', () => {
  assert.strictEqual(parseNetstatForPeerPid(NETSTAT, 49330, 52999), 6624);
});

t('does NOT match the server-side row (that PID is the desktop app itself)', () => {
  // Asking about the BRIDGE port as if it were a peer must find nothing;
  // otherwise every request would look like it came from our own process and
  // the check would pass for everyone, silently.
  assert.strictEqual(parseNetstatForPeerPid(NETSTAT, 52999, 49330), 6624,
    'sanity: reversed pair is a real row');
  assert.strictEqual(parseNetstatForPeerPid(NETSTAT, 52999, 52999), null);
});

t('ignores LISTENING rows', () => {
  const only = '  TCP    127.0.0.1:52999        0.0.0.0:0              LISTENING       6624';
  assert.strictEqual(parseNetstatForPeerPid(only, 52999, 52137), null);
});

// THE HALF-CLOSE BYPASS. A client can shutdown() its send side and keep reading.
// Its row then says FIN_WAIT_2, not ESTABLISHED. The first version of this
// parser required ESTABLISHED, so an attacker who half-closed became
// "unidentifiable", and the fail-open posture handed over the paid assemblies to
// a socket that could still receive them. The state must not be filtered on.
t('still identifies a peer that has half-closed (FIN_WAIT_2)', () => {
  const row = '  TCP    127.0.0.1:49330        127.0.0.1:52999        FIN_WAIT_2      6624';
  assert.strictEqual(parseNetstatForPeerPid(row, 49330, 52999), 6624);
});

t('still identifies a peer in CLOSE_WAIT', () => {
  const row = '  TCP    127.0.0.1:49330        127.0.0.1:52999        CLOSE_WAIT      6624';
  assert.strictEqual(parseNetstatForPeerPid(row, 49330, 52999), 6624);
});

t('treats TIME_WAIT (pid 0, nothing can receive) as unidentifiable', () => {
  const row = '  TCP    127.0.0.1:49330        127.0.0.1:52999        TIME_WAIT       0';
  assert.strictEqual(parseNetstatForPeerPid(row, 49330, 52999), null);
});

t('ignores non-loopback traffic', () => {
  assert.strictEqual(parseNetstatForPeerPid(NETSTAT, 51000, 443), null);
});

t('returns null for an unknown port, empty input, or junk', () => {
  assert.strictEqual(parseNetstatForPeerPid(NETSTAT, 12345, 52999), null);
  assert.strictEqual(parseNetstatForPeerPid('', 49330, 52999), null);
  assert.strictEqual(parseNetstatForPeerPid(null, 49330, 52999), null);
  assert.strictEqual(parseNetstatForPeerPid(NETSTAT, null, 52999), null);
});

// ── the other parsers ───────────────────────────────────────────────────────

t('reads a bare executable path from PowerShell', () => {
  assert.strictEqual(
    parseExecutablePath('\r\nC:\\Program Files\\nodejs\\node.exe\r\n'),
    'C:\\Program Files\\nodejs\\node.exe');
  assert.strictEqual(parseExecutablePath(''), null);
  assert.strictEqual(parseExecutablePath('\r\n\r\n'), null);
});

t('reads the image name out of tasklist CSV', () => {
  assert.strictEqual(
    parseTasklistImageName('"Gorilla Tag.exe","1234","Console","1","110,508 K"'),
    'Gorilla Tag.exe');
  assert.strictEqual(parseTasklistImageName('INFO: No tasks are running...'), null);
});

// ── decidePayloadPeer: the posture ──────────────────────────────────────────

const GAME_DIR = 'C:\\Steam\\steamapps\\common\\Gorilla Tag';
const GAME_EXE = path.join(GAME_DIR, 'Gorilla Tag.exe');

t('ALLOWS the real game exe', () => {
  const v = decidePayloadPeer({ determinate: true, pid: 42, exePath: GAME_EXE }, GAME_DIR);
  assert.strictEqual(v.allow, true);
  assert.strictEqual(v.determinate, true);
});

t('allows it regardless of path case or separators', () => {
  const odd = GAME_EXE.toUpperCase();
  assert.strictEqual(decidePayloadPeer({ determinate: true, pid: 42, exePath: odd }, GAME_DIR).allow, true);
});

t('REFUSES a different executable - the attack this exists for', () => {
  const v = decidePayloadPeer(
    { determinate: true, pid: 99, exePath: 'C:\\Users\\x\\Downloads\\unlocker.exe' }, GAME_DIR);
  assert.strictEqual(v.allow, false);
  assert.ok(/not the configured game exe/.test(v.reason));
});

t('REFUSES a renamed impostor sitting outside the game folder', () => {
  // The reason the check compares PATHS and not image names: calling your
  // binary "Gorilla Tag.exe" is free.
  const v = decidePayloadPeer(
    { determinate: true, pid: 99, exePath: 'C:\\Users\\x\\Desktop\\Gorilla Tag.exe' }, GAME_DIR);
  assert.strictEqual(v.allow, false);
});

t('ALLOWS when the peer cannot be identified at all (fails open, by design)', () => {
  const v = decidePayloadPeer({ determinate: false, why: 'netstat failed' }, GAME_DIR);
  assert.strictEqual(v.allow, true);
  assert.strictEqual(v.determinate, false);
  assert.strictEqual(v.reason, 'netstat failed');
});

t('allows on a null/garbage resolution rather than throwing', () => {
  assert.strictEqual(decidePayloadPeer(null, GAME_DIR).allow, true);
  assert.strictEqual(decidePayloadPeer(undefined, null).allow, true);
});

t('with no game folder configured, falls back to the exe FILE NAME', () => {
  const ok  = decidePayloadPeer({ determinate: true, pid: 1, exePath: 'D:\\GT\\Gorilla Tag.exe' }, null);
  const bad = decidePayloadPeer({ determinate: true, pid: 1, exePath: 'D:\\GT\\evil.exe' }, null);
  assert.strictEqual(ok.allow, true);
  assert.strictEqual(ok.weak, true);
  assert.strictEqual(bad.allow, false);
});

t('falls back to the tasklist image name when no path was readable', () => {
  const ok  = decidePayloadPeer({ determinate: true, pid: 1, imageName: 'Gorilla Tag.exe', weak: true }, GAME_DIR);
  const bad = decidePayloadPeer({ determinate: true, pid: 1, imageName: 'python.exe',      weak: true }, GAME_DIR);
  assert.strictEqual(ok.allow, true);
  assert.strictEqual(bad.allow, false);
  assert.ok(/python\.exe/.test(bad.reason));
});

// ── resolvePeerProcess: the command plumbing, with exec injected ────────────

const isWin = process.platform === 'win32';

async function main() {
  await ta('resolves pid + path through netstat then PowerShell', async () => {
    if (!isWin) return;   // the resolver short-circuits off Windows, by design
    const calls = [];
    const exec = async (file, args) => {
      calls.push(file);
      if (file === 'netstat')    return NETSTAT;
      if (file === 'powershell') {
        assert.ok(args.join(' ').includes('ProcessId=6624'), 'queries the pid netstat found');
        return GAME_EXE + '\r\n';
      }
      return null;
    };
    const got = await resolvePeerProcess(49330, 52999, exec);
    assert.deepStrictEqual(
      { determinate: got.determinate, pid: got.pid, exePath: got.exePath },
      { determinate: true, pid: 6624, exePath: GAME_EXE });
    assert.deepStrictEqual(calls, ['netstat', 'powershell'], 'no tasklist call when the path came back');
  });

  await ta('falls back to tasklist only when PowerShell yields no path', async () => {
    if (!isWin) return;
    const calls = [];
    const exec = async (file) => {
      calls.push(file);
      if (file === 'netstat')  return NETSTAT;
      if (file === 'tasklist') return '"Gorilla Tag.exe","6624","Console","1","110,508 K"';
      return '';   // powershell: empty (protected process)
    };
    const got = await resolvePeerProcess(49330, 52999, exec);
    assert.strictEqual(got.determinate, true);
    assert.strictEqual(got.imageName, 'Gorilla Tag.exe');
    assert.strictEqual(got.weak, true);
    assert.deepStrictEqual(calls, ['netstat', 'powershell', 'tasklist']);
  });

  await ta('a failed netstat is INDETERMINATE, never a refusal', async () => {
    if (!isWin) return;
    const got = await resolvePeerProcess(49330, 52999, async () => null);
    assert.strictEqual(got.determinate, false);
    assert.strictEqual(decidePayloadPeer(got, GAME_DIR).allow, true);
  });

  await ta('a closed connection (no matching row) is INDETERMINATE, not a refusal', async () => {
    if (!isWin) return;
    // The real case this protects: handlePayloadRequest awaits a Cloudflare
    // round trip, so the socket can be gone before the lookup runs. That must
    // never cost a paying customer their features.
    const got = await resolvePeerProcess(40404, 52999, async (f) => (f === 'netstat' ? NETSTAT : null));
    assert.strictEqual(got.determinate, false);
    assert.strictEqual(decidePayloadPeer(got, GAME_DIR).allow, true);
  });

  await ta('missing peer port is indeterminate', async () => {
    const got = await resolvePeerProcess(null, 52999, async () => NETSTAT);
    assert.strictEqual(got.determinate, false);
  });

  // ── verifyPayloadPeer: caching ────────────────────────────────────────────

  await ta('caches per peer port so a retry storm does not respawn netstat', async () => {
    if (!isWin) return;
    _resetPeerCache();
    let spawns = 0;
    const exec = async (file) => {
      spawns++;
      if (file === 'netstat') return NETSTAT;
      return GAME_EXE;
    };
    const a = await verifyPayloadPeer({ peerPort: 49330, bridgePort: 52999, gamePath: GAME_DIR, exec });
    const b = await verifyPayloadPeer({ peerPort: 49330, bridgePort: 52999, gamePath: GAME_DIR, exec });
    assert.strictEqual(a.allow, true);
    assert.strictEqual(b.allow, true);
    assert.strictEqual(spawns, 2, 'second call served from cache (2 spawns = netstat + powershell, once)');
  });

  await ta('a NEW connection re-checks rather than reusing the old verdict', async () => {
    if (!isWin) return;
    _resetPeerCache();
    const exec = async (file) => {
      if (file === 'netstat') {
        return '  TCP    127.0.0.1:50000        127.0.0.1:52999        ESTABLISHED     777';
      }
      return 'C:\\Users\\x\\Downloads\\unlocker.exe';
    };
    await verifyPayloadPeer({ peerPort: 49330, bridgePort: 52999, gamePath: GAME_DIR,
                              exec: async (f) => (f === 'netstat' ? NETSTAT : GAME_EXE) });
    const second = await verifyPayloadPeer({ peerPort: 50000, bridgePort: 52999, gamePath: GAME_DIR, exec });
    assert.strictEqual(second.allow, false, 'a different peer port gets its own verdict');
  });

  await ta('the cache expires', async () => {
    if (!isWin) return;
    _resetPeerCache();
    let spawns = 0;
    const exec = async (file) => { spawns++; return file === 'netstat' ? NETSTAT : GAME_EXE; };
    let clock = 1_000_000;
    const now = () => clock;
    await verifyPayloadPeer({ peerPort: 49330, bridgePort: 52999, gamePath: GAME_DIR, exec, now });
    clock += 31_000;
    await verifyPayloadPeer({ peerPort: 49330, bridgePort: 52999, gamePath: GAME_DIR, exec, now });
    assert.strictEqual(spawns, 4, 're-resolved after the TTL');
  });

  if (failed) {
    console.error(`\npeer-process: ${passed} passed, ${failed} FAILED`);
    process.exit(1);
  }
  console.log(`peer-process: ${passed} passed, 0 failed`);
}

main();
