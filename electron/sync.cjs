// Cloud Sync — main-process helpers.
//
// The sync ORCHESTRATION lives in the renderer (src/lib/cloud-sync.js +
// useCloudSync.js), which already holds the Supabase client + user JWT. This
// module just exposes the few things only the main process can do:
//   - mint/return a stable per-install device identity
//   - (Stage 4) hash + read + write mod files on disk for the Pro+ Vault
//
// Everything is best-effort and returns plain objects; the IPC layer in
// electron/main.js wraps these in the standard { ok, data|error } envelope.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, saveConfig } = require('./config.cjs');
const { scanMods } = require('./mods.cjs');

// A stable id for THIS install, minted once and persisted in config.json.
// Not tied to hardware (so a reinstall = a new device, which is the honest
// behavior for a device cap). Lazily created on first read.
function getInstallId() {
  const cfg = loadConfig();
  if (cfg.installId && typeof cfg.installId === 'string') return cfg.installId;
  const id = crypto.randomUUID();
  saveConfig({ ...cfg, installId: id });
  return id;
}

// Identity the renderer registers in sync_devices. `name` is just a friendly
// label for the "Your devices" list; it carries no security weight.
function deviceInfo() {
  let name = 'This PC';
  try { name = os.hostname() || name; } catch { /* ignore */ }
  return {
    installId: getInstallId(),
    name,
    platform: process.platform, // win32 / darwin / linux
  };
}

// ── Pro+ Mod Vault file ops (Stage 4) ───────────────────────────────────────
// The Vault carries the exact bytes of hand-dropped, single-file mods (Foo.dll)
// that can't be re-downloaded from the catalog. Folder / multi-file mods are
// skipped for now (they almost always come from packs/registry, which Stage 3
// already restores). Bytes travel to/from api/sync/vault.js as base64.

const norm = (s) => String(s || '').replace(/\.dll$/i, '');

// A mod base name is a FILE NAME, never a path. `norm()` only strips a trailing
// ".dll", so it happily passes "../../../../Windows/System32/evil" through - and
// writeModFile() fed that straight into path.join(pluginsDir(), name + '.dll'),
// which resolves right out of the game folder. Same class as the gtv:remove
// traversal fixed on 2026-08-01, in a handler that reaches the disk from the
// RENDERER (sync:write-mod-file) with attacker-supplied base64 bytes.
//
// Returns the safe bare name, or null when the input is not a plain file name.
function safeBaseName(input) {
  const name = norm(input);
  if (!name) return null;
  // Reject anything with a path separator, a drive letter, or a traversal
  // segment, rather than trying to strip them (stripping invites
  // "....//" style bypasses). path.basename() alone is NOT enough: it would
  // silently accept "../evil" by turning it into "evil", which hides a caller
  // that is doing something wrong.
  if (/[/\\]/.test(name)) return null;
  if (/^[a-zA-Z]:/.test(name)) return null;
  if (name === '.' || name === '..') return null;
  if (name.includes('\0')) return null;
  return name;
}

// Belt and braces: prove the resolved path really is inside `dir`. Catches
// anything the name check above did not anticipate (NTFS 8.3 names, unicode
// tricks, a future edit to safeBaseName).
function isInside(dir, target) {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function pluginsDir() {
  const cfg = loadConfig();
  if (!cfg.gamePath) return null;
  return path.join(cfg.gamePath, 'BepInEx', 'plugins');
}

// Resolve a baseName to a single .dll file path (or null for missing / folder mods).
function singleDllPathFor(baseName) {
  const cfg = loadConfig();
  if (!cfg.gamePath) return null;
  let hit = null;
  try {
    const scan = scanMods(cfg.gamePath);
    hit = (scan.mods || []).find((m) => norm(m.baseName) === norm(baseName));
  } catch { /* ignore */ }
  const p = hit?.path;
  if (!p) return null;
  try { if (fs.statSync(p).isFile() && /\.dll$/i.test(p)) return p; } catch { /* ignore */ }
  return null;
}

// Hash the vault-eligible mods among baseNames. Returns [{ baseName, hash, size }].
// Only single-file .dll mods are eligible. Cheap: reads each file once.
async function hashMods(baseNames) {
  const out = [];
  for (const bn of (baseNames || [])) {
    const p = singleDllPathFor(bn);
    if (!p) continue;
    try {
      const buf = fs.readFileSync(p);
      out.push({ baseName: norm(bn), hash: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length });
    } catch { /* skip unreadable */ }
  }
  return out;
}

// Read one mod's bytes for upload. Returns { baseName, hash, size, dataBase64 } or null.
async function readModFile(baseName) {
  const p = singleDllPathFor(baseName);
  if (!p) return null;
  const buf = fs.readFileSync(p);
  return {
    baseName: norm(baseName),
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
    dataBase64: buf.toString('base64'),
  };
}

// Write a mod's bytes from the vault into the plugins folder. Won't clobber an
// existing file (local stays authoritative). Returns { ok, wrote }.
async function writeModFile({ baseName, dataBase64 } = {}) {
  const dir = pluginsDir();
  if (!dir || !baseName || !dataBase64) return { ok: false, error: 'not_ready' };

  const safe = safeBaseName(baseName);
  if (!safe) return { ok: false, error: 'invalid_name' };
  const file = path.join(dir, `${safe}.dll`);
  if (!isInside(dir, file)) return { ok: false, error: 'invalid_name' };
  if (fs.existsSync(file)) return { ok: true, wrote: false }; // already present — don't overwrite
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataBase64, 'base64'));
  return { ok: true, wrote: true };
}

module.exports = { getInstallId, deviceInfo, hashMods, readModFile, writeModFile };
