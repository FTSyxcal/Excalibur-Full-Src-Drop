// The per-profile mod ARCHIVE.
//
// "Remove from Standard" / "Remove from this profile" file a mod into that
// profile's `removedBaseNames` instead of dropping it on the floor. The archive
// view (src/components/mods-page/ModArchiveModal.jsx) reads it back and offers
// Restore / Delete forever.
//
// The invariants below are the ones that make it trustworthy, and most of them
// are load-bearing for reasons that are NOT obvious from the UI:
//
//   * "member" and "archived" are mutually exclusive, which is the ONLY thing
//     implementing Restore - re-adding a mod as a member is what clears its
//     archive row. If that stopped holding, a restored mod would sit in the
//     archive and the profile at the same time and Restore would appear to do
//     nothing.
//   * archives are per-profile and never see each other. This is the whole
//     feature request; a leak here means archiving in one modpack empties a mod
//     out of another.
//   * a permanent delete and a rename must reach EVERY profile's archive, or
//     they leave rows naming a file that no longer exists - rows whose Restore
//     button cannot work, and which the launch-time prune then silently deletes.
//
// Like profiles-storage.test.cjs (and unlike profiles.test.mjs, which mirrors
// the logic), this loads the REAL module and touches the REAL file. Outside
// Electron the base dir resolves to <tmp>/excalibur, so this is safe - but it
// still backs up and restores anything it finds there.
//
// Run: node electron/profiles-archive.test.cjs

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const { getWritableBaseDir } = require('./logger.cjs');
const profiles = require('./profiles.cjs');

const FILE = path.join(getWritableBaseDir(), 'profiles.json');
const BACKUP = `${FILE}.archivetestbackup-${process.pid}`;

let pass = 0;
const t = (label, fn) => {
  try { fn(); pass++; console.log(`  PASS  ${label}`); }
  catch (e) { console.error(`  FAIL  ${label}\n        ${e.message}`); process.exitCode = 1; }
};

const key = (s) => String(s || '').replace(/\.dll$/i, '').toLowerCase();
const byId = (list, id) => list.find((p) => p.id === id);

// A fixture where Bark lives in BOTH Standard and modpack "1", and Utilla only
// in Standard. Rebuilt before each test so nothing leaks between them.
function seed() {
  return profiles.replaceAll([
    {
      id: 'standard', isStandard: true, name: 'Standard Profile', kind: 'snapshot',
      modBaseNames: ['Bark', 'Utilla'], removedBaseNames: [], disabledBaseNames: [],
    },
    {
      id: 'p1', name: '1', kind: 'snapshot',
      modBaseNames: ['Bark', 'GoatCam'], removedBaseNames: [],
    },
    {
      id: 'p2', name: '2', kind: 'snapshot',
      modBaseNames: ['Bark'], removedBaseNames: [],
    },
  ]);
}

// What the renderer writes when you press Remove (ProfilesView
// handleRemoveFromProfile / App handleRemoveFromStandard): drop the member, add
// the archive entry, stamp the date.
function archive(profileId, baseName) {
  const cur = byId(profiles.listProfiles(), profileId);
  const k = key(baseName);
  return profiles.saveProfile({
    ...cur,
    modBaseNames: (cur.modBaseNames || []).filter((b) => key(b) !== k),
    removedBaseNames: [...(cur.removedBaseNames || []), String(baseName).replace(/\.dll$/i, '')],
    archivedAt: { ...(cur.archivedAt || {}), [k]: 1750000000000 },
  });
}

if (fs.existsSync(FILE)) fs.renameSync(FILE, BACKUP);

try {
  console.log('\n=== the per-profile mod archive ===');

  t('archiving drops the member and files it, with a date', () => {
    seed();
    const list = archive('p1', 'Bark');
    const p1 = byId(list, 'p1');
    assert.deepEqual(p1.modBaseNames, ['GoatCam'], 'Bark should no longer be a member');
    assert.deepEqual(p1.removedBaseNames, ['Bark'], 'Bark should be archived');
    assert.equal(p1.archivedAt.bark, 1750000000000, 'the archive date should survive the save');
  });

  t('...and touches NO other profile', () => {
    seed();
    const list = archive('p1', 'Bark');
    // The whole point of the feature: 1's archive is 1's business.
    assert.deepEqual(byId(list, 'standard').modBaseNames, ['Bark', 'Utilla']);
    assert.deepEqual(byId(list, 'standard').removedBaseNames, []);
    assert.deepEqual(byId(list, 'p2').modBaseNames, ['Bark']);
    assert.deepEqual(byId(list, 'p2').removedBaseNames || [], []);
  });

  t('Standard and a modpack keep SEPARATE archives for the same mod', () => {
    seed();
    archive('p1', 'Bark');
    const list = archive('standard', 'Bark');
    assert.deepEqual(byId(list, 'standard').removedBaseNames, ['Bark']);
    assert.deepEqual(byId(list, 'p1').removedBaseNames, ['Bark']);
    // ...and p2 still has it live, because nobody archived it there.
    assert.deepEqual(byId(list, 'p2').modBaseNames, ['Bark']);
    assert.deepEqual(byId(list, 'p2').removedBaseNames || [], []);
  });

  t('RESTORE: re-adding as a member clears the archive row', () => {
    seed();
    archive('p1', 'Bark');
    const cur = byId(profiles.listProfiles(), 'p1');
    // Restore writes membership ONLY - normalizeProfile does the rest. This is
    // the assertion that Restore is implemented at all.
    const list = profiles.saveProfile({ ...cur, modBaseNames: [...cur.modBaseNames, 'Bark'] });
    const p1 = byId(list, 'p1');
    assert.deepEqual(p1.removedBaseNames, [], 'restoring must empty the archive row');
    assert.ok(p1.modBaseNames.some((b) => key(b) === 'bark'), 'Bark should be a member again');
    assert.ok(!p1.archivedAt || !('bark' in p1.archivedAt), 'the stale date must go too');
  });

  t('a mod can never be a member AND archived at once', () => {
    seed();
    const list = profiles.saveProfile({
      ...byId(profiles.listProfiles(), 'p1'),
      modBaseNames: ['Bark'],
      removedBaseNames: ['bark.dll'],   // same mod, different shape
    });
    assert.deepEqual(byId(list, 'p1').removedBaseNames, [], 'membership wins');
  });

  t('a re-archived mod gets the NEW date, not the old one', () => {
    seed();
    archive('p1', 'Bark');
    const restored = byId(profiles.listProfiles(), 'p1');
    profiles.saveProfile({ ...restored, modBaseNames: [...restored.modBaseNames, 'Bark'] });
    const cur = byId(profiles.listProfiles(), 'p1');
    const list = profiles.saveProfile({
      ...cur,
      modBaseNames: cur.modBaseNames.filter((b) => key(b) !== 'bark'),
      removedBaseNames: ['Bark'],
      archivedAt: { bark: 1760000000000 },
    });
    assert.equal(byId(list, 'p1').archivedAt.bark, 1760000000000);
  });

  t('DELETE FOREVER clears the mod from EVERY profile archive', () => {
    seed();
    archive('p1', 'Bark');
    archive('standard', 'Bark');
    // What handleDeleteMod calls once the file is gone. An archive row for a
    // deleted file is a Restore button with nothing to restore.
    const list = profiles.removeModFromAllProfiles('Bark');
    for (const id of ['standard', 'p1', 'p2']) {
      const p = byId(list, id);
      assert.deepEqual(p.removedBaseNames || [], [], `${id} still archives a deleted file`);
      assert.ok(!(p.modBaseNames || []).some((b) => key(b) === 'bark'), `${id} still lists a deleted file`);
      assert.ok(!p.archivedAt || !('bark' in p.archivedAt), `${id} kept a stale archive date`);
    }
    // Untouched neighbours survive.
    assert.deepEqual(byId(list, 'standard').modBaseNames, ['Utilla']);
    assert.deepEqual(byId(list, 'p1').modBaseNames, ['GoatCam']);
  });

  t('RENAME follows the mod into every profile archive', () => {
    seed();
    archive('p1', 'Bark');
    archive('standard', 'Bark');
    // Without this, the archive rows still name Bark, the file is now
    // BarkHD.dll, and the launch-time prune deletes both rows as "no longer
    // installed" - renaming a mod would quietly empty it out of every archive.
    const list = profiles.renameModInAllProfiles('Bark', 'BarkHD');
    assert.deepEqual(byId(list, 'p1').removedBaseNames, ['BarkHD']);
    assert.deepEqual(byId(list, 'standard').removedBaseNames, ['BarkHD']);
    assert.equal(byId(list, 'p1').archivedAt.barkhd, 1750000000000, 'the date should move with the name');
    assert.ok(!('bark' in byId(list, 'p1').archivedAt), 'the old key must not linger');
    // p2 had it as a live member, so the rename lands there as membership.
    assert.deepEqual(byId(list, 'p2').modBaseNames, ['BarkHD']);
  });

  t('archiving the same mod twice does not duplicate the row', () => {
    seed();
    archive('p1', 'Bark');
    const cur = byId(profiles.listProfiles(), 'p1');
    // Appended blindly, and in the OTHER shape, which is how duplicate
    // membership entries used to get in. The archive view renders one row per
    // entry keyed by name, so a duplicate is two identical rows under one React
    // key - restoring one would leave the other sitting there.
    const list = profiles.saveProfile({ ...cur, removedBaseNames: [...cur.removedBaseNames, 'Bark.dll'] });
    const rows = byId(list, 'p1').removedBaseNames.filter((b) => key(b) === 'bark');
    assert.equal(rows.length, 1, 'the archive must hold one row per mod');
  });

  t('a blank archive entry is dropped rather than rendered as an empty row', () => {
    seed();
    const list = profiles.saveProfile({
      ...byId(profiles.listProfiles(), 'p1'),
      removedBaseNames: ['   ', 'GoatCamOld'],
    });
    assert.deepEqual(byId(list, 'p1').removedBaseNames, ['GoatCamOld']);
  });

  console.log(`\nprofiles archive: ${pass} passed`);
} finally {
  try { fs.rmSync(FILE, { force: true }); } catch { /* ignore */ }
  if (fs.existsSync(BACKUP)) fs.renameSync(BACKUP, FILE);
}
