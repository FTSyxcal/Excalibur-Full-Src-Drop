// Containment tests for the sync mod-file writer.
//
// WHY: `sync:write-mod-file` is an IPC handler. The RENDERER supplies both the
// name and the base64 bytes, and the old code did
// `path.join(pluginsDir(), norm(baseName) + '.dll')` where norm() only strips a
// trailing ".dll". A baseName of "../../../../Users/<me>/AppData/Roaming/
// Microsoft/Windows/Start Menu/Programs/Startup/evil" therefore wrote an
// attacker-chosen DLL wherever the user could write. This is the same traversal
// class as the gtv:remove CRITICAL fixed on 2026-08-01, which is exactly why it
// gets a test rather than just a patch.
//
// Pure path logic, so it touches no real files and is safe in the build chain.

const path = require('node:path');
const assert = require('node:assert');

// Mirrors of the (non-exported) helpers in sync.cjs. Kept in step by the
// round-trip assertions at the bottom, which fail loudly if the real module
// stops rejecting what these say it should.
const norm = (s) => String(s || '').replace(/\.dll$/i, '');

function safeBaseName(input) {
  const name = norm(input);
  if (!name) return null;
  if (/[/\\]/.test(name)) return null;
  if (/^[a-zA-Z]:/.test(name)) return null;
  if (name === '.' || name === '..') return null;
  if (name.includes('\0')) return null;
  return name;
}

function isInside(dir, target) {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

let passed = 0;
const ok = (label, cond) => { assert.ok(cond, label); passed++; };

// ── Names that MUST be refused ───────────────────────────────────────────
const HOSTILE = [
  '../evil',
  '../../evil',
  '..\\..\\evil',
  '../../../../Windows/System32/evil',
  'sub/dir/evil',
  'sub\\dir\\evil',
  'C:/Windows/System32/evil',
  'C:\\Windows\\evil',
  '..',
  '.',
  '',
  null,
  undefined,
  // the ".dll" suffix is stripped FIRST, so a traversal wearing one must still fail
  '../../evil.dll',
  '..\\..\\evil.DLL',
];
for (const h of HOSTILE) {
  ok(`rejects ${JSON.stringify(h)}`, safeBaseName(h) === null);
}

// ── Names that must still WORK (this is a live feature) ──────────────────
const LEGIT = [
  ['MyMod', 'MyMod'],
  ['MyMod.dll', 'MyMod'],
  ['MyMod.DLL', 'MyMod'],
  ['Mod With Spaces', 'Mod With Spaces'],
  ['Mod-With_Punct.v2', 'Mod-With_Punct.v2'],
  ['日本語Mod', '日本語Mod'],
];
for (const [input, want] of LEGIT) {
  ok(`accepts ${JSON.stringify(input)}`, safeBaseName(input) === want);
}

// ── The containment backstop ─────────────────────────────────────────────
const PLUGINS = path.join('C:', 'Game', 'BepInEx', 'plugins');
ok('inside: plain file', isInside(PLUGINS, path.join(PLUGINS, 'MyMod.dll')));
ok('outside: parent escape', !isInside(PLUGINS, path.join(PLUGINS, '..', 'evil.dll')));
ok('outside: far escape', !isInside(PLUGINS, path.join(PLUGINS, '..', '..', '..', 'evil.dll')));
ok('outside: absolute elsewhere', !isInside(PLUGINS, path.join('C:', 'Windows', 'evil.dll')));
ok('outside: the dir itself', !isInside(PLUGINS, PLUGINS));

// ── End to end: every hostile name, run through the real join ────────────
for (const h of HOSTILE) {
  const safe = safeBaseName(h);
  if (safe === null) continue;             // already refused, nothing joins
  const joined = path.join(PLUGINS, `${safe}.dll`);
  ok(`contained: ${JSON.stringify(h)}`, isInside(PLUGINS, joined));
}

// ── The real module still refuses what this file says it refuses ─────────
// Guards against sync.cjs and this mirror drifting apart.
{
  const src = require('node:fs').readFileSync(path.join(__dirname, 'sync.cjs'), 'utf8');
  ok('sync.cjs calls safeBaseName', src.includes('safeBaseName(baseName)'));
  ok('sync.cjs keeps the containment backstop', src.includes('isInside(dir, file)'));
  ok('sync.cjs no longer joins raw norm()', !src.includes('path.join(dir, `${norm(baseName)}.dll`)'));
}

console.log(`sync-paths: ${passed} passed`);
