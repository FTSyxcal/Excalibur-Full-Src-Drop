// Gorilla Tag version manager - Steam-console route.
//
// We DON'T ask the user for Steam credentials. Steam itself has a
// built-in console with a `download_depot <app> <depot> <manifest>`
// command that uses whatever account is signed in to the Steam
// client. We just orchestrate it:
//
//   1. detectSteam()        - find Steam install + GT location.
//   2. prepareDownload()    - copy `download_depot ...` command to
//                             clipboard, restart Steam with -console,
//                             open the console panel via steam://.
//   3. pollDownload()       - watch Steam's content folder for the
//                             manifest's depot files; emit progress
//                             based on folder size; mark complete
//                             when the .exe lands.
//   4. finalizeDownload()   - copy/move from Steam's content folder
//                             into userData/gt-versions/<id>/ so the
//                             launch handler can run it.
//
// All this assumes Steam is installed and signed in (it is, since
// the user already plays GT). Zero extra credentials, zero extra
// binaries to download.
//
// PUBLIC API:
//   detectSteam()                                  → { steamPath, steamExe, contentBase }
//   listInstalled()                                → array of version ids
//   isInstalled(id)                                → bool
//   installPath(id) / binaryPath(id)               → string
//   removeVersion(id)                              → Promise<void>
//   prepareDownload({ versionId, manifestId })     → Promise<{ command, sourceDir }>
//   pollDownload({ versionId, manifestId }, onEvt) → cancel function
//   finalizeDownload({ versionId, manifestId })    → Promise<{ binary }>

const path     = require('node:path');
const fs       = require('node:fs');
const fsp      = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { app, clipboard, shell, BrowserWindow } = require('electron');

const GT_APP_ID   = 1533390;
const GT_DEPOT_ID = 1533391;

function root()          { return path.join(app.getPath('userData'), 'gt-versions'); }

// Every version id that reaches this module comes from the RENDERER, and the
// paths built here are handed to recursive `fsp.rm(..., { force: true })` in
// removeVersion and finalizeDownload. A bare path.join was enough for
// `gtv:remove('../../../../Documents')` to normalise clean out of userData and
// delete the user's Documents folder - which is exactly where Excalibur keeps
// recordings and replays (see ExcaliburPaths). `''` resolved to root() and
// wiped every downloaded build.
//
// So this is the chokepoint: ids are `m_<manifestId>` and nothing else (the
// rule already lives in manifestForVersionId below). Validate here rather than
// at each call site, because installPath is what binaryPath, removeVersion,
// finalizeDownload and the launch flow all build on - guarding one of them and
// missing another is how this class comes back.
const VERSION_ID_RE = /^m_\d{5,25}$/;

function assertVersionId(id) {
  if (typeof id !== 'string' || !VERSION_ID_RE.test(id)) {
    throw new Error(`Invalid Gorilla Tag version id: ${JSON.stringify(id)}`);
  }
  return id;
}

function installPath(id) {
  const dir = path.join(root(), assertVersionId(id));
  // Belt and braces: even with a validated id, re-assert containment before any
  // caller deletes what we return. A regex is a claim about the input; this is a
  // claim about the resulting path, and the delete only deserves the second one.
  const base = path.resolve(root());
  const resolved = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refusing a Gorilla Tag version path outside ${base}: ${resolved}`);
  }
  return dir;
}

function binaryPath(id)  { return path.join(installPath(id), 'Gorilla Tag.exe'); }

async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }

// ── Manifest attribution ─────────────────────────────────────────────
//
// THE BUG THIS EXISTS TO KILL: Steam's `download_depot` always writes to the
// SAME folder - steamapps/content/app_<app>/depot_<depot> - with nothing in it
// naming the manifest. This module used to treat "a Gorilla Tag.exe exists in
// there" as "the build the user asked for has downloaded". So the second
// version you ever downloaded silently got the FIRST one's files copied into
// its folder, and every version after that too. That is the tester report
// "it's on the wrong version" / "it only ever opens the old one I downloaded".
//
// Steam gives us nothing to attribute those files with, so we keep our own
// receipt. It lives in OUR folder, not Steam's, precisely so that wiping
// Steam's content folder (which we now do before every download) cannot take
// the receipt with it.
function pendingFile() { return path.join(root(), '_pending-download.json'); }

function readPending() {
  try { return JSON.parse(fs.readFileSync(pendingFile(), 'utf8')); } catch { return null; }
}
function writePending(obj) {
  try {
    fs.mkdirSync(root(), { recursive: true });
    fs.writeFileSync(pendingFile(), JSON.stringify(obj, null, 2));
  } catch { /* attribution degrades to "cannot prove it", which fails closed */ }
}
function clearPending() { try { fs.rmSync(pendingFile(), { force: true }); } catch {} }

// Every managed install carries a receipt naming the manifest it was built
// from. `isInstalled` uses it to refuse to call a folder by a name it cannot
// prove, and the launch path uses it to refuse to run a mislabelled build.
function versionMetaFile(id) { return path.join(installPath(id), '.excalibur-version.json'); }

function readVersionMeta(id) {
  try { return JSON.parse(fs.readFileSync(versionMetaFile(id), 'utf8')); } catch { return null; }
}

// Version ids are `m_<manifestId>` (see manifestToEntry in src/lib/gt-versions.js),
// so the id itself states which manifest the folder is supposed to hold. That
// makes verification self-contained - main never needs the renderer's catalog.
function manifestForVersionId(id) {
  if (typeof id !== 'string') return null;
  const m = id.match(/^m_(\d{5,25})$/);
  return m ? m[1] : null;
}

// Steam caches the manifest it fetched as depotcache/<depot>_<manifest>.manifest.
// Used only to make failures explain themselves - attribution never depends on
// Steam internals, which are free to change.
function depotCacheHasManifest(steamPath, manifestId) {
  try {
    return fs.existsSync(path.join(steamPath, 'depotcache', `${GT_DEPOT_ID}_${manifestId}.manifest`));
  } catch { return false; }
}

// ── Steam's console log: the authoritative record ────────────────────
//
// Steam narrates depot downloads into logs/console_log.txt, and it tells us
// everything the old folder-watching guesswork tried to infer:
//
//   Downloading depot 1533391 (188 files, 61 MB) ...
//   Depot download complete : "…\depot_1533391" (manifest 2218992975128065135)
//   Depot download failed : Failed downloading 1 manifests (No connection)
//
// That gives a real size target, a real completion signal, the exact source
// path, the MANIFEST ID (attribution straight from Steam rather than inferred),
// and Steam's own words when something goes wrong. Verified by running real
// downloads against this machine's Steam client.
function consoleLogPath(steamPath) {
  return path.join(steamPath, 'logs', 'console_log.txt');
}

function logSize(steamPath) {
  try { return fs.statSync(consoleLogPath(steamPath)).size; } catch { return 0; }
}

// Steam keeps this file open, so read it by descriptor rather than with
// readFileSync's default flags, and never take an exclusive handle.
function readLogFrom(steamPath, offset) {
  const file = consoleLogPath(steamPath);
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    // The log rotates (console_log.previous.txt); if it shrank, start over.
    const from = size < offset ? 0 : offset;
    if (size <= from) return { text: '', offset: size };
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    return { text: buf.toString('utf8'), offset: size };
  } catch {
    return { text: '', offset };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

const RE_START    = /Downloading depot (\d+)\s*\((\d+) files,\s*([\d.]+)\s*([KMGT]?B)\)/i;
const RE_COMPLETE = /Depot download complete\s*:\s*"([^"]+)"\s*\(manifest (\d+)\)/i;
const RE_FAILED   = /Depot download failed\s*:\s*(.+)/i;

// Scans a chunk of log text for the depot lines we care about. Returns the LAST
// of each kind, so a re-run inside the same window supersedes an earlier line.
function parseDepotLog(text) {
  const out = { started: null, complete: null, failed: null };
  for (const line of String(text || '').split('\n')) {
    let m = line.match(RE_COMPLETE);
    if (m) { out.complete = { sourcePath: m[1], manifestId: m[2] }; continue; }
    m = line.match(RE_FAILED);
    if (m) { out.failed = m[1].trim(); continue; }
    m = line.match(RE_START);
    if (m) {
      const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[4].toUpperCase()] || 1;
      out.started = { depotId: m[1], files: Number(m[2]), bytes: Math.round(parseFloat(m[3]) * mult) };
    }
  }
  return out;
}

// Windows lock errors. EBUSY is the one Steam produces, but a file can also
// come back EPERM or EACCES while another process still holds it, and a
// virus scanner opening the file mid-copy looks identical.
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY']);

// Wipe Steam's depot output. Called BEFORE a download (so leftovers from a
// previous manifest cannot be mistaken for this one) and AFTER a successful
// finalize (so 1-3 GB isn't left lying around to confuse the next download).
async function clearSteamContent() {
  try {
    const steam = await detectSteam();
    if (!steam) return false;
    if (!fs.existsSync(steam.contentBase)) return true;
    // Retrying matters most on the AFTER-finalize call: Steam has usually not
    // let go of the depot files yet, so a single attempt tends to fail and
    // leave 1-3 GB behind for the next download to trip over.
    await rmTreeWithRetry(steam.contentBase);
    return true;
  } catch { return false; }
}

// Is the payload sitting in Steam's content folder provably the manifest we
// asked for? Requires our own receipt to say so AND the binary to be newer
// than the moment we started. Anything else is "cannot prove it" and fails
// closed - the old code failed OPEN, which is the entire bug.
function attributionOk(manifestId, exePath, { slackMs = 60_000 } = {}) {
  const pending = readPending();
  if (!pending)                              return { ok: false, reason: 'no-receipt' };
  if (!manifestId)                           return { ok: false, reason: 'no-manifest-requested' };
  if (String(pending.manifestId) !== String(manifestId)) {
    return { ok: false, reason: 'different-manifest', receiptManifest: pending.manifestId };
  }
  try {
    const mtime = fs.statSync(exePath).mtimeMs;
    if (mtime + slackMs < pending.startedAt) return { ok: false, reason: 'older-than-request' };
  } catch                                    { return { ok: false, reason: 'exe-unreadable' }; }
  return { ok: true };
}

// ── Steam detection (mirrors electron/steam.cjs) ─────────────────────
function readSteamPath() {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const m = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
        if (!m) return resolve(null);
        resolve(m[1].trim().replace(/\//g, '\\'));
      }
    );
  });
}

async function detectSteam() {
  // Override exists so the attribution tests can point the whole module at a
  // temp directory. Without it a test of "wipe Steam's depot folder" would
  // wipe the developer's real one. Also a genuine escape hatch for an install
  // the registry lookup can't find.
  const steamPath = process.env.EXCALIBUR_STEAM_PATH_OVERRIDE || await readSteamPath();
  if (!steamPath) return null;
  const steamExe = path.join(steamPath, 'steam.exe');
  // download_depot lands files at:
  //   <steamPath>/steamapps/content/app_<APP>/depot_<DEPOT>/<manifest_subfolder>/
  // The exact subfolder layout depends on Steam build, but the depot
  // root is stable.
  const contentBase = path.join(steamPath, 'steamapps', 'content', `app_${GT_APP_ID}`, `depot_${GT_DEPOT_ID}`);
  return { steamPath, steamExe, contentBase };
}

// ── Installed-version queries ────────────────────────────────────────
function listInstalled() {
  const dir = root();
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name)
      // Drop anything that is not a real version folder BEFORE building a path
      // from it. installPath now throws on a malformed id, and the catch below
      // swallows the whole listing - so without this filter one stray directory
      // in gt-versions/ would make every installed build vanish from the UI.
      .filter((id) => VERSION_ID_RE.test(id))
      .filter((id) => fs.existsSync(binaryPath(id)));
  } catch { return []; }
}

// Same list, plus whether each folder can PROVE it holds the build its name
// claims. Installs made before receipts existed come back `verified: false`
// with reason 'no-receipt' - they are exactly the ones that may be the wrong
// build, so the UI can offer a re-download instead of lying to the user.
// How much disk a build is actually using, so the UI can tell the user what
// removing it gives back rather than asking them to delete something unnamed.
// ASYNC, deliberately. A Gorilla Tag install is multiple gigabytes across
// thousands of files, and this walked all of it with readdirSync/statSync on the
// MAIN process - the same process that serves every IPC call and pumps the
// window. It runs on every visit to the Versions page (via
// listInstalledDetailed), so opening that page froze the entire UI for as long
// as the walk took.
//
// fs.promises yields between operations, so the event loop keeps breathing.
// Same traversal, same result; it simply stops holding the process hostage.
async function folderSize(dir) {
  let bytes = 0, files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      files++;
      try { bytes += (await fsp.stat(full)).size; } catch { /* vanished mid-walk */ }
    }
  }
  return { bytes, files };
}

async function installedInfo(id) {
  const exists = fs.existsSync(binaryPath(id));
  if (!exists) return { id, installed: false, verified: false, reason: 'not-installed', bytes: 0, files: 0 };
  const size = await folderSize(installPath(id));
  const base = { id, installed: true, ...size };
  const expected = manifestForVersionId(id);
  const meta = readVersionMeta(id);
  if (!meta)               return { ...base, verified: false, reason: 'no-receipt', expected };
  if (!expected)           return { ...base, verified: true,  reason: 'no-manifest-in-id', meta };
  if (String(meta.manifestId) !== String(expected)) {
    return { ...base, verified: false, reason: 'manifest-mismatch', expected, actual: meta.manifestId, meta };
  }
  return { ...base, verified: true, meta };
}

// Promise.all rather than a sequential loop: the walks are I/O bound and
// independent, so several installs cost about what one does.
async function listInstalledDetailed() { return Promise.all(listInstalled().map(installedInfo)); }

// A query, not a mutation: a malformed id means "no, that is not installed",
// not an error the UI should surface. The destructive paths below deliberately
// do the opposite and throw.
function isInstalled(id) {
  if (!VERSION_ID_RE.test(String(id ?? ''))) return false;
  return fs.existsSync(binaryPath(id));
}

async function removeVersion(id) {
  const p = installPath(id);
  if (!fs.existsSync(p)) return;
  try {
    await rmTreeWithRetry(p);
  } catch (e) {
    if (LOCK_CODES.has(e.code)) {
      throw new Error(
        'That version is still in use, so it could not be deleted. '
        + 'Close Gorilla Tag if it is running and try again.',
      );
    }
    throw e;
  }
}

// ── Check if Steam has already downloaded the files ─────────────────
// Walks <steamPath>/steamapps/content/app_X/depot_Y/ looking for
// Gorilla Tag.exe. If present, returns the parent folder so the
// caller can skip the Steam-console flow and finalize directly.
// This is what lets a re-opened modal skip the Steam popup when the
// user already ran download_depot in a previous session.
async function checkSteamFolder({ manifestId } = {}) {
  const steam = await detectSteam();
  if (!steam) return { found: false, reason: 'no-steam' };
  if (!fs.existsSync(steam.contentBase)) return { found: false, reason: 'no-content-folder' };
  let exePath    = null;
  let totalBytes = 0;
  let fileCount  = 0;
  const stack = [steam.contentBase];
  try {
    while (stack.length) {
      const d = stack.pop();
      // Async for the same reason folderSize is: this runs every 2 seconds
      // for the whole duration of a download, over Steam's content folder -
      // the multi-GB tree being written to at that very moment.
      const entries = await fsp.readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        fileCount++;
        try { totalBytes += (await fsp.stat(full)).size; } catch {}
        if (e.name.toLowerCase() === 'gorilla tag.exe') exePath = full;
      }
    }
  } catch { /* directory churn - caller can retry */ }
  if (!exePath) return { found: false, reason: 'no-exe' };

  // Steam's log is the strongest evidence available: it names the manifest it
  // finished. Prefer it over our own receipt, which only records what we asked
  // for and therefore cannot notice a different download arriving in the shared
  // folder.
  try {
    const pending = readPending();
    const { text } = readLogFrom(steam.steamPath, pending?.logOffset ?? 0);
    const parsed = parseDepotLog(text);
    if (parsed.complete) {
      if (String(parsed.complete.manifestId) !== String(manifestId)) {
        return {
          found: false,
          reason: 'different-manifest',
          unattributed: true,
          receiptManifest: parsed.complete.manifestId,
          bytes: totalBytes,
          files: fileCount,
        };
      }
      return {
        found: true,
        sourcePath: parsed.complete.sourcePath,
        manifestId,
        confirmedBySteam: true,
        bytes: totalBytes,
        files: fileCount,
      };
    }
  } catch { /* fall through to the receipt check below */ }

  // An exe alone proves nothing about WHICH build it is. Steam reuses one
  // folder for every manifest, so without a matching receipt this is most
  // likely the previous version the user downloaded - which is exactly what
  // used to get copied in under the new version's name.
  const attr = attributionOk(manifestId, exePath);
  if (!attr.ok) {
    return {
      found: false,
      reason: attr.reason,
      unattributed: true,
      receiptManifest: attr.receiptManifest || null,
      steamHasManifest: manifestId ? depotCacheHasManifest(steam.steamPath, manifestId) : null,
      bytes: totalBytes,
      files: fileCount,
    };
  }
  return {
    found: true,
    sourcePath: path.dirname(exePath),
    bytes: totalBytes,
    files: fileCount,
    manifestId,
  };
}

// ── Prepare download ────────────────────────────────────────────────
// 1. Copy the depot command to clipboard.
// 2. Spawn Steam with -console so the console panel is enabled.
// 3. Open the console via the steam:// URL.
//
// The user sees Steam come to front with the console tab open; they
// paste (Ctrl+V) and hit Enter to start the download.
async function prepareDownload({ versionId, manifestId }) {
  if (!versionId || !manifestId) {
    throw new Error('Missing versionId or manifestId.');
  }
  const steam = await detectSteam();
  if (!steam) throw new Error('Steam not detected on this PC.');

  // Order matters. Wipe Steam's depot output BEFORE the user starts the new
  // download, so the only Gorilla Tag.exe that can appear in there afterwards
  // is the one they just asked for. Leaving the previous build in place is
  // what let the wrong version be adopted under a new name.
  await clearSteamContent();

  // Write the receipt AFTER the wipe (it lives in our folder, so the wipe
  // cannot eat it) and BEFORE the download can produce any files, so the
  // mtime comparison in attributionOk has a valid floor.
  //
  // `logOffset` is the important field: everything after this point in Steam's
  // console log belongs to THIS request, which is how the poller reads Steam's
  // own verdict instead of guessing from folder contents.
  writePending({
    versionId,
    manifestId: String(manifestId),
    startedAt: Date.now(),
    contentBase: steam.contentBase,
    steamPath: steam.steamPath,
    logOffset: logSize(steam.steamPath),
  });

  const command = `download_depot ${GT_APP_ID} ${GT_DEPOT_ID} ${manifestId}`;
  // Still copied as a manual fallback, but nothing depends on the user pasting
  // it any more - see runDepotCommand below.
  clipboard.writeText(command);

  // THE WHOLE DOWNLOAD, IN ONE LINE.
  //
  // Steam accepts console commands as command-line arguments: passing
  // `+download_depot <app> <depot> <manifest>` makes the running client run it
  // immediately. Verified against this machine's Steam:
  //
  //   ExecCommandLine: "steam.exe" -console +download_depot 1533390 1533391 2218…
  //   Downloading depot 1533391 (188 files, 61 MB) ...
  //   Depot download complete : "…\depot_1533391" (manifest 2218…)
  //
  // No clipboard, no SendKeys, no stealing the foreground, and nothing for the
  // user to paste. The previous approach - copy to clipboard, raise Steam's
  // console, fire Ctrl+V at whatever had focus - was fragile at its very best,
  // and had in fact never once worked (it hunted for a window title Steam
  // stopped using years ago).
  spawn(steam.steamExe, [
    '-console',
    '+download_depot', String(GT_APP_ID), String(GT_DEPOT_ID), String(manifestId),
  ], { detached: true, windowsHide: true }).unref();

  // Bring the console into view so a download that needs attention (Steam
  // Guard, an ownership prompt) is visible rather than stuck behind the app.
  setTimeout(() => { shell.openExternal('steam://open/console').catch(() => {}); }, 1200);

  const sourceDir = steam.contentBase;
  return { command, sourceDir, autoRan: true };
}

// ── Poll Steam's content folder for the download ─────────────────────
// Steam writes files into <steamPath>/steamapps/content/app_X/depot_Y/<...>/.
// We don't know the exact subfolder name Steam uses (it varies), so
// we recursively look for the Gorilla Tag .exe and track total folder
// size as a rough progress estimate.
//
// Emits:
//   { kind: 'searching' }                              - before any files appear
//   { kind: 'progress', bytes, megabytes, files }      - once files start landing
//   { kind: 'done', sourcePath }                       - .exe detected
//   { kind: 'error', message }                         - fatal
function pollDownload({ versionId, manifestId }, onEvent) {
  let cancelled = false;
  let lastBytes = 0;
  let stableTicks = 0;
  // Everything Steam has said since this request started.
  let logCursor = null;
  let expectedBytes = 0;
  let expectedFiles = 0;

  async function tick() {
    if (cancelled) return;
    const steam = await detectSteam();
    if (!steam) {
      onEvent({ kind: 'error', message: 'Lost track of Steam install path.' });
      return;
    }

    // ── Steam's own account of this download, which beats every inference we
    // can make from the folder. It names the manifest, so a download of a
    // DIFFERENT version landing in that shared folder is caught rather than
    // adopted - which is exactly how the wrong build used to get installed.
    const pending = readPending();
    if (logCursor === null) logCursor = pending?.logOffset ?? logSize(steam.steamPath);
    const chunk = readLogFrom(steam.steamPath, logCursor);
    const events = parseDepotLog(chunk.text);
    // Deliberately do NOT advance the cursor: re-reading from the start of this
    // request each tick keeps the completion line visible even if it arrived
    // while we were mid-copy, and the log slice is a few KB at most.

    if (events.started) {
      expectedBytes = events.started.bytes || 0;
      expectedFiles = events.started.files || 0;
    }
    if (events.failed) {
      onEvent({ kind: 'error', message: `Steam could not download this build: ${events.failed}` });
      return;
    }
    if (events.complete) {
      if (String(events.complete.manifestId) !== String(manifestId)) {
        // Steam finished a download for a different manifest than the one we
        // asked for - someone else's request landed in the shared folder.
        onEvent({
          kind: 'error',
          message: 'Steam finished downloading a different Gorilla Tag version than the one you picked, so nothing was installed. Try the download again.',
          reason: 'manifest-mismatch',
        });
        return;
      }
      onEvent({
        kind: 'done',
        sourcePath: events.complete.sourcePath,
        manifestId: events.complete.manifestId,
        confirmedBySteam: true,
      });
      return;
    }

    const base = steam.contentBase;
    if (!fs.existsSync(base)) {
      onEvent({ kind: 'searching', expectedBytes, expectedFiles });
      return scheduleNext();
    }

    // Walk the depot folder to gather files + total size, and look
    // for the actual Gorilla Tag binary.
    let totalBytes = 0;
    let fileCount  = 0;
    let exePath    = null;
    const stack = [base];
    try {
      while (stack.length) {
        const d = stack.pop();
        // Async for the same reason folderSize is: this runs every 2 seconds
      // for the whole duration of a download, over Steam's content folder -
      // the multi-GB tree being written to at that very moment.
      const entries = await fsp.readdir(d, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) { stack.push(full); continue; }
          fileCount++;
          try { totalBytes += (await fsp.stat(full)).size; } catch {}
          if (e.name.toLowerCase() === 'gorilla tag.exe') exePath = full;
        }
      }
    } catch { /* directory churn while Steam writes - ignore and retry */ }

    onEvent({
      kind: 'progress',
      bytes: totalBytes,
      megabytes: Math.round(totalBytes / (1024 * 1024)),
      files: fileCount,
      // Steam told us the real size up front, so the UI can show actual
      // progress instead of a bar that fills on a guess.
      expectedBytes,
      expectedFiles,
    });

    // Completion heuristic: exe is present AND the folder hasn't
    // grown for ~6 seconds. (Steam writes the exe early but isn't
    // done until other assets settle.)
    if (exePath) {
      if (totalBytes === lastBytes) {
        stableTicks++;
        if (stableTicks >= 3) {
          // Settled - but settled on WHAT? Without this check a leftover build
          // sitting in Steam's folder reads as an instantly-finished download
          // (it never grows, so it is "stable" on the very first tick).
          const attr = attributionOk(manifestId, exePath);
          if (!attr.ok) {
            onEvent({
              kind: 'error',
              message: attr.reason === 'different-manifest'
                ? 'The files in Steam\'s download folder belong to a different version. Start the download again from the Versions page.'
                : 'Could not confirm these files are the version you asked for, so they were not used. Start the download again from the Versions page.',
              reason: attr.reason,
            });
            return; // stop polling - do NOT hand unattributed files to finalize
          }
          const sourceDir = path.dirname(exePath);
          onEvent({ kind: 'done', sourcePath: sourceDir, manifestId });
          return; // stop polling
        }
      } else {
        stableTicks = 0;
      }
    }
    lastBytes = totalBytes;
    scheduleNext();
  }

  function scheduleNext() {
    if (cancelled) return;
    // `tick` is async and was passed straight to setTimeout, so nothing was
    // holding its promise. Two things went wrong when it threw - and it can,
    // because onEvent() ends in webContents.send, which throws once the window
    // is destroyed (closing the app mid-download does exactly that):
    //
    //   1. an unhandled rejection in the MAIN process, and
    //   2. tick() calls scheduleNext() as its LAST statement, so throwing
    //      anywhere before that silently ended the poll. The download UI then
    //      sat at whatever percentage it had reached, forever, with no error
    //      and no way to recover short of restarting the app.
    //
    // Catch, log, and keep polling: one bad tick is not a reason to abandon a
    // download that is still running.
    setTimeout(() => {
      tick().catch((e) => {
        try { require('./logger.cjs').logError('[gtv] download poll tick failed:', e && e.message); } catch { /* logging must not end the poll */ }
        scheduleNext();
      });
    }, 2000);
  }

  scheduleNext();
  return function cancel() { cancelled = true; };
}

// Copy one file, waiting out a transient lock. Backs off 200ms, 400ms, 800ms,
// 1.6s, 3.2s - about six seconds total, which comfortably covers Steam
// finishing with a depot file. Anything still locked after that is not
// transient and the caller gets a message naming the file.
async function copyFileWithRetry(src, dst, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      await fsp.copyFile(src, dst);
      return;
    } catch (e) {
      if (!LOCK_CODES.has(e.code) || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 200 * (2 ** i)));
    }
  }
}

// Recursive delete that waits out a lock instead of dying on it. Deleting is
// exposed to exactly the same problem as copying: the folder being replaced is
// the one the game runs from, so a Gorilla Tag that is still shutting down (or
// a virus scanner reading a DLL) makes the wipe fail and the install never
// reaches the copy at all. Node's own maxRetries/retryDelay exists for this
// case on Windows and backs off linearly - 200ms, 400ms ... 1.2s.
async function rmTreeWithRetry(target) {
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}

// Recursive copy that retries per FILE rather than failing the whole tree.
// A Gorilla Tag build is thousands of files and Steam typically holds one or
// two of them for a moment; restarting the entire copy for that would be both
// slower and, since the lock may move to a different file, not obviously
// convergent.
async function copyTreeWithRetry(srcDir, dstDir) {
  await ensureDir(dstDir);
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(srcDir, e.name);
    const d = path.join(dstDir, e.name);
    if (e.isDirectory()) {
      await copyTreeWithRetry(s, d);
    } else if (e.isSymbolicLink()) {
      // Steam depots contain none, but never follow one blindly into a copy.
      continue;
    } else {
      try {
        await copyFileWithRetry(s, d);
      } catch (e2) {
        if (LOCK_CODES.has(e2.code)) {
          throw new Error(
            `Windows is still holding "${e.name}" open, so the install could not finish. `
            + 'This is usually Steam still working on the download. '
            + 'Wait a few seconds, make sure Gorilla Tag is closed, and try again.',
          );
        }
        throw e2;
      }
    }
  }
}

// ── Finalize download ───────────────────────────────────────────────
// Copies the downloaded depot contents from Steam's content folder
// into our managed gt-versions/<id>/ folder. After this, isInstalled()
// returns true and the launch handler can run binaryPath(id).
async function finalizeDownload({ versionId, manifestId, sourcePath, confirmedManifestId }) {
  if (!versionId || !sourcePath) throw new Error('Missing versionId or sourcePath.');
  if (!fs.existsSync(sourcePath)) throw new Error('Source folder not found.');

  // The id states which manifest this folder is supposed to hold; trust it over
  // a caller-supplied value so a renderer bug cannot mislabel an install.
  const expected = manifestForVersionId(versionId) || (manifestId ? String(manifestId) : null);

  // What Steam SAYS it downloaded beats what we asked for. Our own receipt only
  // records the request, so if a different download lands in Steam's shared
  // folder in the meantime, the receipt still "matches" and the wrong build gets
  // installed under the right name. That is not hypothetical: it happened on the
  // author's machine while testing, and produced a 136 MB "Update #106" that was
  // really the 2021 launch build.
  const steamSaid = confirmedManifestId
    ? String(confirmedManifestId)
    : await (async () => {
        try {
          const steam = await detectSteam();
          const pending = readPending();
          if (!steam) return null;
          const { text } = readLogFrom(steam.steamPath, pending?.logOffset ?? 0);
          return parseDepotLog(text).complete?.manifestId || null;
        } catch { return null; }
      })();

  if (steamSaid && expected && steamSaid !== expected) {
    throw new Error(
      `Steam downloaded a different build (manifest ${steamSaid}) than the one you picked, so nothing was installed. Start the download again.`
    );
  }

  // Last line of defence. finalize is reachable from the fast path, the poller
  // and (historically) a re-mounted modal, so the check belongs here too rather
  // than only at the call sites.
  const exeIn = path.join(sourcePath, 'Gorilla Tag.exe');
  if (fs.existsSync(exeIn)) {
    const attr = attributionOk(expected, exeIn);
    if (!attr.ok) {
      throw new Error(
        attr.reason === 'different-manifest'
          ? 'Those files are a different Gorilla Tag version than the one you picked, so they were not installed. Start the download again.'
          : 'Could not confirm those files are the version you picked, so they were not installed. Start the download again.'
      );
    }
  }

  const dest = installPath(versionId);
  // Wipe first. `fs.cp` merges, so copying a smaller build over a larger one
  // used to leave the previous build's extra files behind - a folder that is
  // two versions blended together, which is far worse than either.
  try {
    await rmTreeWithRetry(dest);
  } catch (e) {
    if (LOCK_CODES.has(e.code)) {
      throw new Error(
        'The copy of this version already on your PC is still in use, so it could not be replaced. '
        + 'Close Gorilla Tag if it is running, wait a few seconds, and try again.',
      );
    }
    throw e;
  }
  await ensureDir(dest);

  // Copy recursively, retrying individual files that Windows has locked.
  //
  // This used to be a single `fsp.cp(..., { recursive: true })`, which is
  // all-or-nothing: ONE locked file aborts the entire install and the user gets
  //
  //   EBUSY: resource busy or locked, copyfile
  //   '...\depot_1533391\Gorilla Tag_Data\level0.resS' -> '...'
  //
  // and no game. That happens routinely because the source is Steam's own
  // download folder and Steam has usually not let go of the files yet - it is
  // still flushing, verifying, or simply holding handles open. The lock clears
  // on its own within seconds, so the only thing missing was patience.
  await copyTreeWithRetry(sourcePath, dest);

  if (!fs.existsSync(binaryPath(versionId))) {
    throw new Error('Copy completed but Gorilla Tag.exe is missing from destination.');
  }

  // The receipt. This is what lets every later read - the installed list, the
  // launch guard - state which build this folder actually holds instead of
  // inferring it from the folder's name.
  try {
    fs.writeFileSync(versionMetaFile(versionId), JSON.stringify({
      versionId,
      manifestId: expected,
      // Whether Steam's own log confirmed this manifest, as opposed to us
      // merely having asked for it. Only the former is real proof.
      steamConfirmed: !!steamSaid,
      confirmedManifestId: steamSaid || null,
      finalizedAt: Date.now(),
      sourcePath,
    }, null, 2));
  } catch (e) {
    throw new Error(`Installed, but could not write the version receipt: ${e.message}`);
  }

  // Success: drop the receipt for the in-flight download and reclaim the 1-3 GB
  // Steam left in its content folder. Also means the NEXT download starts from
  // an empty folder even if prepareDownload's wipe is ever skipped.
  clearPending();
  await clearSteamContent();

  return { binary: binaryPath(versionId), manifestId: expected };
}

// ── SteamDB manifest scraper ─────────────────────────────────────────
// Pull the full manifest history for depot 1533391 (GT Windows depot)
// straight off SteamDB. SteamDB blocks plain HTTP scrapers via
// Cloudflare, but a real Chromium BrowserWindow passes the challenge
// transparently - Electron IS a real browser. We open the page in a
// hidden window, wait for the manifests table to render, then exec
// a small DOM scrape and return the rows.
//
// Cached on disk so we don't re-scrape on every dropdown open. Cache
// busts after CACHE_TTL_MS (4h).
const MANIFESTS_URL = `https://steamdb.info/depot/${GT_DEPOT_ID}/manifests/`;
const CACHE_TTL_MS  = 4 * 60 * 60 * 1000;
function cacheFile() { return path.join(root(), 'manifests-cache.json'); }

function readManifestCache() {
  try {
    const raw = fs.readFileSync(cacheFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj?.fetchedAt || !Array.isArray(obj?.manifests)) return null;
    return { ...obj, expired: Date.now() - obj.fetchedAt > CACHE_TTL_MS };
  } catch { return null; }
}
function writeManifestCache(manifests) {
  try {
    fs.mkdirSync(root(), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: Date.now(), manifests }, null, 2));
  } catch {}
}

// Module-level lock - prevents two scrapes from running concurrently
// against the same `persist:steamdb` session, which deadlocks the
// shared webRequest handler. Foreground + background prefetch both
// going at once was the most likely cause of "frozen at 5%".
let _scrapeInflight = null;

async function scrapeSteamDB(opts = {}) {
  if (_scrapeInflight) return _scrapeInflight;
  _scrapeInflight = (async () => {
    try { return await _doScrape(opts); }
    finally { _scrapeInflight = null; }
  })();
  return _scrapeInflight;
}

// `maxWaitMs` overrides how long the visible window waits for the Cloudflare
// challenge to be solved. The in-app default of 2 minutes is right when a user
// clicked "refresh" and is sitting there watching. It is far too short when the
// scrape is kicked off by a maintenance script (npm run gt:fetch-manifests) and
// the person has to notice the window first: that run wasted a full attempt
// timing out with nobody at the keyboard.
async function _doScrape({ onProgress, visible = false, maxWaitMs = null } = {}) {
  // Monotonic ETA tracker - decreases at most ~1× real time, never
  // jumps backwards or skyrockets. Projection uses elapsed-time vs.
  // current-percent to extrapolate the remaining work; we then clamp
  // against the previous value so the displayed countdown is smooth.
  const startTime    = Date.now();
  let   lastEta      = visible ? 35000 : 15000;
  let   lastEtaAt    = startTime;
  function eta(percent) {
    const now     = Date.now();
    const elapsed = now - startTime;
    const dt      = now - lastEtaAt;
    const projected = percent > 5
      ? elapsed * (100 - percent) / percent
      : lastEta;
    // Decrease at most by elapsed real time + 200ms slack so the
    // countdown ticks down smoothly even when progress stalls.
    const maxAllowed = Math.max(0, lastEta - dt - 0);
    const next       = Math.max(500, Math.min(maxAllowed, projected));
    lastEta = next; lastEtaAt = now;
    return next;
  }
  const emit = (data) => {
    try {
      const e = data.etaMs != null ? data.etaMs : eta(data.percent || 0);
      onProgress?.({ ...data, etaMs: e, visible });
    } catch {}
  };
  emit({ percent: 5, status: visible
    ? "Cloudflare check needed - solve it in the popup"
    : 'Opening SteamDB…' });

  let win = null;
  try {
    win = new BrowserWindow({
      show: visible,
      width: 1100,
      height: 800,
      title: visible
        ? 'Excalibur · Solve the Cloudflare check'
        : 'Excalibur · SteamDB fetch',
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: false,
        contextIsolation: true,
        partition: 'persist:steamdb',
        backgroundThrottling: false,
      },
    });

  // Let this window navigate. The global will-navigate guard in main.js blocks
  // every external navigation and re-opens it in the user's browser, which for
  // the Cloudflare challenge meant the scrape could never finish AND the person
  // got a pile of surprise browser tabs. This window carries NO preload, so the
  // reason that guard exists does not apply to it.
  try { win.webContents.excaliburAllowExternalNav = true; } catch { /* window already gone */ }
    emit({ percent: 8, status: visible ? 'Loading SteamDB…' : 'Setting up browser…' });

    // ── Why this is DERIVED and not hardcoded ────────────────────────────────
    // This used to claim `Chrome/124.0.0.0`. Electron 31 is Chromium **126**,
    // and that one-line lie is what made the Cloudflare challenge unsolvable:
    // the checkbox ticks, clears, and then resets, forever, no matter how many
    // times a human clicks it.
    //
    // The reason is that the UA string is only ONE of the things Cloudflare
    // reads. Chromium also sends `Sec-CH-UA` client hints and a TLS/JA3
    // fingerprint, and it generates BOTH from its real version - we cannot spoof
    // those from here. So every request said "I am Chrome 124" in the header and
    // "I am Chrome 126" in everything else. That mismatch is a bot signal, so
    // Turnstile issued a clearance and immediately invalidated it, which is
    // exactly the loop that gets reported as "I keep clicking and nothing
    // happens".
    //
    // Taking Chromium's own UA and removing only the `Electron/x.y.z` token
    // leaves a genuine, self-consistent Chrome identity: the version in the
    // string is the version that is actually running, so the header, the client
    // hints and the fingerprint all agree.
    //
    // Do NOT re-hardcode a version here. It will look fine, and it will silently
    // rot into this same infinite loop the next time Electron is upgraded.
    const realUA  = win.webContents.getUserAgent();
    const cleanUA = realUA.replace(/\s*Electron\/[\d.]+/i, '');
    win.webContents.setUserAgent(cleanUA);

    // Previously we blocked images / fonts / analytics to speed up
    // page load AND removed navigator.webdriver to fool bot detection.
    // Both interfered with Cloudflare's interactive challenge - the
    // checkbox SVG was blocked, and the webdriver override is itself
    // a known bot fingerprint these days. We just let Chromium be
    // itself now. Slightly slower, but the challenge actually works.

    emit({ percent: 12, status: 'Connecting to SteamDB…' });

    const LOAD_TIMEOUT = visible ? 90000 : 25000;
    await Promise.race([
      win.loadURL(MANIFESTS_URL),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SteamDB took too long to respond.')), LOAD_TIMEOUT)
      ),
    ]);

    emit({ percent: 25, status: visible
      ? 'Waiting for Cloudflare check to pass…'
      : 'Waiting for SteamDB content…' });

    // Poll for manifest rows. Visible mode gives the user a generous
    // window to solve Cloudflare; hidden mode bails sooner.
    let rowCount    = 0;
    let stable      = 0;
    let waited      = 0;
    let lastPercent = 30;
    const MAX_WAIT  = maxWaitMs || (visible ? 120000 : 30000);
    const TICK      = 300;
    const FAST_BAIL = 40;

    while (waited < MAX_WAIT) {
      await new Promise((r) => setTimeout(r, TICK));
      waited += TICK;

      const count = await win.webContents.executeJavaScript(`
        (() => {
          let n = 0;
          const rows = document.querySelectorAll('tr, [role="row"]');
          for (const r of rows) {
            if (/\\b\\d{15,}\\b/.test(r.textContent || '')) n++;
          }
          return n;
        })()
      `).catch(() => 0);

      // Time-based floor: 30% → 60% over the first 12s, regardless
      // of whether rows are visible yet. Keeps the bar moving while
      // Cloudflare resolves so users never see a frozen "waiting…".
      const timeFrac    = Math.min(1, waited / 12000);
      const timePercent = 30 + timeFrac * 30;

      // Row-based curve: 30% → 85% asymptotically as rows arrive.
      const rowPercent = count > 0
        ? 30 + Math.min(55, 55 * (1 - Math.exp(-count / 40)))
        : 0;

      // Monotonic - never go backwards.
      const percent = Math.max(lastPercent, timePercent, rowPercent);
      lastPercent = percent;

      if (count > rowCount) {
        rowCount = count;
        stable = 0;
        emit({ percent, status: `Found ${count} versions on SteamDB…`, count });
      } else {
        const status = count > 0
          ? `Found ${count} versions, finishing render…`
          : (visible ? 'Waiting for Cloudflare check to pass…' : 'Waiting for SteamDB content…');
        emit({ percent, status, count });
        if (count > 0) {
          stable++;
          const needed = count >= FAST_BAIL ? 1 : 2;
          if (stable >= needed) break;
        }
      }
    }

    if (rowCount === 0) {
      throw new Error('SteamDB returned no rows. Cloudflare may have presented an interactive challenge that a hidden window cannot solve.');
    }

    emit({ percent: 90, status: 'Parsing manifest list…', etaMs: 800 });

    const manifests = await win.webContents.executeJavaScript(`
      (() => {
        const out = [];
        const seen = new Set();
        const rows = document.querySelectorAll('tr, [role="row"]');
        for (const row of rows) {
          const text = (row.textContent || '').replace(/\\s+/g, ' ').trim();
          const m = text.match(/\\b(\\d{15,25})\\b/);
          if (!m) continue;
          const manifestId = m[1];
          if (seen.has(manifestId)) continue;
          seen.add(manifestId);

          let date = '';
          const timeEl = row.querySelector('time[datetime]');
          if (timeEl) date = timeEl.getAttribute('datetime') || timeEl.textContent.trim();
          if (!date) {
            const dm = text.match(/\\b(\\d{4}-\\d{2}-\\d{2})\\b/);
            if (dm) date = dm[1];
          }

          let size = '';
          const sm = text.match(/(\\d+(?:[\\.,]\\d+)?)\\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\\b/i);
          if (sm) size = sm[0];

          out.push({ manifestId, date, size });
        }
        return out;
      })()
    `);

    emit({ percent: 100, status: `Loaded ${manifests.length} versions`, count: manifests.length, etaMs: 0 });
    return manifests || [];
  } finally {
    try { win.close(); } catch {}
  }
}

// Public entry - checks cache first, scrapes hidden if missing/stale,
// auto-falls-back to a VISIBLE window if the hidden scrape gets
// blocked by a Cloudflare interactive challenge. The visible window
// lets the user click the "Verify you are human" checkbox; once the
// challenge clears, Cloudflare's clearance cookie persists in the
// `persist:steamdb` partition so future hidden scrapes work silently.
async function fetchManifests({ force = false, onProgress, maxWaitMs = null } = {}) {
  if (!force) {
    const cached = readManifestCache();
    if (cached && !cached.expired) return { manifests: cached.manifests, fromCache: true, fetchedAt: cached.fetchedAt };
  }

  // Attempt 1: hidden. Fastest if Cloudflare's already cleared.
  try {
    const manifests = await scrapeSteamDB({ onProgress, visible: false });
    if (manifests.length > 0) {
      writeManifestCache(manifests);
      return { manifests, fromCache: false, fetchedAt: Date.now() };
    }
  } catch (e) { /* fall through to visible attempt */ }

  // Attempt 2: visible. Lets the user solve Cloudflare's challenge.
  try {
    const manifests = await scrapeSteamDB({ onProgress, visible: true, maxWaitMs });
    if (manifests.length > 0) {
      writeManifestCache(manifests);
      return { manifests, fromCache: false, fetchedAt: Date.now() };
    }
    const cached = readManifestCache();
    if (cached) return { manifests: cached.manifests, fromCache: true, fetchedAt: cached.fetchedAt, stale: true };
    return { manifests: [], fromCache: false, fetchedAt: Date.now(), error: 'SteamDB returned no rows.' };
  } catch (e) {
    const cached = readManifestCache();
    if (cached) return { manifests: cached.manifests, fromCache: true, fetchedAt: cached.fetchedAt, stale: true, error: e?.message };
    return { manifests: [], fromCache: false, fetchedAt: Date.now(), error: e?.message };
  }
}

module.exports = {
  // Exported for electron/gt-versions.test.cjs, which drives it against a real
  // Windows file lock - the failure users actually hit.
  copyTreeWithRetry,
  rmTreeWithRetry,
  GT_APP_ID,
  GT_DEPOT_ID,
  detectSteam,
  listInstalled,
  listInstalledDetailed,
  installedInfo,
  manifestForVersionId,
  parseDepotLog,
  isInstalled,
  installPath,
  binaryPath,
  removeVersion,
  prepareDownload,
  pollDownload,
  finalizeDownload,
  fetchManifests,
  checkSteamFolder,
};
