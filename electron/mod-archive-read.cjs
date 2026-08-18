// Reading a .zip for the multi-file mod upload. MAIN PROCESS, deliberately.
//
// Why not in the renderer: `adm-zip` is already what mod-downloader.cjs uses to
// EXTRACT a zip at install time. If the renderer parsed the archive with a
// different library than the one that later writes it to disk, the two could
// disagree about what is inside - and an attacker only needs them to disagree
// once. Craft an archive the validator reads as {A.dll} and the extractor writes
// as {A.dll, evil.dll} and the whole review is bypassed. Parser differentials are
// a known class of archive attack and the cheapest defence is to not have two
// parsers. Same library at validate time and install time, no divergence to
// exploit.
//
// It also means no new dependency, and no reliance on `File.path`, which Electron
// has deprecated.
//
// NOTHING IS WRITTEN TO DISK HERE. Entries are enumerated and read in memory and
// handed back for staging straight to storage. Zip-slip is therefore not reachable
// at this stage - it only matters when something is extracted to a path, which is
// the install step, and `safeEntryPath` in src/lib/mod-archive.js guards that.

const AdmZip = require('adm-zip');
const crypto = require('crypto');

// Mirrors LIMITS.MAX_FILES in src/lib/mod-archive.js. Checked here as well as
// there because this runs FIRST, before any decompression, and refusing early is
// the whole point.
const MAX_ENTRIES = 200;

// Open archives, by handle. An archive is read once and then drained entry by
// entry, so a 175 MB upload never has to exist twice in memory or cross the IPC
// boundary in one message.
const open = new Map();

// Handles are released explicitly by the renderer, but a renderer that crashes
// mid-upload would otherwise leak the whole archive. Anything untouched for this
// long is dropped.
const TTL_MS = 10 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, rec] of open) if (now - rec.touched > TTL_MS) open.delete(id);
}

/**
 * Enumerate an archive WITHOUT decompressing anything.
 *
 * The sizes come from the zip's central directory, so the bomb checks happen
 * before a single byte is inflated. Inflating first and measuring afterwards is
 * how a 40 MB upload becomes 4 GB of resident memory.
 *
 * @param bytes       ArrayBuffer | Uint8Array | Buffer of the .zip
 * @param maxUnpacked the caller's tier ceiling for total uncompressed bytes
 * @returns { ok, handle, entries: [{ path, size, compressedSize }], totalBytes }
 */
function readIndex(bytes, { maxUnpacked } = {}) {
  sweep();
  let zip;
  try {
    zip = new AdmZip(Buffer.from(bytes));
  } catch (e) {
    // A file that is not a zip at all, or a truncated one. Not an error worth a
    // stack trace - the user picked the wrong file.
    return { ok: false, error: 'unreadable_archive', detail: e?.message || 'could not open' };
  }

  let raw;
  try { raw = zip.getEntries(); } catch (e) {
    return { ok: false, error: 'unreadable_archive', detail: e?.message || 'could not list entries' };
  }

  const entries = [];
  let totalBytes = 0;
  let totalCompressed = 0;

  for (const e of raw) {
    if (e.isDirectory) continue;
    if (entries.length >= MAX_ENTRIES) {
      return { ok: false, error: 'too_many_files', detail: `more than ${MAX_ENTRIES} files` };
    }
    const size = Number(e.header?.size) || 0;
    const compressedSize = Number(e.header?.compressedSize) || 0;
    totalBytes += size;
    totalCompressed += compressedSize;
    if (maxUnpacked && totalBytes > maxUnpacked) {
      return { ok: false, error: 'archive_too_large', detail: `unpacks to more than ${maxUnpacked} bytes` };
    }
    entries.push({ path: e.entryName, size, compressedSize });
  }

  if (!entries.length) return { ok: false, error: 'empty_archive' };

  const handle = crypto.randomBytes(16).toString('hex');
  open.set(handle, { zip, touched: Date.now() });
  return { ok: true, handle, entries, totalBytes, totalCompressed };
}

/**
 * Decompress ONE entry, by path. Returns base64 because this crosses the IPC
 * boundary as JSON.
 *
 * Matched by exact entryName against the index we already returned, so a renderer
 * cannot ask for something that was never in the listing.
 */
function readEntry(handle, entryPath) {
  const rec = open.get(handle);
  if (!rec) return { ok: false, error: 'unknown_handle' };
  rec.touched = Date.now();
  try {
    const entry = rec.zip.getEntries().find((e) => !e.isDirectory && e.entryName === entryPath);
    if (!entry) return { ok: false, error: 'unknown_entry' };
    const data = entry.getData();
    return { ok: true, base64: data.toString('base64'), size: data.length };
  } catch (e) {
    return { ok: false, error: 'entry_unreadable', detail: e?.message || 'inflate failed' };
  }
}

function release(handle) {
  open.delete(handle);
  return { ok: true };
}

module.exports = { readIndex, readEntry, release, MAX_ENTRIES };
