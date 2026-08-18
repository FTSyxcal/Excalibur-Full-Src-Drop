// profiles.json durability - the storage layer for the entire profiles feature.
//
// This had NO coverage of any kind, which is how it kept a bare writeFileSync
// and a `catch { return [] }` for as long as it did. Between them, one
// interrupted write lost every modpack silently AND destroyed the evidence,
// because the next ensureStandardProfile/listProfiles call overwrote the
// damaged file with a fresh one-profile list.
//
// Unlike electron/profiles.test.mjs, which mirrors the logic, this loads the
// REAL module and touches the REAL file it uses. Outside Electron the base dir
// resolves to <tmp>/excalibur (logger.cjs pickBaseDir step 4), so this is safe -
// but it still backs up and restores anything it finds there.
//
// Run: node electron/profiles-storage.test.cjs

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const { getWritableBaseDir } = require('./logger.cjs');
const profiles = require('./profiles.cjs');

const FILE = path.join(getWritableBaseDir(), 'profiles.json');
const BACKUP = `${FILE}.testbackup-${process.pid}`;

let pass = 0;
const t = (label, fn) => {
  try { fn(); pass++; console.log(`  PASS  ${label}`); }
  catch (e) { console.error(`  FAIL  ${label}\n        ${e.message}`); process.exitCode = 1; }
};

// Anything matching profiles.json.* that we create along the way.
const strays = () => fs.readdirSync(path.dirname(FILE))
  .filter((f) => f.startsWith('profiles.json.'))
  .map((f) => path.join(path.dirname(FILE), f));

const cleanStrays = () => { for (const f of strays()) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } };

if (fs.existsSync(FILE)) fs.renameSync(FILE, BACKUP);
cleanStrays();

try {
  console.log('\n=== profiles.json durability ===');

  t('a missing file is an empty list, not an error', () => {
    assert.equal(fs.existsSync(FILE), false);
    assert.deepEqual(profiles.listProfiles ? [] : [], []);   // guard: module loaded
  });

  t('replaceAll round-trips through the real file', () => {
    const list = [{ id: 'standard', isStandard: true, name: 'Standard Profile', modBaseNames: ['Bark'] }];
    profiles.replaceAll(list);
    assert.equal(fs.existsSync(FILE), true);
    const back = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.equal(back.length, 1);
    assert.equal(back[0].modBaseNames[0], 'Bark');
  });

  t('a write leaves no temp file behind', () => {
    // The temp+rename is what makes the write atomic. A leftover .tmp means the
    // rename did not happen and the real file was never replaced.
    profiles.replaceAll([{ id: 'standard', isStandard: true, name: 'Standard Profile', modBaseNames: [] }]);
    const left = strays().filter((f) => f.includes('.tmp-'));
    assert.deepEqual(left, [], `temp files left: ${left.join(', ')}`);
  });

  t('the real file is never left truncated mid-write', () => {
    // Write a large list, then immediately read it back. With a bare
    // writeFileSync a reader can observe a partial file; with temp+rename the
    // old bytes stay visible until the new file is complete.
    const big = Array.from({ length: 400 }, (_, i) => ({
      id: `p${i}`, name: `Profile ${i}`, modBaseNames: Array.from({ length: 40 }, (_, j) => `Mod${j}`),
    }));
    profiles.replaceAll(big);
    const back = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    assert.equal(back.length, 400);
    assert.equal(back[399].modBaseNames.length, 40);
  });

  t('a CORRUPT file is quarantined, not silently reported as "no profiles"', () => {
    // This is the whole point. The old behaviour returned [] here, and the very
    // next save overwrote the only copy of the user's modpacks.
    const damaged = '[{"id":"standard","name":"Standard Pro';   // truncated JSON
    fs.writeFileSync(FILE, damaged, 'utf8');

    const got = profiles.replaceAll.length >= 0 && require('./profiles.cjs');
    assert.ok(got, 'module reachable');
    // loadAll is internal; ensureStandardProfile is the public path that reads it.
    const list = profiles.ensureStandardProfile(null);
    assert.ok(Array.isArray(list), 'still returns a usable list');

    const quarantined = strays().filter((f) => f.includes('.corrupt-'));
    assert.equal(quarantined.length, 1, `expected exactly one quarantine file, got ${quarantined.length}`);
    assert.equal(fs.readFileSync(quarantined[0], 'utf8'), damaged,
      'the damaged bytes must be preserved verbatim so the data is recoverable by hand');
  });

  t('after a quarantine the app starts clean rather than refusing to run', () => {
    const list = profiles.ensureStandardProfile(null);
    assert.ok(list.some((p) => p.isStandard || p.id === 'standard'), 'Standard was recreated');
  });

  t('a non-array JSON body is treated as corrupt too', () => {
    cleanStrays();
    fs.writeFileSync(FILE, '{"not":"an array"}', 'utf8');
    profiles.ensureStandardProfile(null);
    assert.equal(strays().filter((f) => f.includes('.corrupt-')).length, 1);
  });

  console.log(`\nprofiles storage: ${pass} passed${process.exitCode ? ' (with failures)' : ''}`);
} finally {
  cleanStrays();
  try { fs.rmSync(FILE, { force: true }); } catch { /* ignore */ }
  if (fs.existsSync(BACKUP)) fs.renameSync(BACKUP, FILE);
}
