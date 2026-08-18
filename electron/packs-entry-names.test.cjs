// Containment tests for .gtmp pack extraction entry names.
//
// WHY: extractPackForProfile() guarded entry names with
//   const safe = path.basename(mod.name);
//   if (safe !== mod.name) continue;
// which reads like a containment check and is not one. basename('.') === '.'
// and basename('..') === '..', so BOTH pass unchanged, and the destination is
// then path.join(destDir, safe):
//
//   '.'   -> destDir        (the pack folder being installed)
//   '..'  -> packsBaseDir   (EVERY pack the user has)
//
// extractFolderTo() opens with rmSync(destFolder, { recursive: true }) to clear
// stale files, so a pack file carrying a mod entry named ".." deleted the user's
// entire packs directory the moment they opened it. .gtmp files are shared
// between users, so this was reachable by anyone who could hand somebody a pack.
//
// Pure path logic - touches no real files.

const path = require('node:path');
const assert = require('node:assert');
const fs = require('node:fs');

let passed = 0;
const ok = (label, cond) => { assert.ok(cond, label); passed++; };

const PACKS_BASE = path.join('C:', 'Users', 'x', 'AppData', 'Roaming', 'Excalibur', 'packs');
const DEST_DIR   = path.join(PACKS_BASE, 'pack-abc123');

// The rule as it now stands in electron/packs.cjs.
function accepts(name) {
  if (typeof name !== 'string') return false;
  const safe = path.basename(name);
  if (safe !== name) return false;
  if (safe === '.' || safe === '..' || safe === '') return false;
  const dest = path.join(DEST_DIR, safe);
  const rel = path.relative(path.resolve(DEST_DIR), path.resolve(dest));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

// ── The two that used to escape ──────────────────────────────────────────
ok('rejects "." (would rm -rf the pack folder)', !accepts('.'));
ok('rejects ".." (would rm -rf EVERY pack)',     !accepts('..'));

// Prove the escape was real, so this test still means something if someone
// "simplifies" the guard back to basename-only later.
ok('"." really did resolve to the pack folder',
  path.resolve(path.join(DEST_DIR, path.basename('.'))) === path.resolve(DEST_DIR));
ok('".." really did resolve to the packs root',
  path.resolve(path.join(DEST_DIR, path.basename('..'))) === path.resolve(PACKS_BASE));

// ── Everything else that must stay rejected ──────────────────────────────
for (const bad of ['', 'sub/dir', 'sub\\dir', '../evil', '..\\evil', 'C:/Windows/evil', null, undefined, 42]) {
  ok(`rejects ${JSON.stringify(bad)}`, !accepts(bad));
}

// ── Real names must still install ────────────────────────────────────────
for (const good of ['MyMod.dll', 'MyMod', 'Mod With Spaces', 'Mod-With_Punct.v2', '日本語Mod', 'a.b.c']) {
  ok(`accepts ${JSON.stringify(good)}`, accepts(good));
}

// ── The source file still has the guard ──────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, 'packs.cjs'), 'utf8');
  ok('packs.cjs rejects . and .. by name', src.includes("safe === '.' || safe === '..'"));
  ok('packs.cjs keeps the containment backstop', src.includes('path.relative(path.resolve(destDir)'));
}

console.log(`packs-entry-names: ${passed} passed`);
