const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// Data storage strategy:
//   1. If any data file already exists next to the exe, keep using that
//      location. This preserves true-portable setups where the user wants
//      their config/profiles to travel with the exe on a thumb drive.
//   2. Otherwise use userData (%APPDATA%\Excalibur) - survives rebuilds,
//      doesn't get wiped by portable-mode dev loops, and is the standard
//      Windows location users expect.
//   3. If both fail for some reason, tmpdir so logging doesn't explode.
// The decision is memoized on first call so reads/writes stay consistent
// within a single session.
const DATA_FILES = ['config.json', 'profiles.json', 'modmanager.log'];
let _baseDir = null;

function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.excalibur-probe');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function pickBaseDir() {
  if (_baseDir) return _baseDir;

  let exeDir = null;
  try { exeDir = path.dirname(app.getPath('exe')); } catch {}
  let userDir = null;
  try { userDir = app.getPath('userData'); } catch {}

  // 1. Honor an existing portable data set next to the exe.
  if (exeDir) {
    const hasPortableData = DATA_FILES.some((f) =>
      fs.existsSync(path.join(exeDir, f))
    );
    if (hasPortableData && probeWritable(exeDir)) {
      _baseDir = exeDir;
      return _baseDir;
    }
  }

  // 2. Default to userData so saves survive across rebuilds/reinstalls.
  if (userDir && probeWritable(userDir)) {
    _baseDir = userDir;
    return _baseDir;
  }

  // 3. Fall back to exe dir if userData isn't available for some reason.
  if (exeDir && probeWritable(exeDir)) {
    _baseDir = exeDir;
    return _baseDir;
  }

  _baseDir = path.join(os.tmpdir(), 'excalibur');
  probeWritable(_baseDir);
  return _baseDir;
}

function getWritableBaseDir() {
  return pickBaseDir();
}

// ── The rendezvous pointer ────────────────────────────────────────────────
// The in-game mod has to find config.json and bridge.token, and it runs inside
// Gorilla Tag's process: it has no idea where Excalibur.exe lives, so it cannot
// follow us into a portable directory. Its C# only ever looked in the two
// %APPDATA% locations.
//
// So when pickBaseDir() lands ANYWHERE other than the canonical
// %APPDATA%\Excalibur - a portable install next to the exe, or the tmpdir
// fallback when userData is not writable - the mod found no token, never
// connected, and every in-game feature was silently dead. No error, nothing in
// the log, just a mod that does nothing.
//
// This drops a one-line pointer at the canonical path saying where the real
// data directory is. It is the smallest thing that restores a meeting point
// without giving up portability: a single text file holding a path, no config
// and no secrets. The mod reads it first (see ConfigWatcher.LocateConfig and
// BridgeClient.ReadBridgeToken) and falls back to the old locations.
const POINTER_NAME = 'datadir.txt';

function canonicalDir() {
  try { return app.getPath('userData'); } catch { return null; }
}

// Called once at startup. Never throws: a missing pointer degrades to exactly
// the old behaviour, which is what happens today anyway.
function writeDataDirPointer() {
  try {
    const base = pickBaseDir();
    const canon = canonicalDir();
    if (!canon) return;
    const pointer = path.join(canon, POINTER_NAME);

    if (path.resolve(base) === path.resolve(canon)) {
      // Not portable. Remove a stale pointer from a previous portable run,
      // or the mod would keep following it to a directory we abandoned.
      try { if (fs.existsSync(pointer)) fs.unlinkSync(pointer); } catch { /* nbd */ }
      return;
    }

    fs.mkdirSync(canon, { recursive: true });
    fs.writeFileSync(pointer, base, 'utf8');
  } catch {
    // Pointer is best-effort. Failing to write it is not worth blocking boot.
  }
}

function getLogPath() {
  return path.join(getWritableBaseDir(), 'modmanager.log');
}

function write(level, parts) {
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${parts
      .map((p) => (p instanceof Error ? `${p.message}\n${p.stack || ''}` : String(p)))
      .join(' ')}\n`;
    fs.appendFileSync(getLogPath(), line, 'utf8');
  } catch {
    // Logging must never crash the app.
  }
}

module.exports = {
  getLogPath,
  getWritableBaseDir,
  writeDataDirPointer,
  logInfo: (...parts) => write('INFO', parts),
  logWarn: (...parts) => write('WARN', parts),
  logError: (...parts) => write('ERROR', parts),
};
