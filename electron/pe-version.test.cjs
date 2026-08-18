// VS_VERSIONINFO reading: alignment, anchor identification, and never showing
// the user garbage.
//
// ── The history, because this has now been wrong THREE times ────────────────
// v1 aligned padding relative to its own BUFFER. The buffer starts at the
//    "VS_VERSION_INFO" szKey, but the struct begins SIX bytes earlier
//    (wLength, wValueLength, wType), so everything was 6 bytes out and NO
//    names were read at all - it silently fell back to the filename.
//
// v2 aligned relative to the FILE, on the reasoning that the struct is
//    DWORD-aligned in the file so the anchor is always at 2 mod 4. That is not
//    true: measured across ~6800 system DLLs, mstscax.dll sits at 0 mod 4 and
//    AutoUpdater.NET.dll at 3 mod 4. When it does not hold, values are read
//    1-3 bytes off, and shifted UTF-16LE turns ASCII into CJK. THAT is the
//    "random Chinese mod names" users reported:
//        "娀椀瀀䔀砀琀爀愀挀琀漀爀"  should read  "ZipExtractor"
//        "刀䈀匀漀昀琀"           should read  "RBSoft"
//
//    The old fixture could not catch it: buildFixture hard-coded
//    RES_START = 0x1000 and asserted RES_START % 4 === 0, so file-alignment
//    and resource-alignment always agreed. It tested the one case that works.
//
// v3 (current) aligns relative to the RESOURCE, which is what the spec says,
//    and identifies the resource by the VS_FIXEDFILEINFO magic 0xFEEF04BD
//    rather than by looking plausible - mstscax.dll contains a DECOY
//    "VS_VERSION_INFO" string a full 2 MB before the real resource.
//
// So this file now tests ALL FOUR alignments, a decoy anchor, and the refusal
// to emit control characters.

const assert = require('node:assert');
const { readPeVersionInfo } = require('./pe-version.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const u16 = (s) => Buffer.from(`${s}\0`, 'utf16le');

// One String entry: wLength, wValueLength, wType, szKey, pad-to-DWORD, Value.
// Padding is measured from `resStart` - the start of the version resource.
function stringEntry(key, value, absPosOfEntry, resStart) {
  const szKey = u16(key);
  const val = u16(value);
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);                 // wLength   (unused by this reader)
  head.writeUInt16LE(val.length / 2, 2);    // wValueLength in code units
  head.writeUInt16LE(1, 4);                 // wType = text
  const afterKey = absPosOfEntry + 6 + szKey.length;
  const padLen = ((afterKey - resStart + 3) & ~3) - (afterKey - resStart);
  return Buffer.concat([head, szKey, Buffer.alloc(padLen), val]);
}

// A real VS_VERSIONINFO: header, szKey, pad, VS_FIXEDFILEINFO (52 bytes opening
// with 0xFEEF04BD), then the String children.
function versionResource(fields, resStart) {
  const szKey = u16('VS_VERSION_INFO');
  const headLen = 6 + szKey.length;
  const padLen = ((headLen + 3) & ~3) - headLen;

  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xFEEF04BD, 0);       // dwSignature - the thing we trust

  let body = Buffer.concat([Buffer.alloc(6), szKey, Buffer.alloc(padLen), fixed]);
  for (const [k, v] of Object.entries(fields)) {
    body = Buffer.concat([body, stringEntry(k, v, resStart + body.length, resStart)]);
  }
  body.writeUInt16LE(body.length, 0);       // wLength = whole resource
  body.writeUInt16LE(52, 2);                // wValueLength = sizeof VS_FIXEDFILEINFO
  body.writeUInt16LE(0, 4);                 // wType = binary
  return body;
}

// `resStart` is deliberately a parameter so the alignment cases can be driven.
function buildFixture(fields, resStart, { decoy = false } = {}) {
  const body = versionResource(fields, resStart);
  const size = resStart + body.length + 64;
  const file = Buffer.alloc(size);
  file[0] = 0x4d; file[1] = 0x5a;            // "MZ"

  if (decoy) {
    // A bare "VS_VERSION_INFO" with no VS_FIXEDFILEINFO behind it, exactly like
    // the one 2 MB inside mstscax.dll. A reader that takes the first match and
    // sanity-checks only the size will read rubbish out of it.
    const fake = u16('VS_VERSION_INFO');
    fake.copy(file, 0x200);
    file.writeUInt16LE(49024, 0x200 - 6);    // implausible-but-not-absurd wLength
  }

  body.copy(file, resStart);
  return { file, anchorIdx: resStart + 6 };
}

let passed = 0;
const ok = (label, cond) => { assert.ok(cond, label); passed++; };

const FIELDS = {
  ProductName: 'Excalibur Test Mod',
  FileDescription: 'A mod used by pe-version.test.cjs',
  CompanyName: 'Excalibur',
};

function withFixture(file, fn) {
  const tmp = path.join(os.tmpdir(), `excalibur-pe-${process.pid}-${Math.random().toString(36).slice(2)}.dll`);
  fs.writeFileSync(tmp, file);
  try { return fn(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}

// ── EVERY alignment, not just the convenient one ────────────────────────────
// 0x1000 is 0 mod 4 (anchor at 2 mod 4) - the case v2 assumed was universal.
// The other three are the cases that produced Chinese names in the wild.
for (const delta of [0, 1, 2, 3]) {
  const resStart = 0x1000 + delta;
  const { file, anchorIdx } = buildFixture(FIELDS, resStart);
  withFixture(file, (p) => {
    const got = readPeVersionInfo(p);
    ok(`resStart%4=${resStart % 4} (anchor%4=${anchorIdx % 4}): found`, !!got);
    ok(`resStart%4=${resStart % 4}: productName`, got && got.productName === FIELDS.ProductName);
    ok(`resStart%4=${resStart % 4}: fileDescription`, got && got.fileDescription === FIELDS.FileDescription);
    ok(`resStart%4=${resStart % 4}: companyName`, got && got.companyName === FIELDS.CompanyName);
    // The real point: no mojibake, ever.
    for (const v of Object.values(got || {})) {
      ok(`resStart%4=${resStart % 4}: "${String(v).slice(0, 18)}" is not mojibake`,
        !/[　-鿿]/.test(String(v)));
    }
  });
}

// ── A decoy anchor must not win ─────────────────────────────────────────────
{
  const { file } = buildFixture(FIELDS, 0x1000 + 3, { decoy: true });
  withFixture(file, (p) => {
    const got = readPeVersionInfo(p);
    ok('decoy anchor is skipped for the real resource', got && got.productName === FIELDS.ProductName);
  });
}

// ── Degenerate inputs return null rather than throwing ──────────────────────
{
  const bare = Buffer.alloc(1024); bare[0] = 0x4d; bare[1] = 0x5a;
  withFixture(bare, (p) => ok('no version resource -> null', readPeVersionInfo(p) === null));
  withFixture(Buffer.from('not a PE'), (p) => ok('non-PE -> null', readPeVersionInfo(p) === null));
}

// ── Never hand the UI control characters ────────────────────────────────────
// Misread binary decodes to strings peppered with C0 controls. Showing that as
// somebody's mod name is worse than falling back to the filename.
{
  const ctl = `has${String.fromCharCode(1)}control`;
  const bad = { ProductName: 'Good Name', FileDescription: ctl };
  const { file } = buildFixture(bad, 0x1000);
  withFixture(file, (p) => {
    const got = readPeVersionInfo(p);
    ok('clean value survives', got && got.productName === 'Good Name');
    ok('control-char value is rejected', !got || got.fileDescription === undefined);
  });
}

// ── The source must keep aligning against the RESOURCE ──────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, 'pe-version.cjs'), 'utf8');
  ok('resource start is computed', /resStart/.test(src));
  ok('resStart is passed to the extractor', /extractValueAfterKey\(window, key, anchorIdx, resStart\)/.test(src));
  ok('the resource is identified by its magic', /0xFEEF04BD/i.test(src));
}

console.log(`pe-version: ${passed} passed`);
