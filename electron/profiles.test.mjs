// Run: node electron/profiles.test.mjs
//
// The profile system's promise is one sentence: what the profile page lists is
// what Gorilla Tag loads. These tests pin the three things that broke it on a
// real install, so they cannot come back quietly.
//
// Pure functions only - no fs, no Electron. The key functions are re-declared
// here from their sources and checked against those sources by
// scripts/verify-profiles.mjs, so a drifting copy fails the build rather than
// passing a test that no longer describes the code.

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got  ${g}\n          want ${w}`); }
};
const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

// ── The two keys that must never disagree ────────────────────────────────
// matchKey    electron/profiles.cjs   - decides what the GAME loads
// modKey      ProfilesView.jsx        - decides what the PAGE says is installed
const matchKey = (s) => String(s || '').replace(/\.dll$/i, '').toLowerCase();
const modKey   = (s) => String(s || '').replace(/\.dll$/i, '').toLowerCase();
// normRegName decides the NAME/AUTHOR/VERSION a row displays.
const normRegName = (s) => String(s || '').toLowerCase().replace(/\.dll$/i, '').replace(/[^a-z0-9]/g, '');

console.log('\n-- The page and the game must agree on identity ---------------');
for (const n of ['Bark', 'Bark.dll', 'BARK.DLL', 'Bingus Nametags++', 'Bark (1)', 'Bark (1).dll', '', 'Mod.dll.dll']) {
  eq(`same key for ${JSON.stringify(n)}`, modKey(n), matchKey(n));
}

console.log('\n-- A browser copy is NOT the original --------------------------');
// The whole reported bug in one assertion. "Bark (1)" is a different file from
// "Bark"; every layer has to say so, or the page claims one thing and the
// launch does another.
ok('disk match keeps them apart',      modKey('Bark (1)') !== modKey('Bark'));
ok('the game keeps them apart',        matchKey('Bark (1)') !== matchKey('Bark'));
ok('the registry keeps them apart too', normRegName('Bark (1)') !== normRegName('Bark'));
// ...but punctuation still must not split a real mod from its registry entry.
eq('punctuation still normalises',     normRegName('Bingus Nametags++.dll'), normRegName('BingusNametags++'));
eq('.dll still normalises',            normRegName('Utilla.dll'), normRegName('Utilla'));

console.log('\n-- Membership invariants ---------------------------------------');
// Mirrors pruneArchivedAt in electron/profiles.cjs (normalizeProfile calls it).
function pruneArchivedAt(p) {
  if (!p || !p.archivedAt || typeof p.archivedAt !== 'object') return null;
  const live = new Set((p.removedBaseNames || []).map(matchKey));
  const next = {};
  let kept = 0;
  for (const [k, ts] of Object.entries(p.archivedAt)) {
    if (!live.has(matchKey(k))) continue;
    next[matchKey(k)] = ts;
    kept++;
  }
  return kept ? next : null;
}

// Mirrors normalizeProfile in electron/profiles.cjs.
function normalizeProfile(p) {
  if (!p || !Array.isArray(p.modBaseNames)) return p;
  const seen = new Set();
  const members = [];
  for (const b of p.modBaseNames) {
    // Trimmed for the EMPTINESS test only, not for the key itself: a
    // whitespace-only entry can never match a file and would render as a blank
    // row with a Remove button, but changing the key here would make it differ
    // from the renderer's modKey, which is the drift this whole file guards.
    const k = matchKey(b);
    if (!k.trim() || seen.has(k)) continue;
    seen.add(k);
    members.push(b);
  }
  p.modBaseNames = members;
  if (Array.isArray(p.removedBaseNames)) {
    // This is also what makes Restore work with no special case: putting a mod
    // back into modBaseNames drops it out of the archive automatically, because
    // "member" and "archived" are mutually exclusive by construction.
    //
    // Deduped for the same reason members are. Two callers append to this list
    // and both check first, but "both callers remember to check" is exactly the
    // arrangement that put LaggyGround in Standard's members AND its exclusions
    // at once. A duplicate here is worse than untidy: the archive view renders
    // one row per entry keyed by name, so it would paint two identical rows
    // under the same React key, and restoring one would leave the other behind.
    const archived = new Set();
    p.removedBaseNames = p.removedBaseNames.filter((b) => {
      const k = matchKey(b);
      if (!k.trim() || seen.has(k) || archived.has(k)) return false;
      archived.add(k);
      return true;
    });
  }
  if (Array.isArray(p.disabledBaseNames)) {
    p.disabledBaseNames = p.disabledBaseNames.filter((b) => seen.has(matchKey(b)));
  }
  // archivedAt only annotates entries that are actually archived. Pruned here so
  // a restore-then-archive cycle cannot resurrect the ORIGINAL timestamp and
  // show "archived 3 weeks ago" for something archived a second ago.
  p.archivedAt = pruneArchivedAt(p);
  if (!p.archivedAt) delete p.archivedAt;
  return p;
}

// The exact contradiction found in the real profiles.json: LaggyGround was a
// member of Standard AND on its removed list, so the profile both included it
// and deliberately excluded it.
eq('a member cannot also be excluded',
   normalizeProfile({ modBaseNames: ['LaggyGround', 'Bark'], removedBaseNames: ['LaggyGround'] }).removedBaseNames,
   []);
eq('...and a genuine exclusion survives',
   normalizeProfile({ modBaseNames: ['Bark'], removedBaseNames: ['LaggyGround'] }).removedBaseNames,
   ['LaggyGround']);
eq('a switched-off record for a non-member is dropped',
   normalizeProfile({ modBaseNames: ['Bark'], disabledBaseNames: ['GoatCamMod'] }).disabledBaseNames,
   []);
eq('...and one for a real member is kept',
   normalizeProfile({ modBaseNames: ['Bark'], disabledBaseNames: ['Bark.dll'] }).disabledBaseNames,
   ['Bark.dll']);
eq('duplicate members differing only by .dll collapse',
   normalizeProfile({ modBaseNames: ['Bark', 'Bark.dll', 'BARK'] }).modBaseNames,
   ['Bark']);
eq('empty names are dropped',
   normalizeProfile({ modBaseNames: ['', '  ', 'Bark'] }).modBaseNames.length, 1);

console.log('\n-- Profile names are distinguishable ---------------------------');
// Mirrors uniqueName in electron/profiles.cjs. The real install had THREE
// profiles called "test", which is most of why the same mod looked installed on
// one page and missing on another: they were different profiles, same label.
function uniqueName(list, wanted, selfId) {
  const base = String(wanted || '').trim() || 'Untitled';
  const taken = new Set(list.filter((p) => p.id !== selfId).map((p) => String(p.name || '').trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  const stem = base.replace(/\s*\((\d+)\)\s*$/, '').trim() || 'Untitled';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})`;
}
const three = [{ id: 'a', name: 'test' }, { id: 'b', name: 'test (2)' }, { id: 'c', name: 'other' }];
eq('a free name is left alone',        uniqueName(three, 'fresh', null), 'fresh');
eq('a taken name gets numbered',       uniqueName(three, 'other', null), 'other (2)');
eq('...skipping numbers already used', uniqueName(three, 'test', null), 'test (3)');
eq('case counts as taken',             uniqueName(three, 'TEST', null), 'TEST (3)');
eq('renaming to your own name is fine', uniqueName(three, 'test', 'a'), 'test');
eq('counters do not stack',            uniqueName(three, 'test (2)', null), 'test (3)');
eq('an empty name still gets one',     uniqueName(three, '   ', null), 'Untitled');

console.log('\n-- What actually loads -----------------------------------------');
// Mirrors the desired-set logic in applyProfile.
function wouldLoad(profile, onDisk) {
  const desired = new Set((profile.modBaseNames || []).map(matchKey));
  for (const b of profile.disabledBaseNames || []) desired.delete(matchKey(b));
  return onDisk.filter((f) => desired.has(matchKey(f))).sort();
}
const disk = ['Bark.dll', 'GoatCamMod.dll', 'GorillaTagDesktopController.dll', 'Utilla.dll'];
eq('members load, everything else is switched off',
   wouldLoad({ modBaseNames: ['Bark', 'Utilla'] }, disk), ['Bark.dll', 'Utilla.dll']);
eq('a switched-off member does not load',
   wouldLoad({ modBaseNames: ['Bark', 'Utilla'], disabledBaseNames: ['Utilla'] }, disk), ['Bark.dll']);
eq('a member with no file on disk simply does not appear',
   wouldLoad({ modBaseNames: ['Bark', 'HoneyLib'] }, disk), ['Bark.dll']);
// The live failure: the active profile listed one mod and three were loading,
// because nothing reconciled the folder between switching profiles and Play.
eq('a copy-suffixed member does NOT quietly load the original',
   wouldLoad({ modBaseNames: ['Bark (1)'] }, disk), []);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
