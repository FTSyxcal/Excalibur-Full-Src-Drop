// Smart Naming — the disk half of the rename engine (main process).
//
// ════════════════════════════════════════════════════════════════════════════
// THE ONE RULE: a recording must never be lost, corrupted, half-named, or
// locked. If ANYTHING is uncertain, the file keeps the name OBS gave it.
// A boring filename is a non-event. A lost clip is a disaster. Every branch
// below chooses "boring name" over "risk", and NOTHING in this file throws to
// the caller — every path returns a result object.
// ════════════════════════════════════════════════════════════════════════════
//
// Split of responsibility:
//   • renderer  — owns the OBS WebSocket, captures the game-state snapshot and
//                 computes the desired base name (src/lib/smart-naming/*).
//   • THIS FILE — owns every fallible disk operation: waiting for OBS to let go
//                 of the file, subfolder creation, collision handling, path
//                 length limits, and the rename itself.
//
// The renderer never touches fs; this file never computes a name. That split is
// what keeps the risky part small enough to reason about exhaustively.

const fs = require('fs');
const path = require('path');
const { logError, logInfo } = require('./logger.cjs');

// Wait at most this long for OBS to release / finish writing the file before
// giving up and leaving the original name. (User-chosen: 1 minute.)
const MAX_WAIT_MS = 60_000;
const POLL_MS = 250;
// The file must report the same size this many consecutive polls before we
// believe OBS has finished writing it. Guards against renaming mid-write and
// against MP4 remux still being in flight.
const STABLE_POLLS = 6; // 6 * 250ms = 1.5s of no growth

// Windows limits. 255 per path component; ~259 for the whole path. We keep a
// safety margin because the collision suffix " (12)" can grow the name after
// this check.
const MAX_COMPONENT = 255;
const MAX_FULL_PATH = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Windows-safe name hygiene ───────────────────────────────────────────────
// Mirrors src/lib/smart-naming/build-name.js. Duplicated deliberately: this is
// the LAST line of defence before a real fs call, and it must not depend on the
// renderer having done its job (a patched/older renderer must not be able to
// hand us a path-traversing name).
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\x00-\x1f\\/:*?"<>|]/g;
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function sanitizeBase(name) {
  let out = String(name == null ? '' : name).replace(ILLEGAL, '');
  out = out.replace(/\s+/g, ' ').replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (!out) return '';
  const stem = out.split('.')[0].toUpperCase();
  if (RESERVED.has(stem)) out = `_${out}`;
  return out;
}

// A single path segment for the optional subfolder. Same rules; never allows
// '..' or a separator to escape the recording directory.
function sanitizeSegment(seg) {
  const clean = sanitizeBase(String(seg || '').replace(/\.\./g, ''));
  return clean;
}

// ── Wait for the file to be finished + unlocked ─────────────────────────────
// Rather than probing for a lock separately, we watch for the size to stop
// growing, then let the rename itself (retried) be the real lock test — the
// operation we care about IS the rename, so that's the honest check.
async function waitUntilSettled(filePath, deadline) {
  let lastSize = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      // File vanished (user deleted it, OBS moved it). Nothing safe to do.
      return { ok: false, reason: 'file-missing' };
    }
    if (st.size === lastSize && st.size > 0) {
      stable += 1;
      if (stable >= STABLE_POLLS) return { ok: true };
    } else {
      stable = 0;
      lastSize = st.size;
    }
    await sleep(POLL_MS);
  }
  return { ok: false, reason: 'timeout-growing' };
}

// ── Collision handling ──────────────────────────────────────────────────────
// strategy: 'counter' | 'timestamp' | 'leave'.  Returns a free absolute target
// path, or null meaning "don't rename".
function resolveTarget(dir, base, ext, strategy, stampMs) {
  const full = (b) => path.join(dir, b + ext);
  if (!fs.existsSync(full(base))) return full(base);
  if (strategy === 'leave') return null;

  if (strategy === 'timestamp') {
    const d = new Date(Number.isFinite(stampMs) ? stampMs : Date.now());
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
    let cand = sanitizeBase(`${base}_${stamp}`);
    let n = 2;
    while (fs.existsSync(full(cand))) {
      cand = sanitizeBase(`${base}_${stamp}_${n++}`);
      if (n > 9999) return null;
    }
    return full(cand);
  }

  let n = 2;
  let cand = sanitizeBase(`${base} (${n})`);
  while (fs.existsSync(full(cand))) {
    n += 1;
    cand = sanitizeBase(`${base} (${n})`);
    if (n > 9999) return null;
  }
  return full(cand);
}

// Trim the base so base + ext fits the component limit AND the full path fits.
// Trimming happens from the END of the base (least-significant), never the ext.
function fitLength(dir, base, ext) {
  let b = base;
  // component limit
  if ((b + ext).length > MAX_COMPONENT) b = b.slice(0, Math.max(1, MAX_COMPONENT - ext.length));
  // full-path limit
  while (b.length > 1 && path.join(dir, b + ext).length > MAX_FULL_PATH) {
    b = b.slice(0, b.length - 1);
  }
  return sanitizeBase(b);
}

// ── The public operation ────────────────────────────────────────────────────
// finalizeRename({ sourcePath, base, collision, subfolder, stampMs, dryRun })
//
// Returns (never throws):
//   { ok:true,  renamed:true,  from, to }
//   { ok:true,  renamed:false, reason }   ← the safe no-op; file keeps its name
async function finalizeRename(opts) {
  const started = Date.now();
  const deadline = started + MAX_WAIT_MS;
  try {
    const sourcePath = String(opts?.sourcePath || '');
    const rawBase = String(opts?.base || '');
    const collision = ['counter', 'timestamp', 'leave'].includes(opts?.collision) ? opts.collision : 'counter';
    const dryRun = !!opts?.dryRun;

    if (!sourcePath) return { ok: true, renamed: false, reason: 'no-source' };
    // The renderer produced nothing usable → keep OBS's name. This is the
    // designed "empty name" path, not an error.
    if (!sanitizeBase(rawBase)) return { ok: true, renamed: false, reason: 'empty-base' };

    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      return { ok: true, renamed: false, reason: 'source-missing' };
    }
    if (!stat.isFile()) return { ok: true, renamed: false, reason: 'not-a-file' };

    // Wait for OBS to finish writing / remuxing.
    const settled = await waitUntilSettled(sourcePath, deadline);
    if (!settled.ok) {
      logInfo(`[smart-naming] leaving original name (${settled.reason}): ${sourcePath}`);
      return { ok: true, renamed: false, reason: settled.reason };
    }

    const srcDir = path.dirname(sourcePath);
    const ext = path.extname(sourcePath); // keep OBS's container extension exactly
    let targetDir = srcDir;

    // Optional subfolder, created under the recording dir only.
    const seg = sanitizeSegment(opts?.subfolder);
    if (seg) {
      const candidate = path.join(srcDir, seg);
      // Belt and braces: the resolved dir must still live under srcDir.
      const rel = path.relative(srcDir, candidate);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        logError('[smart-naming] refusing subfolder outside the recording dir:', seg);
      } else {
        targetDir = candidate;
        if (!dryRun) {
          try {
            fs.mkdirSync(targetDir, { recursive: true });
          } catch (e) {
            logError('[smart-naming] subfolder create failed, using recording dir:', e);
            targetDir = srcDir;
          }
        }
      }
    }

    const base = fitLength(targetDir, sanitizeBase(rawBase), ext);
    if (!base) return { ok: true, renamed: false, reason: 'empty-after-fit' };

    // Is the file ALREADY named exactly right? This must be checked BEFORE
    // collision resolution, because the "colliding" file would be the source
    // itself — without this, a re-run would helpfully produce "name (2)",
    // "name (3)"… duplicate spam on every retry.
    const ideal = path.join(targetDir, base + ext);
    if (path.resolve(ideal) === path.resolve(sourcePath)) {
      return { ok: true, renamed: false, reason: 'already-named' };
    }

    let target = resolveTarget(targetDir, base, ext, collision, opts?.stampMs);
    if (!target) return { ok: true, renamed: false, reason: 'collision-leave' };

    if (dryRun) return { ok: true, renamed: true, from: sourcePath, to: target, dryRun: true };

    // The rename IS the lock test. Retry while OBS/antivirus still holds it.
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        // Never clobber: re-check immediately before the call. The TOCTOU window
        // is tiny, and losing the race costs us only the rename, never the file.
        // Recompute in-place (no recursion — that could re-enter the wait loop).
        if (fs.existsSync(target)) {
          const retry = resolveTarget(targetDir, base, ext, collision, opts?.stampMs);
          if (!retry) return { ok: true, renamed: false, reason: 'collision-leave' };
          target = retry;
        }
        fs.renameSync(sourcePath, target);
        logInfo(`[smart-naming] ${path.basename(sourcePath)} -> ${path.basename(target)}`);
        return { ok: true, renamed: true, from: sourcePath, to: target };
      } catch (e) {
        lastErr = e;
        const code = e && e.code;
        // EBUSY/EPERM/EACCES = still held (OBS handle, antivirus scan). Retry.
        if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
          await sleep(POLL_MS);
          continue;
        }
        // EXDEV can't happen (same directory) but treat any other error as fatal
        // for THIS attempt: keep the original name.
        logError('[smart-naming] rename failed, keeping original name:', e);
        return { ok: true, renamed: false, reason: `rename-error:${code || 'unknown'}` };
      }
    }
    logError('[smart-naming] gave up waiting for the file lock:', lastErr);
    return { ok: true, renamed: false, reason: 'timeout-locked' };
  } catch (e) {
    // Absolute backstop — this function must never throw.
    logError('[smart-naming] unexpected failure, keeping original name:', e);
    return { ok: true, renamed: false, reason: 'unexpected' };
  }
}

module.exports = {
  finalizeRename,
  // exported for tests
  _internals: { sanitizeBase, sanitizeSegment, resolveTarget, fitLength, MAX_WAIT_MS },
};
