// parseLibraryFoldersVdf: does it actually find the installed app ids?
//
// WHY: the original matcher was a LAZY regex that stopped at the first
// newline-then-brace inside a library block - which is always the closing brace
// of the nested "apps" sub-block. The body was therefore truncated before the
// apps data, and `apps` came back EMPTY for every library on every machine.
// Paths still parsed, so nothing looked broken; the "is Gorilla Tag in this
// library" signal just silently never fired.
//
// The old code passes a "does it find the libraries" test. It only fails a test
// that asserts the APP IDS, which is why this file asserts those.

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// The module talks to the Windows registry on load, so pull the function out by
// source rather than requiring it. Keeps this test pure and cross-platform.
const src = fs.readFileSync(path.join(__dirname, 'steam.cjs'), 'utf8');
const start = src.indexOf('function parseLibraryFoldersVdf(vdfText) {');
const end = src.indexOf('function gtPluginCount(gtFolder) {');
assert.ok(start >= 0 && end > start, 'could not locate parseLibraryFoldersVdf in steam.cjs');
// eslint-disable-next-line no-new-func
const parseLibraryFoldersVdf = new Function(`${src.slice(start, end)}; return parseLibraryFoldersVdf;`)();

const GT_APPID = '1533390';

// Shaped like a real libraryfolders.vdf: tabs, escaped backslashes, and an
// "apps" block nested inside each numbered library block.
const VDF = [
  '"libraryfolders"',
  '{',
  '\t"0"',
  '\t{',
  '\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"',
  '\t\t"label"\t\t""',
  '\t\t"contentid"\t\t"123"',
  '\t\t"apps"',
  '\t\t{',
  '\t\t\t"228980"\t\t"123456"',
  `\t\t\t"${GT_APPID}"\t\t"987654321"`,
  '\t\t}',
  '\t}',
  '\t"1"',
  '\t{',
  '\t\t"path"\t\t"D:\\\\SteamLibrary"',
  '\t\t"apps"',
  '\t\t{',
  '\t\t\t"440"\t\t"111"',
  '\t\t}',
  '\t}',
  '}',
  '',
].join('\n');

let passed = 0;
const ok = (label, cond) => { assert.ok(cond, label); passed++; };

const libs = parseLibraryFoldersVdf(VDF);

ok('finds both libraries', libs.length === 2);
ok('first library path unescaped', libs[0].path === 'C:\\Program Files (x86)\\Steam');
ok('second library path unescaped', libs[1].path === 'D:\\SteamLibrary');

// THE ASSERTIONS THAT MATTER - these are what the old parser failed.
ok('first library reports its apps', libs[0].apps.length === 2);
ok('Gorilla Tag app id is found', libs[0].apps.includes(GT_APPID));
ok('unrelated app id also found', libs[0].apps.includes('228980'));
ok('second library reports its apps', libs[1].apps.length === 1 && libs[1].apps[0] === '440');
ok('GT is NOT reported in the library that lacks it', !libs[1].apps.includes(GT_APPID));

// Degenerate input must not throw or hang.
ok('empty input', parseLibraryFoldersVdf('').length === 0);
ok('no apps block', parseLibraryFoldersVdf('"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t"C:\\\\S"\n\t}\n}').length === 1);
ok('unbalanced braces do not hang', Array.isArray(parseLibraryFoldersVdf('"0"\n{\n\t"path" "C:\\\\S"\n')));

console.log(`steam-vdf: ${passed} passed`);
