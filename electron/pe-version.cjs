// Lightweight Windows PE VS_VERSIONINFO reader.
//
// A "proper" implementation would parse the DOS header, locate the PE/COFF
// header, walk section headers to find .rsrc, then walk the resource directory
// tree to find RT_VERSION (type 16), its language leaf, then decode the
// VS_VERSIONINFO structure.
//
// In practice, VS_VERSIONINFO is unique enough in a DLL that we can locate it
// by searching for the UTF-16LE literal "VS_VERSION_INFO", then for each
// known string key ("ProductName", "FileDescription", etc.) we grab the
// UTF-16LE value that follows (padded to a 4-byte boundary). This gives us
// ~95% coverage of real-world mods without a native module dependency, and
// for any DLL where it fails we gracefully return null and the caller falls
// back to the filename.

const fs = require('fs');

// Cap how much of the file we read. Version resources sit near the END of a
// PE, so a cap that is smaller than the file cuts off the very thing we want.
// At 8 MB, mstscax.dll (whose real resource is at 9.25 MB) exposed only a
// DECOY "VS_VERSION_INFO" earlier in the file - the reader then had nothing
// valid to find. 32 MB covers every real DLL including the large system ones;
// a community mod is around 1 MB. Anything bigger still degrades safely to the
// filename rather than to a wrong name.
const MAX_READ_BYTES = 32 * 1024 * 1024;

const KEYS = [
  'ProductName',
  'FileDescription',
  'ProductVersion',
  'FileVersion',
  'CompanyName',
];

function readPeVersionInfo(filePath) {
  let buf;
  try {
    const stat = fs.statSync(filePath);
    const toRead = Math.min(stat.size, MAX_READ_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  // Sanity check for MZ header - if absent, this isn't a PE and there's
  // nothing to extract.
  if (buf.length < 2 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null;

  // Anchor the search inside VS_VERSION_INFO to avoid matching random Unicode
  // strings elsewhere in the file.
  const anchor = Buffer.from('VS_VERSION_INFO\0', 'utf16le');

  // ── The window MUST be the resource, not "a big chunk after it" ──────────
  // This used to search 512KB past the anchor. That is far larger than any
  // version resource, so `indexOf` could match a key in completely unrelated
  // data and read a "value" out of it. Real example, kernel32.dll: the search
  // found a "FileDescription" outside the resource and returned
  //
  //   "灬楆敬敇噴牥楳湯求捯…"   = bytes lp|Fi|le|Ge|tV|er|si|on|In|fo…
  //
  // which is the ASCII text "lpFileGetVersionInfo…" from API documentation,
  // decoded as UTF-16. Users saw that as a mod's name.
  //
  // VS_VERSIONINFO's first field is wLength: the size of the WHOLE resource,
  // children included. Bounding the search by it makes a spurious match
  // impossible rather than unlikely.
  let anchorIdx = -1;
  let resStart = 0;
  let resEnd = 0;
  let from = 0;
  for (;;) {
    const at = buf.indexOf(anchor, from);
    if (at === -1) return null;
    const rs = at - 6;
    if (rs >= 0) {
      const wLength = buf.readUInt16LE(rs);
      const wValueLength = buf.readUInt16LE(rs + 2);

      // ── Identify the resource by its MAGIC, not by looking plausible ──────
      // "VS_VERSION_INFO" appears in DLLs that merely TALK about version
      // resources - type libraries, embedded docs, API strings. mstscax.dll has
      // two matches: the first has wLength 49024 and a "FileVersion" whose
      // String header reads wValueLength=0 wType=0 (i.e. not a String at all),
      // and reading it produced "摮牥慌瑳牆浡䥥d" = "nderLastFrameId". The
      // real resource is the SECOND match, wLength 992.
      //
      // A size sanity check picked the decoy, because 49024 is a perfectly
      // plausible-looking number. VS_FIXEDFILEINFO opens with the signature
      // 0xFEEF04BD, which is not a matter of judgement - so use that, and keep
      // walking until a candidate proves itself.
      const fixedAt = rs + ((((at + anchor.length) - rs) + 3) & ~3);
      const hasFixed = fixedAt + 4 <= buf.length
        && buf.readUInt32LE(fixedAt) === 0xFEEF04BD;

      if (hasFixed && wValueLength === 0x34 && wLength >= 0x40 && rs + wLength <= buf.length) {
        anchorIdx = at;
        resStart = rs;
        resEnd = rs + wLength;
        break;
      }
    }
    from = at + 2;
  }

  const window = buf.slice(anchorIdx, resEnd);

  const out = {};
  for (const key of KEYS) {
    const v = extractValueAfterKey(window, key, anchorIdx, resStart);
    if (v) {
      // Camel-case: "ProductName" -> "productName"
      out[key.charAt(0).toLowerCase() + key.slice(1)] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09) return true;
  }
  return false;
}

function extractValueAfterKey(buf, key, baseOffset = 0, resStart = 0) {
  const keyBuf = Buffer.from(key + '\0', 'utf16le');
  const idx = buf.indexOf(keyBuf);
  if (idx === -1) return null;

  // After the null-terminated key, pad to the next 4-byte boundary - measured
  // from the START OF THE VERSION RESOURCE.
  //
  // ── This has been wrong twice, in opposite directions ────────────────────
  // v1 aligned relative to the BUFFER, which starts at the szKey rather than at
  // the struct, so it was 6 bytes out and produced no names at all.
  //
  // v2 (the fix for that) aligned relative to the FILE, reasoning that the
  // VS_VERSIONINFO struct is DWORD-aligned in the file, so `anchorIdx` is
  // always 6 mod 4 = 2 and file-alignment is equivalent. It said "measured on
  // this machine, every single DLL agrees: (2)". **That is not true in
  // general.** Measured across ~5000 system DLLs on 2026-08-15:
  //
  //   mstscax.dll           anchorIdx % 4 = 0
  //   AutoUpdater.NET.dll   anchorIdx % 4 = 3
  //
  // The version resource is DWORD-aligned within its SECTION, and a section's
  // file offset need not be congruent to its RVA mod 4. When it is not, every
  // value is read 1-3 bytes off, and UTF-16LE decoding of shifted bytes turns
  // ASCII into CJK. That is the "random Chinese names" users reported:
  //
  //   ProductName  file-aligned "娀椀瀀䔀砀琀爀愀挀琀漀爀"  resource-aligned "ZipExtractor"
  //   CompanyName  file-aligned "刀䈀匀漀昀琀"          resource-aligned "RBSoft"
  //   FileVersion  file-aligned "㄀⸀㌀⸀㈀⸀　"          resource-aligned "1.3.2.0"
  //
  // The spec measures padding from the start of the version resource, so that
  // is what we do. It is correct for every alignment, not just the lucky one.
  const afterKeyAbs = idx + keyBuf.length + baseOffset;
  const alignedAbs = resStart + ((((afterKeyAbs - resStart) + 3) & ~3));
  let pos = alignedAbs - baseOffset;

  if (pos < 0 || pos >= buf.length - 2) return null;

  // The String struct is {wLength, wValueLength, wType, szKey, pad, Value}, so
  // the header sits immediately before the key we just found. wType tells us
  // whether Value is text at all, and wValueLength gives its exact length -
  // both far more trustworthy than scanning for a terminator.
  let wValueLength = 0;
  let wType = 1;
  const headAbs = idx + baseOffset - 6;
  if (headAbs >= resStart) {
    const h = idx - 6;
    if (h >= 0 && h + 6 <= buf.length) {
      wValueLength = buf.readUInt16LE(h + 2);
      wType = buf.readUInt16LE(h + 4);
    }
  }
  // wType 1 = text, 0 = binary. A binary "value" decoded as UTF-16 is exactly
  // the garbage we are trying to stop showing people.
  if (wType !== 1 && wType !== 0) return null;
  if (wType === 0 && wValueLength > 0) return null;

  const maxChars = 512;
  let end;
  if (wValueLength > 0 && wValueLength <= maxChars) {
    // Trust the declared length, minus the trailing NUL it counts.
    end = Math.min(pos + wValueLength * 2, buf.length & ~1);
  } else {
    // No usable length: fall back to scanning for the terminator, bounded.
    end = pos;
    let chars = 0;
    while (end < buf.length - 1 && chars < maxChars) {
      const c = buf.readUInt16LE(end);
      if (c === 0) break;
      if (c < 0x20 && c !== 0x09) return null;
      end += 2;
      chars += 1;
    }
  }
  if (end <= pos) return null;

  // Strip the counted NUL terminator and anything after it.
  let val = buf.slice(pos, end).toString('utf16le');
  const nul = val.indexOf('\0');
  if (nul !== -1) val = val.slice(0, nul);
  val = val.trim();
  if (!val) return null;

  // Last line of defence. A value carrying C0 control characters is not a
  // product name in any language - it is misread binary, and showing it to
  // someone as their mod's name is worse than falling back to the filename.
  // Deliberately NOT a script/charset check: "TODO: <产品名>" is a real
  // ProductName in a real DLL, and legitimate non-English names must survive.
  if (hasControlChars(val)) return null;

  return val;
}

module.exports = { readPeVersionInfo };
