// The file-system half of the Mods page - rename, install and bulk toggle.
//
// These three had no coverage of any kind, which is how they kept a set of bugs
// that only show up against a REAL filesystem and never against a mental model
// of one:
//
//   * renameMod compared names case-sensitively and then checked for a
//     collision case-INSENSITIVELY, so fixing a mod's capitalisation reported
//     the file as blocking itself.
//   * renameMod only touched the copy in front of it, so a mod with a copy in
//     both plugins/ and plugins_disabled/ became two mods.
//   * installMods copied over whatever was already there, with no existence
//     check and no backup, in a file where every other mutation guards a
//     collision.
//   * setAllMods iterated the top level only, so "Enable all" silently skipped
//     every mod nested inside a folder.
//
// Nothing here mocks fs: it builds a real <tmp>/BepInEx/plugins tree, because
// the case-insensitive-rename bug is invisible to a fake filesystem - it IS the
// filesystem's behaviour.
//
// Run: node electron/mods-fs.test.cjs

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const mods = require('./mods.cjs');

let pass = 0;
const t = (label, fn) => {
  try { fn(); pass++; console.log(`  PASS  ${label}`); }
  catch (e) { console.error(`  FAIL  ${label}\n        ${e.message}`); process.exitCode = 1; }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'excalibur-mods-test-'));
const PLUGINS = path.join(ROOT, 'BepInEx', 'plugins');
const DISABLED = path.join(ROOT, 'BepInEx', 'plugins_disabled');

const writeDll = (dir, name, body) => {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};
const names = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const read = (p) => fs.readFileSync(p, 'utf8');

try {
  fs.mkdirSync(PLUGINS, { recursive: true });
  fs.mkdirSync(DISABLED, { recursive: true });

  console.log('\n=== mods.cjs filesystem behaviour ===');

  // ── rename ────────────────────────────────────────────────────────────
  t('a case-only rename succeeds instead of blaming the file for existing', () => {
    const dir = path.join(PLUGINS, 'case');
    const p = writeDll(dir, 'MonkeMod.dll', 'monke');
    const r = mods.renameMod(p, 'monkemod.dll');
    assert.equal(r.renamed, true, 'renameMod reported nothing to do');
    // One file, and its name is the one that was asked for. On a
    // case-insensitive filesystem the old check threw here instead.
    assert.deepEqual(names(dir), ['monkemod.dll']);
    assert.equal(read(path.join(dir, 'monkemod.dll')), 'monke');
  });

  t('a DIFFERENT neighbour with the target name is still refused', () => {
    const dir = path.join(PLUGINS, 'clash');
    const p = writeDll(dir, 'Alpha.dll', 'a');
    writeDll(dir, 'Beta.dll', 'b');
    assert.throws(() => mods.renameMod(p, 'Beta.dll'), /already exists here/);
    assert.deepEqual(names(dir), ['Alpha.dll', 'Beta.dll'], 'nothing moved');
    assert.equal(read(path.join(dir, 'Beta.dll')), 'b', 'the neighbour was not clobbered');
  });

  t('renaming a mod renames its disabled twin too', () => {
    const on = writeDll(PLUGINS, 'Twin.dll', 'twin');
    writeDll(DISABLED, 'Twin.dll', 'twin-off');
    const r = mods.renameMod(on, 'Renamed');
    assert.equal(r.renamed, true);
    assert.equal(path.basename(r.path), 'Renamed.dll');
    assert.equal(fs.existsSync(path.join(PLUGINS, 'Renamed.dll')), true);
    // The point of the fix: no leftover under the old name, or the next scan
    // lists two mods and Standard re-adopts the orphan as a new one.
    assert.equal(fs.existsSync(path.join(DISABLED, 'Twin.dll')), false, 'the twin was left behind');
    assert.equal(fs.existsSync(path.join(DISABLED, 'Renamed.dll')), true, 'the twin did not follow');
    assert.equal(read(path.join(DISABLED, 'Renamed.dll')), 'twin-off', 'the twin content changed');
  });

  t('a blocked twin blocks the whole rename, leaving both sides untouched', () => {
    const on = writeDll(PLUGINS, 'Pair.dll', 'pair');
    writeDll(DISABLED, 'Pair.dll', 'pair-off');
    writeDll(DISABLED, 'Taken.dll', 'taken');
    assert.throws(() => mods.renameMod(on, 'Taken'), /already exists in the disabled folder/);
    assert.equal(fs.existsSync(path.join(PLUGINS, 'Pair.dll')), true, 'the enabled copy moved anyway');
    assert.equal(fs.existsSync(path.join(PLUGINS, 'Taken.dll')), false);
    assert.equal(read(path.join(DISABLED, 'Taken.dll')), 'taken', 'the blocker was clobbered');
    fs.rmSync(on, { force: true });
    fs.rmSync(path.join(DISABLED, 'Pair.dll'), { force: true });
    fs.rmSync(path.join(DISABLED, 'Taken.dll'), { force: true });
  });

  // ── install ───────────────────────────────────────────────────────────
  const INBOX = path.join(ROOT, 'inbox');

  t('installing over an existing mod keeps the original and lands as "(2)"', () => {
    writeDll(PLUGINS, 'Coll.dll', 'ORIGINAL');
    const src = writeDll(INBOX, 'Coll.dll', 'DIFFERENT');
    const [r] = mods.installMods(ROOT, PLUGINS, [src]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.name, 'Coll (2).dll');
    assert.equal(r.renamedTo, 'Coll (2).dll', 'callers need to be able to say what happened');
    assert.equal(r.kind, 'file');
    assert.equal(r.dest, path.join(PLUGINS, 'Coll (2).dll'));
    // The whole point: the mod the user already had is still there, byte for
    // byte. The old code copied straight over it with no backup.
    assert.equal(read(path.join(PLUGINS, 'Coll.dll')), 'ORIGINAL');
    assert.equal(read(path.join(PLUGINS, 'Coll (2).dll')), 'DIFFERENT');
  });

  t('installing the SAME bytes again is skipped, not copied a third time', () => {
    const src = path.join(INBOX, 'Coll.dll');   // still "DIFFERENT"
    const [r] = mods.installMods(ROOT, PLUGINS, [src]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.skipped, true);
    assert.equal(r.dest, path.join(PLUGINS, 'Coll (2).dll'), 'points at the copy already installed');
    assert.equal(fs.existsSync(path.join(PLUGINS, 'Coll (3).dll')), false, 'a duplicate was created');
  });

  t('a disabled twin counts as a collision, so no confusing on/off pair appears', () => {
    writeDll(DISABLED, 'Ghost.dll', 'GHOST');
    const src = writeDll(INBOX, 'Ghost.dll', 'NEWER');
    const [r] = mods.installMods(ROOT, PLUGINS, [src]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.name, 'Ghost (2).dll');
    assert.equal(fs.existsSync(path.join(PLUGINS, 'Ghost.dll')), false,
      'installed as the twin\'s name - the same mod would show up twice, once on and once off');
    assert.equal(read(path.join(DISABLED, 'Ghost.dll')), 'GHOST', 'the disabled twin was touched');
  });

  t('a disabled twin with identical bytes is skipped rather than duplicated', () => {
    const src = writeDll(INBOX, 'Echo.dll', 'ECHO');
    writeDll(DISABLED, 'Echo.dll', 'ECHO');
    const [r] = mods.installMods(ROOT, PLUGINS, [src]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.skipped, true);
    assert.equal(r.dest, path.join(DISABLED, 'Echo.dll'));
    assert.equal(fs.existsSync(path.join(PLUGINS, 'Echo.dll')), false);
  });

  t('a folder mod collides on content too, and non-DLL files are still refused', () => {
    const srcFolder = path.join(INBOX, 'FolderMod');
    writeDll(srcFolder, 'FolderMod.dll', 'v1');
    const first = mods.installMods(ROOT, PLUGINS, [srcFolder])[0];
    assert.equal(first.ok, true, first.error);
    assert.equal(first.kind, 'dir');
    const again = mods.installMods(ROOT, PLUGINS, [srcFolder])[0];
    assert.equal(again.skipped, true, 'an unchanged folder re-drop should be a no-op');
    fs.writeFileSync(path.join(srcFolder, 'FolderMod.dll'), 'v2');
    const changed = mods.installMods(ROOT, PLUGINS, [srcFolder])[0];
    assert.equal(changed.name, 'FolderMod (2)');
    assert.equal(read(path.join(PLUGINS, 'FolderMod', 'FolderMod.dll')), 'v1', 'the v1 folder was overwritten');

    const junk = path.join(INBOX, 'notes.txt');
    fs.writeFileSync(junk, 'hello');
    const bad = mods.installMods(ROOT, PLUGINS, [junk])[0];
    assert.equal(bad.ok, false);
    assert.match(bad.error, /only \.dll files or folders/);
  });

  // ── setAllMods ────────────────────────────────────────────────────────
  t('"Enable all" reaches a mod nested inside a folder', () => {
    const nest = path.join(DISABLED, 'Nest');
    writeDll(nest, 'Nested.dll', 'nested');
    writeDll(nest, 'Sibling.dll', 'sibling');

    // Scoped to the child only - the folder itself is deliberately NOT named,
    // which is exactly the shape a profile holding one nested mod produces.
    const results = mods.setAllMods(ROOT, true, ['Nested']);
    assert.equal(results.length, 1, `expected one toggle, got ${JSON.stringify(results)}`);
    assert.equal(results[0].ok, true, results[0].error);
    assert.equal(fs.existsSync(path.join(PLUGINS, 'Nest', 'Nested.dll')), true,
      'the nested mod was never reached - this is the silent skip');
    assert.equal(fs.existsSync(path.join(DISABLED, 'Nest', 'Sibling.dll')), true,
      'an out-of-scope sibling was toggled');
  });

  t('a folder toggle carries its children and does not toggle them twice', () => {
    const folder = path.join(PLUGINS, 'Bundle');
    writeDll(folder, 'One.dll', '1');
    writeDll(path.join(folder, 'Deep'), 'Two.dll', '2');

    const results = mods.setAllMods(ROOT, false, ['Bundle']);
    assert.equal(results.length, 1, `expected the folder alone to move, got ${JSON.stringify(results)}`);
    assert.equal(fs.existsSync(path.join(DISABLED, 'Bundle', 'One.dll')), true);
    assert.equal(fs.existsSync(path.join(DISABLED, 'Bundle', 'Deep', 'Two.dll')), true);
    assert.equal(fs.existsSync(path.join(PLUGINS, 'Bundle')), false);
  });

  // ── the read-only premise behind FILE_READ_ONLY ───────────────────────
  t('a read-only file is detectable as one (what the EPERM split relies on)', () => {
    // wrapLockError tells "read-only attribute" apart from "Gorilla Tag has the
    // file open" by the owner-write bit, because on Windows both are EPERM.
    // If this ever stops holding, that message goes back to being wrong.
    const p = writeDll(path.join(ROOT, 'ro'), 'Locked.dll', 'ro');
    fs.chmodSync(p, 0o444);
    try {
      assert.equal((fs.statSync(p).mode & 0o200) === 0, true, 'read-only is not visible in stat().mode here');
    } finally {
      fs.chmodSync(p, 0o666);
    }
  });

  // ── containment: the guard on toggle / rename / move / delete ─────────
  //
  // resolveModRoots used to accept ANY path with an ancestor directory merely
  // NAMED "plugins" or "plugins_disabled", on any drive, because it never
  // consulted the configured game folder. It is the only guard on deleteMod,
  // which is fs.rmSync(recursive, force) - so a renderer asking to delete
  // C:\...\JetBrains\IntelliJIdea\plugins\x was obliged, and the comment above
  // deleteMod claimed the exact opposite.
  //
  // Driven through the REAL config file, because that is where the anchor comes
  // from. Backed up and restored.
  {
    const cfgPath = require('./config.cjs').getConfigPath();
    const hadCfg = fs.existsSync(cfgPath);
    const backup = hadCfg ? fs.readFileSync(cfgPath, 'utf8') : null;
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify({ gamePath: ROOT }), 'utf8');

      // A decoy that is laid out exactly like a game folder but is not ours.
      const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'excalibur-decoy-'));
      const decoyPlugins = path.join(decoy, 'BepInEx', 'plugins');
      const victim = writeDll(decoyPlugins, 'Victim.dll', 'important');
      try {
        t('a path under SOMEONE ELSE\'S plugins folder is refused', () => {
          assert.throws(() => mods.deleteMod(victim), /outside the managed Gorilla Tag folder/);
          assert.equal(fs.existsSync(victim), true, 'the file must still be there');
        });

        t('...and so is a folder merely NAMED plugins', () => {
          const fake = path.join(decoy, 'SomeApp', 'plugins');
          const f = writeDll(fake, 'NotAMod.dll', 'x');
          assert.throws(() => mods.deleteMod(f), /outside the managed Gorilla Tag folder|not inside plugins/);
          assert.equal(fs.existsSync(f), true);
        });

        t('a path inside the REAL managed folder still works', () => {
          const mine = writeDll(PLUGINS, 'Mine.dll', 'mine');
          const r = mods.deleteMod(mine);
          assert.equal(r.deleted, true);
          assert.equal(fs.existsSync(mine), false);
        });
      } finally {
        fs.rmSync(decoy, { recursive: true, force: true });
      }
    } finally {
      if (hadCfg) fs.writeFileSync(cfgPath, backup, 'utf8');
      else { try { fs.rmSync(cfgPath, { force: true }); } catch { /* ignore */ } }
    }
  }

  // ── Toggling a FOLDER mod that exists in both roots ───────────────────────
  //
  // A live install grew TWELVE `Wallpapers.backup-<epoch>` folders, one per
  // toggle, each holding the same three PNGs, all of them rendering in the mods
  // list as "Folder - 0 mods - 0 on". Two file-only assumptions in toggleMod's
  // collision handler, compounding:
  //
  //   * the identical-check called readFileSync() on the path. That throws
  //     EISDIR for a directory and the catch reported it as "different", so a
  //     folder mod was never deduped - not even byte-for-byte identical ones.
  //   * the prune called rmSync WITHOUT `recursive`, which also throws EISDIR,
  //     and a single try/catch wrapped the whole loop - so the first folder
  //     backup aborted pruning for every remaining one. The prune could never
  //     clear the only kind of backup this bug produces.
  //
  // One bug made the junk, the other guaranteed it accumulated forever.
  {
    console.log('\n-- folder mods colliding on toggle --');
    const cfgPath = require('./config.cjs').getConfigPath();
    const hadCfg = fs.existsSync(cfgPath);
    const backup = hadCfg ? fs.readFileSync(cfgPath, 'utf8') : null;
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify({ gamePath: ROOT }), 'utf8');

      const seed = (root, body) => {
        const d = path.join(root, 'Wallpapers');
        fs.mkdirSync(d, { recursive: true });
        for (const f of ['Calm.png', 'Default.png', 'Windows.png']) {
          fs.writeFileSync(path.join(d, f), body + f);
        }
        return d;
      };
      const junk = () => fs.readdirSync(DISABLED).filter((f) => f.startsWith('Wallpapers.backup-'));

      t('an IDENTICAL folder mod dedupes instead of piling up a backup per toggle', () => {
        seed(DISABLED, 'PNG-');
        // Ten enable/disable cycles: the folder returns to plugins/ each round
        // (re-enabled, or redeployed by an external tool) and is disabled again.
        for (let i = 0; i < 10; i++) {
          seed(PLUGINS, 'PNG-');
          mods.toggleMod(path.join(PLUGINS, 'Wallpapers'), false);
        }
        assert.deepEqual(junk(), [], 'identical folder mods must never leave a backup');
        assert.deepEqual(
          fs.readdirSync(path.join(DISABLED, 'Wallpapers')).sort(),
          ['Calm.png', 'Default.png', 'Windows.png'],
          'the surviving folder must keep its contents',
        );
      });

      t('a DIFFERING folder mod rotates its backups instead of hoarding them', () => {
        // This used to assert exactly ONE survivor, which is what the prune did
        // before 2026-08-01: it deleted every older backup unconditionally. That
        // is fine when they are duplicates and a data-loss bug when they are
        // not - on a real install one of them held the only remaining copy of a
        // user's own wallpaper, and the next differing toggle would have taken
        // it. Each iteration here seeds DIFFERENT content, so every backup holds
        // something found nowhere else and none of them is safe to delete on
        // redundancy grounds.
        //
        // They still cannot accumulate forever, so unique backups rotate at
        // MAX_UNIQUE_BACKUPS. Five differing toggles therefore leave three, not
        // one and not five.
        for (let i = 0; i < 5; i++) {
          seed(PLUGINS, `CHANGED${i}-`);
          mods.toggleMod(path.join(PLUGINS, 'Wallpapers'), false);
        }
        assert.equal(junk().length, 3, 'unique content rotates at the cap rather than being destroyed');
      });

      t('a differing folder mod backup holds the REPLACED content, not the new', () => {
        fs.rmSync(path.join(DISABLED, 'Wallpapers'), { recursive: true, force: true });
        for (const f of junk()) fs.rmSync(path.join(DISABLED, f), { recursive: true, force: true });
        seed(DISABLED, 'OLD-');
        seed(PLUGINS, 'NEW-');
        mods.toggleMod(path.join(PLUGINS, 'Wallpapers'), false);
        const kept = junk();
        assert.equal(kept.length, 1);
        assert.equal(fs.readFileSync(path.join(DISABLED, kept[0], 'Calm.png'), 'utf8'), 'OLD-Calm.png');
        assert.equal(fs.readFileSync(path.join(DISABLED, 'Wallpapers', 'Calm.png'), 'utf8'), 'NEW-Calm.png');
      });
    } finally {
      if (hadCfg) fs.writeFileSync(cfgPath, backup, 'utf8');
      else { try { fs.rmSync(cfgPath, { force: true }); } catch { /* ignore */ } }
    }
  }

  console.log(`\nmods filesystem: ${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}
