// Assertions for per-profile desktop shortcuts.
//
//   node electron/shortcuts.test.cjs
//
// Only the pure half is covered here: filename sanitising, the argument string
// written into the .lnk, and reading the profile id back out of it. The
// Electron-backed half (writeShortcutLink, nativeImage, the desktop sweep)
// needs a real Electron process and is exercised by hand.
//
// The round-trip at the bottom is the one that matters. Shortcut ownership is
// identified by parsing the id back out of the arguments, so if building and
// parsing ever disagree, every shortcut silently becomes an orphan: "already
// has a shortcut" goes wrong, removal stops working, and renaming a profile
// leaves a duplicate icon on the desktop.

const assert = require('node:assert/strict');
const {
  safeShortcutName,
  shortcutFileName,
  buildShortcutArgs,
  parseProfileIdFromArgs,
  buildIco,
  ICO_SIZES,
} = require('./shortcuts.cjs');

let n = 0;
const ok = (label, fn) => { fn(); n++; void label; };

// ---------------------------------------------------------------------------
// Filename sanitising
// ---------------------------------------------------------------------------

ok('characters Windows forbids are replaced', () => {
  assert.equal(safeShortcutName('a<b>c:d"e|f?g*h'), 'a b c d e f g h');
  assert.equal(safeShortcutName('slash/and' + String.fromCharCode(92) + 'back'), 'slash and back');
});

// Both are legal in a filename. Stripping them was a real bug in the first
// draft of this file: it renamed the user's modpack behind their back.
ok('spaces and hyphens survive', () => {
  assert.equal(safeShortcutName('Half-Life mods'), 'Half-Life mods');
  assert.equal(safeShortcutName('My Cool Pack'), 'My Cool Pack');
});

ok('runs of whitespace collapse and the result is trimmed', () => {
  assert.equal(safeShortcutName('  too    many   spaces  '), 'too many spaces');
});

// Explorer silently drops these, so a name ending in one would make the file
// we wrote and the file we look for disagree.
ok('trailing dots and spaces are removed', () => {
  assert.equal(safeShortcutName('Wat...'), 'Wat');
  assert.equal(safeShortcutName('Trailing   '), 'Trailing');
});

ok('an empty or all-invalid name falls back rather than producing ".lnk"', () => {
  assert.equal(safeShortcutName(''), 'Modpack');
  assert.equal(safeShortcutName(null), 'Modpack');
  assert.equal(safeShortcutName(undefined), 'Modpack');
  assert.equal(safeShortcutName('???'), 'Modpack');
  assert.equal(safeShortcutName('   '), 'Modpack');
});

// CON.lnk cannot be created on Windows at all, and the failure says nothing
// about why. A user naming a modpack "con" is unlikely but costs one branch.
ok('reserved device names are defused', () => {
  assert.equal(safeShortcutName('con'), 'con modpack');
  assert.equal(safeShortcutName('NUL'), 'NUL modpack');
  assert.equal(safeShortcutName('com4'), 'com4 modpack');
  assert.equal(safeShortcutName('console'), 'console');   // only the exact name
});

ok('long names are capped without leaving a trailing space', () => {
  const out = safeShortcutName('x'.repeat(200));
  assert.equal(out.length, 60);
  assert.doesNotMatch(out, /[. ]$/);
});

ok('the filename carries the Excalibur suffix', () => {
  assert.equal(shortcutFileName('Speedrun'), 'Speedrun - Excalibur.lnk');
  assert.equal(shortcutFileName(''), 'Modpack - Excalibur.lnk');
});

// ---------------------------------------------------------------------------
// The argument string
// ---------------------------------------------------------------------------

// A packaged execPath IS Excalibur.exe, so an app path here would be parsed as
// a file to open and the app would not start.
ok('a packaged shortcut passes only the url', () => {
  assert.equal(
    buildShortcutArgs({ profileId: 'abc', appPath: 'C:/proj', isPackaged: true }),
    'excalibur://play/abc',
  );
});

// In dev, execPath is electron.exe, which opens an empty Electron unless the
// project directory comes first. Shortcuts made in dev used to be dead.
ok('a dev shortcut passes the app directory before the url', () => {
  assert.equal(
    buildShortcutArgs({ profileId: 'abc', appPath: 'C:/proj', isPackaged: false }),
    'C:/proj excalibur://play/abc',
  );
});

ok('an app path containing spaces is quoted', () => {
  assert.equal(
    buildShortcutArgs({ profileId: 'abc', appPath: 'C:/My Projects/excalibur', isPackaged: false }),
    '"C:/My Projects/excalibur" excalibur://play/abc',
  );
});

ok('a missing app path degrades to the url rather than emitting a stray space', () => {
  assert.equal(buildShortcutArgs({ profileId: 'abc', appPath: null, isPackaged: false }), 'excalibur://play/abc');
});

// ---------------------------------------------------------------------------
// Reading ownership back
// ---------------------------------------------------------------------------

ok('the profile id is read back from both argument shapes', () => {
  assert.equal(parseProfileIdFromArgs('excalibur://play/abc'), 'abc');
  assert.equal(parseProfileIdFromArgs('"C:/My Projects/x" excalibur://play/abc'), 'abc');
});

// Everything else on the desktop must be invisible to us, including
// Excalibur's own launcher shortcut, or removal would delete the wrong file.
ok('shortcuts that are not ours are ignored', () => {
  assert.equal(parseProfileIdFromArgs(''), null);
  assert.equal(parseProfileIdFromArgs(null), null);
  assert.equal(parseProfileIdFromArgs(undefined), null);
  assert.equal(parseProfileIdFromArgs('--startup-minimized'), null);
  assert.equal(parseProfileIdFromArgs('excalibur://profile/someone'), null);
  assert.equal(parseProfileIdFromArgs('C:/games/other.exe'), null);
});

ok('the standard profile is not a special case', () => {
  assert.equal(parseProfileIdFromArgs(buildShortcutArgs({ profileId: 'standard', isPackaged: true })), 'standard');
});

// The invariant the whole ownership model rests on.
ok('build -> parse round-trips for every id shape we generate', () => {
  const ids = [
    'standard',
    'abc',
    'a-b_c',
    '1753742891234',
    'profile with spaces',
    'ünïcode',
    'sym#bol&s',
  ];
  for (const id of ids) {
    for (const isPackaged of [true, false]) {
      const args = buildShortcutArgs({ profileId: id, appPath: 'C:/My Projects/x', isPackaged });
      assert.equal(parseProfileIdFromArgs(args), id, `round-trip failed for ${JSON.stringify(id)} (packaged=${isPackaged})`);
    }
  }
});

// ---------------------------------------------------------------------------
// The .ico container
//
// Hand-rolled because png-to-ico is ESM-only and Electron 31's Node cannot
// require() it - and because that failure was swallowed by the icon try/catch,
// it looked like it worked while every shortcut quietly used the fallback
// icon. Byte-level assertions here are what stop that being invisible again.
// ---------------------------------------------------------------------------

const fakePng = (n, byte) => Buffer.alloc(n, byte);

ok('the header declares an icon and the right image count', () => {
  const ico = buildIco([{ size: 16, png: fakePng(10, 1) }, { size: 32, png: fakePng(20, 2) }]);
  assert.equal(ico.readUInt16LE(0), 0, 'reserved must be 0');
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icon, 2 would be a cursor');
  assert.equal(ico.readUInt16LE(4), 2, 'image count');
});

ok('each directory entry points at its own image data', () => {
  const a = fakePng(10, 0xaa);
  const b = fakePng(20, 0xbb);
  const ico = buildIco([{ size: 16, png: a }, { size: 32, png: b }]);
  const dirAt = (i) => 6 + i * 16;

  assert.equal(ico.readUInt32LE(dirAt(0) + 8), 10, 'first length');
  assert.equal(ico.readUInt32LE(dirAt(1) + 8), 20, 'second length');

  const off0 = ico.readUInt32LE(dirAt(0) + 12);
  const off1 = ico.readUInt32LE(dirAt(1) + 12);
  assert.equal(off0, 6 + 32, 'data starts after header + both entries');
  assert.equal(off1, off0 + 10, 'second image follows the first');
  assert.deepEqual(ico.subarray(off0, off0 + 10), a);
  assert.deepEqual(ico.subarray(off1, off1 + 20), b);
});

// The width/height fields are ONE byte, so 256 does not fit and the format
// spells it 0. Writing 256 here truncates to 0 by accident on some platforms
// and throws on others; either way the largest icon is the one Explorer shows
// most prominently, so it is worth pinning.
ok('256 is encoded as 0 in the one-byte size fields', () => {
  const ico = buildIco([{ size: 256, png: fakePng(4, 9) }]);
  assert.equal(ico.readUInt8(6 + 0), 0, 'width');
  assert.equal(ico.readUInt8(6 + 1), 0, 'height');
});

ok('sizes below 256 are written literally', () => {
  const ico = buildIco([{ size: 48, png: fakePng(4, 9) }]);
  assert.equal(ico.readUInt8(6 + 0), 48);
  assert.equal(ico.readUInt8(6 + 1), 48);
});

ok('the total length accounts for every byte', () => {
  const images = [{ size: 16, png: fakePng(7, 1) }, { size: 32, png: fakePng(11, 2) }, { size: 48, png: fakePng(13, 3) }];
  const expected = 6 + 16 * 3 + 7 + 11 + 13;
  assert.equal(buildIco(images).length, expected);
});

ok('the size list covers what Explorer asks for', () => {
  assert.ok(ICO_SIZES.includes(256), 'large-icon views');
  assert.ok(ICO_SIZES.includes(16), 'taskbar and properties dialog');
  assert.deepEqual([...ICO_SIZES].sort((a, b) => b - a), ICO_SIZES, 'largest first');
});

console.log(`[shortcuts] ${n} assertion groups passed`);
