// Tests for the main-process zip reader.
//
// This is the piece worth testing on its own: it is the only place the archive's
// size is checked BEFORE anything is decompressed, and "we inflated it and then
// measured it" is how a 40 MB upload becomes gigabytes of resident memory. The
// rest of the upload path needs a browser and a live bucket; this needs neither.

const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { readIndex, readEntry, release, MAX_ENTRIES } = require('./mod-archive-read.cjs');

let passed = 0;
const ok = (label, cond) => {
  assert.ok(cond, label);
  passed++;
};

// Build a zip in memory. `files` is { name: contents }.
function zipOf(files) {
  const z = new AdmZip();
  for (const [name, body] of Object.entries(files)) z.addFile(name, Buffer.from(body));
  return z.toBuffer();
}

// ── A normal archive ────────────────────────────────────────────────────────
{
  const buf = zipOf({ 'MyMod.dll': 'MZ fake plugin bytes', 'assets/bundle.dat': 'x'.repeat(500) });
  const r = readIndex(buf, { maxUnpacked: 10 * 1024 * 1024 });
  ok('a normal archive is readable', r.ok === true);
  ok('it returns a handle', typeof r.handle === 'string' && r.handle.length > 0);
  ok('both files are listed', r.entries.length === 2);
  ok('paths are preserved verbatim', r.entries.some((e) => e.path === 'assets/bundle.dat'));
  ok('sizes come from the central directory', r.entries.find((e) => e.path === 'MyMod.dll').size === 20);
  ok('the index carries NO bytes', r.entries.every((e) => e.bytes === undefined));
  ok('totalBytes is the sum', r.totalBytes === 520);

  // Draining
  const got = readEntry(r.handle, 'MyMod.dll');
  ok('an entry decompresses', got.ok === true);
  ok('its bytes round-trip', Buffer.from(got.base64, 'base64').toString() === 'MZ fake plugin bytes');

  ok('an unknown entry is refused', readEntry(r.handle, 'nope.dll').ok === false);
  ok('an unknown handle is refused', readEntry('deadbeef', 'MyMod.dll').error === 'unknown_handle');

  release(r.handle);
  ok('release drops the handle', readEntry(r.handle, 'MyMod.dll').error === 'unknown_handle');
}

// ── The size ceiling, enforced BEFORE inflating ─────────────────────────────
{
  const buf = zipOf({ 'big.dat': 'y'.repeat(5000) });
  const r = readIndex(buf, { maxUnpacked: 1000 });
  ok('an archive over the unpacked ceiling is refused', r.ok === false);
  ok('and says why', r.error === 'archive_too_large');
  ok('and hands back NO handle, so nothing was retained', r.handle === undefined);
}
{
  // The same archive under a ceiling that clears it, to prove the refusal above
  // was the ceiling and not something else about the file.
  const buf = zipOf({ 'big.dat': 'y'.repeat(5000) });
  ok('the same archive passes under a higher ceiling', readIndex(buf, { maxUnpacked: 1024 * 1024 }).ok === true);
}

// ── Entry count ─────────────────────────────────────────────────────────────
{
  const files = {};
  for (let i = 0; i <= MAX_ENTRIES; i++) files[`f${i}.txt`] = 'a';
  const r = readIndex(zipOf(files), { maxUnpacked: 10 * 1024 * 1024 });
  ok('more than MAX_ENTRIES files is refused', r.ok === false && r.error === 'too_many_files');
}

// ── Things that are not archives ────────────────────────────────────────────
{
  const r = readIndex(Buffer.from('this is not a zip file at all'), { maxUnpacked: 1024 });
  ok('a non-zip is refused rather than thrown', r.ok === false);
  ok('and is named as unreadable', r.error === 'unreadable_archive');
}
{
  // A zip containing only a directory entry has nothing to install.
  const z = new AdmZip();
  z.addFile('folder/', Buffer.alloc(0));
  const r = readIndex(z.toBuffer(), { maxUnpacked: 1024 });
  ok('an archive with no files is refused', r.ok === false && r.error === 'empty_archive');
}

// ── Paths are NOT sanitised here, on purpose ────────────────────────────────
//
// safeEntryPath in src/lib/mod-archive.js is what judges paths, and it has to see
// the RAW name to reject it. If this reader quietly normalised '../../evil.dll'
// into 'evil.dll', the traversal attempt would become invisible to the one thing
// whose job is to catch it - the archive would look clean and install a file
// somewhere nobody agreed to.
//
// GOTCHA, and the reason this fixture is built by hand: `adm-zip` strips '..' when
// it WRITES an entry, so `new AdmZip().addFile('../../evil.dll', ...)` silently
// produces an archive containing plain 'evil.dll'. A test built that way asserts
// nothing - it never had a traversal path to begin with. Verified separately that
// adm-zip does NOT sanitise on READ, which is what makes the check below the real
// threat rather than a hypothetical one.
{
  // Same byte length, so every offset in the zip stays valid after patching.
  const PLACEHOLDER = 'AA/AA/evil.dll';
  const TRAVERSAL = '../../evil.dll';
  const z = new AdmZip();
  z.addFile(PLACEHOLDER, Buffer.from('payload'));
  const patched = Buffer.from(
    z.toBuffer().toString('latin1').split(PLACEHOLDER).join(TRAVERSAL),
    'latin1',
  );
  ok('the fixture really does contain a raw traversal name',
    patched.toString('latin1').includes(TRAVERSAL));

  const r = readIndex(patched, { maxUnpacked: 1024 });
  ok('a crafted traversal archive still reads', r.ok === true);
  ok('and its path is handed on UNCHANGED for the validator to reject',
    r.entries[0].path === TRAVERSAL);
  release(r.handle);
}

console.log(`mod-archive-read: ${passed} assertions passed`);
