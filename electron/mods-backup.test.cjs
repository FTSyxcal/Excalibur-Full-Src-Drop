// Folder-mod backups: don't breed them, don't show them, don't delete the one
// that matters.
//
// The bug this pins down, from a real install: fourteen
// `Wallpapers.backup-<epoch>` folders in plugins_disabled/, every one holding
// the same three PNGs, every one rendered in the mods list as its own mod
// ("Folder - 0 mods - 0 on"). It happened because a third-party mod recreates
// plugins/Wallpapers at game launch while the user's disabled copy sits in
// plugins_disabled/ - so every toggle collided.
//
// Three separate defects, and fixing only the first is why it "came back":
//   1. the collision took a backup even when the two copies were IDENTICAL
//   2. nothing filtered `*.backup-<epoch>` out of the mod list, so each one
//      showed up as an installed mod
//   3. the prune deleted EVERY older backup unconditionally - and on the real
//      install one of them was the only surviving copy of the user's own
//      `excalibur wallpaper.png`. A tidy-up that destroys user data.
//
// Real filesystem, no mocks: this is a bug about what fs actually does with
// directories (readFileSync throws EISDIR, rmSync needs `recursive`), and a
// fake fs is exactly what let it through the first time.
//
// Run: node electron/mods-backup.test.cjs

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const mods = require('./mods.cjs');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}

function tmpGame() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'excal-backup-'));
  fs.mkdirSync(path.join(root, 'BepInEx', 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(root, 'BepInEx', 'plugins_disabled'), { recursive: true });
  return root;
}
const P = (root, ...r) => path.join(root, 'BepInEx', 'plugins', ...r);
const D = (root, ...r) => path.join(root, 'BepInEx', 'plugins_disabled', ...r);

function writeFolder(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
}
const backupsIn = (dir) =>
  fs.readdirSync(dir).filter((f) => /\.backup-\d+$/.test(f));

// ── 1. The name filter ──────────────────────────────────────────────────────
check('isBackupArtifact matches what toggleMod actually writes', () => {
  assert.equal(mods.isBackupArtifact('Wallpapers.backup-1785531722757'), true);
  assert.equal(mods.isBackupArtifact('Foo.dll.backup-1'), true);
});

check('isBackupArtifact does NOT eat real mods', () => {
  // The whole risk of a name filter is catching somebody's actual mod.
  assert.equal(mods.isBackupArtifact('Backup'), false);
  assert.equal(mods.isBackupArtifact('BackupTool'), false);
  assert.equal(mods.isBackupArtifact('Wallpapers'), false);
  assert.equal(mods.isBackupArtifact('Wallpapers.backup'), false, 'no timestamp, so a user named it');
  assert.equal(mods.isBackupArtifact('Wallpapers.backup-abc'), false, 'not our format');
  assert.equal(mods.isBackupArtifact('Wallpapers.backup-123.keep'), false, 'suffixed by hand');
  assert.equal(mods.isBackupArtifact(''), false);
  assert.equal(mods.isBackupArtifact(null), false);
});

// ── 2. Identical folders must not breed backups ─────────────────────────────
check('toggling with an IDENTICAL copy at the destination makes no backup', () => {
  const g = tmpGame();
  const wall = { 'Calm.png': 'a', 'Default.png': 'b', 'Windows.png': 'c' };
  writeFolder(P(g, 'Wallpapers'), wall);
  writeFolder(D(g, 'Wallpapers'), wall);      // the exact real-world shape

  mods.toggleMod(P(g, 'Wallpapers'), false);

  assert.deepEqual(backupsIn(D(g)), [], 'an identical duplicate is not worth a backup');
  assert.equal(fs.existsSync(P(g, 'Wallpapers')), false, 'the redundant copy is removed');
  assert.equal(fs.existsSync(D(g, 'Wallpapers')), true, 'the kept copy survives');
});

check('twelve toggles in a row still leave zero backups', () => {
  // The actual reported symptom was a count that only ever grew.
  const g = tmpGame();
  const wall = { 'Calm.png': 'a', 'Windows.png': 'c' };
  writeFolder(D(g, 'Wallpapers'), wall);
  for (let i = 0; i < 12; i++) {
    writeFolder(P(g, 'Wallpapers'), wall);    // the mod recreates it each launch
    mods.toggleMod(P(g, 'Wallpapers'), false);
  }
  assert.deepEqual(backupsIn(D(g)), []);
});

// ── 3. A REAL difference still gets backed up ───────────────────────────────
check('a genuinely different destination is still backed up, exactly once', () => {
  const g = tmpGame();
  writeFolder(P(g, 'Wallpapers'), { 'Calm.png': 'NEW' });
  writeFolder(D(g, 'Wallpapers'), { 'Calm.png': 'OLD' });

  mods.toggleMod(P(g, 'Wallpapers'), false);

  const bks = backupsIn(D(g));
  assert.equal(bks.length, 1, 'one backup, not zero - real content must not vanish');
  assert.equal(fs.readFileSync(path.join(D(g), bks[0], 'Calm.png'), 'utf8'), 'OLD');
  assert.equal(fs.readFileSync(D(g, 'Wallpapers', 'Calm.png'), 'utf8'), 'NEW');
});

// ── 4. The data-loss bug ────────────────────────────────────────────────────
check('a backup holding UNIQUE content is never pruned', () => {
  const g = tmpGame();
  // Exactly the real install: one old backup is the only copy of a wallpaper
  // the user added themselves.
  writeFolder(D(g, 'Wallpapers.backup-1000'), {
    'Calm.png': 'a', 'excalibur wallpaper.png': 'PRECIOUS',
  });
  writeFolder(D(g, 'Wallpapers'), { 'Calm.png': 'a' });
  writeFolder(P(g, 'Wallpapers'), { 'Calm.png': 'DIFFERENT' });   // forces the backup path

  mods.toggleMod(P(g, 'Wallpapers'), false);

  assert.equal(
    fs.existsSync(D(g, 'Wallpapers.backup-1000', 'excalibur wallpaper.png')), true,
    'the only copy of a user file must survive a tidy-up',
  );
  assert.equal(
    fs.readFileSync(D(g, 'Wallpapers.backup-1000', 'excalibur wallpaper.png'), 'utf8'), 'PRECIOUS',
  );
});

check('a REDUNDANT backup is pruned, so they stop piling up', () => {
  const g = tmpGame();
  writeFolder(D(g, 'Wallpapers.backup-1000'), { 'Calm.png': 'a' });
  writeFolder(D(g, 'Wallpapers.backup-1001'), { 'Calm.png': 'a' });
  writeFolder(D(g, 'Wallpapers'), { 'Calm.png': 'a' });
  writeFolder(P(g, 'Wallpapers'), { 'Calm.png': 'DIFFERENT' });

  mods.toggleMod(P(g, 'Wallpapers'), false);

  const bks = backupsIn(D(g));
  assert.equal(bks.includes('Wallpapers.backup-1000'), false, 'fully covered - prune it');
  assert.equal(bks.includes('Wallpapers.backup-1001'), false);
  assert.equal(bks.length, 1, 'only the one just taken remains');
});

check('a hand-named lookalike is left alone by the prune', () => {
  const g = tmpGame();
  writeFolder(D(g, 'Wallpapers.backup-123.keep'), { 'mine.png': 'x' });
  writeFolder(D(g, 'Wallpapers'), { 'Calm.png': 'a' });
  writeFolder(P(g, 'Wallpapers'), { 'Calm.png': 'DIFFERENT' });

  mods.toggleMod(P(g, 'Wallpapers'), false);

  assert.equal(fs.existsSync(D(g, 'Wallpapers.backup-123.keep', 'mine.png')), true,
    'only our own exact naming may be pruned');
});

check('unique backups ROTATE rather than growing without bound', () => {
  // The other half of the trade-off. Preserving unique content is right, but a
  // mod that rewrites its own files every launch would then grow one folder per
  // toggle - which is the original complaint again. Unique backups rotate at
  // MAX_UNIQUE_BACKUPS (3).
  const g = tmpGame();
  writeFolder(D(g, 'Wallpapers'), { 'Calm.png': 'v0' });
  for (let i = 1; i <= 8; i++) {
    writeFolder(P(g, 'Wallpapers'), { 'Calm.png': `v${i}` });   // different every time
    mods.toggleMod(P(g, 'Wallpapers'), false);
  }
  const bks = backupsIn(D(g));
  assert.equal(bks.length, 3, 'eight differing toggles must not leave eight folders');
  // The ones kept are the NEWEST, so the most recent undo is always available.
  const newest = bks.map((f) => Number(f.split('-').pop())).sort((a, b) => a - b);
  assert.equal(newest.length, 3);
});

check('a redundant backup is pruned even when a unique one is also present', () => {
  // The real install's exact mix: many duplicates plus one that mattered.
  const g = tmpGame();
  writeFolder(D(g, 'Wallpapers.backup-1000'), { 'Calm.png': 'a', 'mine.png': 'UNIQUE' });
  writeFolder(D(g, 'Wallpapers.backup-1001'), { 'Calm.png': 'a' });
  writeFolder(D(g, 'Wallpapers.backup-1002'), { 'Calm.png': 'a' });
  writeFolder(D(g, 'Wallpapers'), { 'Calm.png': 'a' });
  writeFolder(P(g, 'Wallpapers'), { 'Calm.png': 'DIFFERENT' });

  mods.toggleMod(P(g, 'Wallpapers'), false);

  assert.equal(fs.existsSync(D(g, 'Wallpapers.backup-1000', 'mine.png')), true, 'unique survives');
  assert.equal(fs.existsSync(D(g, 'Wallpapers.backup-1001')), false, 'duplicate pruned');
  assert.equal(fs.existsSync(D(g, 'Wallpapers.backup-1002')), false, 'duplicate pruned');
});

// ── 5. They must not appear in the list ─────────────────────────────────────
check('backups are hidden from scanMods, in BOTH trees', () => {
  const g = tmpGame();
  writeFolder(P(g, 'RealMod'), { 'RealMod.dll': 'x' });
  writeFolder(P(g, 'RealMod.backup-1785531722757'), { 'RealMod.dll': 'x' });
  writeFolder(D(g, 'Wallpapers'), { 'Calm.png': 'a' });
  writeFolder(D(g, 'Wallpapers.backup-1785531722757'), { 'Calm.png': 'a' });

  const names = mods.scanMods(g).mods.map((m) => m.fileName).sort();
  assert.deepEqual(names, ['RealMod', 'Wallpapers'],
    'a backup is not a mod the user installed and must never be listed as one');
});

console.log(`\nmods-backup: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
