// Profiles: named sets of enabled mods. Two flavors:
//   * snapshot (default) - just a list of mod baseNames that should be
//     enabled when the profile is applied.
//   * pack - additionally carries a `packDir` pointing at a staged copy of
//     a .gtmp pack. Applying a pack profile first copies any missing mods
//     from packDir into plugins/, then runs the same enable/disable logic.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getWritableBaseDir, logError, logInfo } = require('./logger.cjs');
const { scanMods, toggleMod, getPluginsDir, isManagerEntry } = require('./mods.cjs');
const { sweepCore } = require('./mod-payload.cjs');

function getProfilesPath() {
  return path.join(getWritableBaseDir(), 'profiles.json');
}

// The permanent "Standard Profile" is the user's universal/main mod set. It's a
// real profile (so it shares all the profile machinery) but flagged isStandard,
// seeded with every installed mod, and never deletable.
const STANDARD_ID = 'standard';

// Normalize a mod key so folder mods and loose DLLs compare consistently: the
// scanner gives a loose DLL the baseName "Mod.dll" but a folder just "Mod".
// Membership lists + enable/disable matching all go through this.
function normBase(name) {
  return String(name || '').replace(/\.dll$/i, '');
}

// Comparison key for membership. Separate from normBase because normBase is
// also used to build the values we STORE, and lowercasing stored names would
// rewrite user data. Matching, though, must be case-insensitive: the renderer
// (modKey in ProfilesView) already compares this way, and a case difference
// between a stored entry and the file on disk otherwise produces duplicate
// entries or a mod that silently vanishes from a list.
function matchKey(name) {
  return normBase(name).toLowerCase();
}

// Reading and writing profiles.json is the storage layer for the entire feature,
// and it used to have no durability story at all:
//
//   * saveAll was a bare writeFileSync. A crash, a power loss or ENOSPC
//     part-way through left a truncated file.
//   * loadAll mapped a JSON.parse failure to [] - "damaged" and "you have no
//     profiles yet" were indistinguishable, and nothing was even logged.
//   * the next ensureStandardProfile/listProfiles call then OVERWROTE the
//     damaged file with a fresh one-profile list.
//
// So a single interrupted write lost every modpack silently AND destroyed the
// evidence. Write to a temp file and rename (atomic on both NTFS and POSIX), and
// on a parse failure keep the bytes and refuse to pretend.
function loadAll() {
  const p = getProfilesPath();
  if (!fs.existsSync(p)) return [];

  // A parse failure is not proof the FILE is bad: a read racing another
  // process's atomic save (cloud sync, a second window, a test harness)
  // returns torn bytes while the file on disk is fine. Quarantining on the
  // first torn read threw away 27 perfectly healthy files in one sitting on
  // 2026-08-01 and left the app with zero profiles, which surfaced as a
  // "Profile not found" toast on every save. Only a file that fails on
  // several consecutive fresh reads is treated as genuinely damaged.
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      logError(`profiles: could not read ${p}: ${e.message}`);
      throw e;   // do NOT report "no profiles" for an unreadable file
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      lastError = e.message;
    }
    if (parsed !== null) {
      if (!Array.isArray(parsed)) {
        lastError = 'profiles.json is not an array';
      } else {
        // The migration runs OUTSIDE the parse try/catch on purpose. On
        // 2026-08-01 a half-edited module (call present, function missing)
        // made this line throw ReferenceError inside the old combined catch,
        // which read as "file corrupt" and quarantined a healthy store on
        // every load - the app saw zero profiles and every save toasted
        // "Profile not found". A CODE failure must never condemn the FILE:
        // serve the unmigrated list instead.
        try { return migrateNametagVisibility(parsed); }
        catch (e) {
          logError(`profiles: nametag migration failed, serving unmigrated list: ${e.message}`);
          return parsed;
        }
      }
    }
    // Give a concurrent rename a moment to land before the fresh read.
    // Synchronous on purpose - every caller of loadAll is synchronous.
    const until = Date.now() + 40;
    while (Date.now() < until) { /* spin - 40ms, worst case twice */ }
  }
  logError(`profiles: profiles.json is corrupt after retries (${lastError})`);

  // Preserve the damaged bytes under a dated name so the data is recoverable by
  // hand, then let the caller start clean. Without this the very next save
  // silently overwrote the only copy.
  try {
    const quarantine = `${p}.corrupt-${Date.now()}`;
    fs.renameSync(p, quarantine);
    logError(`profiles: quarantined the corrupt file at ${quarantine}`);
  } catch (e) {
    logError(`profiles: could not quarantine the corrupt file: ${e.message}`);
  }
  return [];
}

// One-time nametag-visibility migration at the PROFILE layer. The config
// loader's 2026-07-27 excalibur→party flip only reaches the top-level mirror;
// profile blocks seeded from the OLD default kept re-mirroring flagless
// 'excalibur' and fought it forever (the mod flipped to party while the panel
// showed "Excalibur only"). Same rule as config.cjs: a flagless 'excalibur' is
// the old default, not a choice; every block written since carries
// visMigratedToParty and is left alone.
//
// Applied in BOTH entry points that bring a profile list into this process:
// loadAll (every local read) and replaceAll (Cloud Sync applying a reconciled
// set wholesale). A cloud-restored old profile never passes through loadAll,
// and without the replaceAll call it would mirror flagless 'excalibur' back
// out to config.json on the next flatten. Mutates in place, returns the list.
function migrateNametagVisibility(list) {
  for (const prof of list) {
    const nt = prof && prof.featureConfig && prof.featureConfig.nametags;
    if (nt && nt.visibility === 'excalibur' && !nt.visMigratedToParty) {
      nt.visibility = 'party';
      nt.visMigratedToParty = true;
    }
  }
  return list;
}

function saveAll(list) {
  const p = getProfilesPath();
  const tmp = `${p}.tmp-${process.pid}`;
  const json = JSON.stringify(list, null, 2);
  // fsync before the rename: a rename is atomic, but on a crash the OS can land
  // the rename before the temp file's own contents, which swaps the good file
  // for an empty one.
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, json, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* not fatal on filesystems without it */ }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  fs.renameSync(tmp, p);   // atomic replace
}

// Wholesale replace of the local profile set. Used by Cloud Sync to apply a
// reconciled set from the cloud in one write (saveProfile can't INSERT a
// profile that carries an id — it throws 'Profile not found'). Returns the
// written list.
function replaceAll(list) {
  // Migrated here too, not just in loadAll: this is the cloud-restore door,
  // and an old profile walking through it has never seen the local loader.
  // Same rule as loadAll: a migration CODE failure must never cost data -
  // fall back to writing the list unmigrated.
  let clean = Array.isArray(list) ? list : [];
  try { clean = migrateNametagVisibility(clean); }
  catch (e) { logError(`profiles: nametag migration failed in replaceAll, saving unmigrated: ${e.message}`); }

  // NORMALISE, exactly as saveProfile does on every other write path.
  // normalizeProfile is what resolves the contradictions a profile can hold -
  // and this is the CLOUD RESTORE door, so the profiles arriving here came from
  // another machine, possibly an older build, and have never been through the
  // local writer. Skipping it meant a restore could install states that no
  // locally-created profile can reach, which then behave oddly forever.
  // Per-profile try/catch for the same reason the migration has one: a bad row
  // must cost that row's tidy-up, never the whole restore.
  clean = clean.map((p) => {
    try { return normalizeProfile(p); }
    catch (e) {
      logError(`profiles: normalize failed in replaceAll for "${p?.name || p?.id || '?'}": ${e.message}`);
      return p;
    }
  });

  saveAll(clean);
  return clean;
}

// Strip Excalibur's own entries (excalibur-camera*, the manager/patcher/core
// artifacts) out of every profile's modBaseNames. These got absorbed into
// profiles back when the camera screenshot folder lived in plugins/; they're not
// community mods and must never show in the mod list. Persists if anything
// changed. Returns the cleaned list.
function stripManagerEntries(list) {
  let changed = false;
  for (const p of list) {
    if (!Array.isArray(p.modBaseNames)) continue;
    const next = p.modBaseNames.filter((b) => !isManagerEntry(b) && !isManagerEntry(normBase(b)));
    if (next.length !== p.modBaseNames.length) {
      p.modBaseNames = next;
      p.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) saveAll(list);
  return list;
}

// One-time migration (2026-08-02): fly binds return to Q/E climb+dive, Z/C
// roll, Shift boost. They were moved to Space/Shift on 08-01 and briefly to R
// on 08-02; the owner flew both and rejected both, and Space has to stay clear
// anyway because a loaded replay owns it for play/pause.
//
// config.cjs migrates config.json, but that is NOT enough: every launch the
// renderer re-mirrors the ACTIVE PROFILE's featureConfig.camera into
// cameraConfig (buildFeatureConfigPatch in App.jsx), so a profile still
// carrying an old default silently stomps the migrated config right back.
// Same rule as config.cjs: all four values together = a default nobody chose;
// the flag lets a deliberate rebind to those keys stick.
const PRIOR_BIND_DEFAULTS = [
  { upKey: 'Space', downKey: 'LeftShift', rollLeftKey: 'Q', rollRightKey: 'E' },
  { upKey: 'R',     downKey: 'LeftShift', rollLeftKey: 'Q', rollRightKey: 'E' },
];
function migrateCameraBinds(list) {
  let changed = false;
  for (const p of list) {
    const cam = p && p.featureConfig && p.featureConfig.camera;
    if (!cam || cam.bindsMigratedQEZC) continue;
    const wasPriorDefault = PRIOR_BIND_DEFAULTS.some((d) =>
      cam.upKey === d.upKey && cam.downKey === d.downKey
      && cam.rollLeftKey === d.rollLeftKey && cam.rollRightKey === d.rollRightKey);
    if (wasPriorDefault) {
      cam.upKey = 'Q'; cam.downKey = 'E';
      cam.rollLeftKey = 'Z'; cam.rollRightKey = 'C';
      cam.bindsMigratedQEZC = true;
      p.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) saveAll(list);
  return list;
}

function listProfiles() {
  return migrateCameraBinds(stripManagerEntries(loadAll()));
}

// A name nobody else is already using.
//
// Profile names were never checked, so "New profile" three times produced three
// profiles called the same thing, told apart by nothing the UI shows. A real
// install had THREE called "test" with different contents, which is most of why
// the same mod looked installed on one profile page and missing on another:
// they were different profiles wearing the same label.
//
// Numbers the duplicate rather than refusing the save, because this runs on a
// rename too and refusing mid-edit loses what the user typed.
function uniqueName(list, wanted, selfId) {
  const base = String(wanted || '').trim() || 'Untitled';
  const taken = new Set(
    list.filter((p) => p.id !== selfId).map((p) => String(p.name || '').trim().toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  // Strip an existing counter first so renaming "test (2)" does not climb to
  // "test (2) (2)".
  const stem = base.replace(/\s*\((\d+)\)\s*$/, '').trim() || 'Untitled';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})`;
}

// Membership invariants, enforced HERE rather than at each call site.
//
// Five different call sites in the renderer write membership, and each one had
// to remember the same rules. One of them did not, and a real install ended up
// with LaggyGround listed as a member of Standard AND in its removedBaseNames
// at the same time - simultaneously "in this profile" and "deliberately kept
// out of it". Rules:
//   * a name cannot be both a member and an exclusion (membership wins: it is
//     the newer, more explicit statement)
//   * a switched-off record only means something for a name that IS a member
//   * no duplicate members that differ only by case or a .dll suffix
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

// ── The archive ────────────────────────────────────────────────────────────
// `removedBaseNames` IS the archive, and it is per-profile: Standard's archive
// and each modpack's archive are separate lists that never see each other. It
// already existed on Standard (as the record that stopped ensureStandardProfile
// re-adopting a removed mod on the next launch); custom profiles now carry the
// same field for the same reason, plus a browsable UI.
//
// Deliberately NOT a physical move. A mod is ONE file shared by every profile,
// so a mod archived in modpack "1" while Standard still uses it cannot go
// anywhere - the file has to stay where it is. Moving it only in the
// archived-everywhere case would make one button behave two different ways, so
// the archive is a saved list and the file is switched off (see the renderer's
// handleRemoveFromStandard) when no profile lists it any more.
//
// `archivedAt` is a side map of matchKey -> epoch ms, kept separate rather than
// turning removedBaseNames into objects: that array is read by the renderer, by
// cloud sync and by three functions in this file, and every one of them assumes
// strings. A parallel map is additive and old profiles simply have no dates.
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

function saveProfile(profile) {
  const list = loadAll();
  const now = Date.now();
  if (profile.id) {
    const idx = list.findIndex((p) => p.id === profile.id);
    if (idx === -1) throw new Error('Profile not found');
    const merged = { ...list[idx], ...profile, updatedAt: now };
    // Only re-check the name when this save actually changes it, so an
    // unrelated edit (membership, features) never renames a profile underneath
    // the user - including the pre-existing duplicates, which are left alone
    // until someone renames one.
    if (profile.name !== undefined && String(profile.name).trim() !== String(list[idx].name || '').trim()) {
      merged.name = uniqueName(list, profile.name, profile.id);
    }
    list[idx] = normalizeProfile(merged);
  } else {
    const newProfile = {
      id: crypto.randomUUID(),
      name: uniqueName(list, profile.name, null),
      kind: profile.kind || 'snapshot',
      modBaseNames: profile.modBaseNames || [],
      packDir: profile.packDir || null,
      source: profile.source || null,
      description: profile.description || '',
      builtinFeatures: profile.builtinFeatures || [],
      // Per-profile built-in feature settings. New profiles are meant to be a
      // PHOTOCOPY of Standard (independent from birth) — the renderer computes
      // that snapshot (it owns the resolver + defaults) and passes it in here.
      // When absent (e.g. a pack import created via main), the profile simply
      // inherits Standard until the user overrides a feature. See
      // src/lib/feature-config.js.
      featureConfig: profile.featureConfig || {},
      // Per-profile launch options (resolution / frame rate / display mode /
      // monitor / custom args). Same photocopy rule as featureConfig above: the
      // renderer seeds this from the CURRENT global launch options at creation,
      // and it is independent from then on — retuning the home page later must
      // never shift a profile that already has its own set. null means "not
      // seeded yet", which reads as the current global values until first edit.
      // See src/lib/launch-options.js.
      launchOptions: profile.launchOptions || null,
      // Fields the CREATE path used to drop on the floor.
      //
      // This branch builds a new row from an explicit field list, which is the
      // right shape for it - but anything not named here was silently
      // discarded, and three of them were being sent. EditProfileModal's create
      // form collects a name, an ICON and a GT VERSION, hands all three to
      // profiles.save, and the icon and version never arrived: you picked a
      // picture, hit Create, and got a cube. The update branch above merges
      // whatever it is given, so editing the profile a second later worked
      // fine, which is why this looked like the icon "not sticking the first
      // time" rather than a create that ignores two of its three inputs.
      //
      // Duplicating a profile is what surfaced it - a copy that loses the
      // original's artwork and its pinned GT version is obviously not a copy -
      // but the bug is older than that feature and belongs here, not in a
      // renderer-side second write.
      gtVersionId: profile.gtVersionId || null,
      iconPath: profile.iconPath || null,
      iconUrl: profile.iconUrl || null,
      // The per-profile archive, and the timestamps that annotate it. Only a
      // duplicate ever arrives with these set; a fresh profile has no history
      // to carry. normalizeProfile below drops any entry that is also a member,
      // so a copy cannot land in the both-at-once state.
      removedBaseNames: profile.removedBaseNames || [],
      archivedAt: profile.archivedAt || undefined,
      // Grid pin. Absent reads as false, so this only matters when a caller
      // deliberately creates something already pinned.
      pinned: !!profile.pinned,
      createdAt: now,
      updatedAt: now,
    };
    if (newProfile.archivedAt === undefined) delete newProfile.archivedAt;
    list.push(normalizeProfile(newProfile));
  }
  saveAll(list);
  return list;
}

function deleteProfile(id) {
  const list = loadAll();
  const entry = list.find((p) => p.id === id);
  // The Standard profile is permanent - never delete it.
  if (entry && (entry.isStandard || entry.id === STANDARD_ID)) return list;
  const next = list.filter((p) => p.id !== id);
  saveAll(next);
  // Clean up staged pack files when the profile is gone. Best-effort; a
  // leftover directory is harmless, so swallow errors.
  if (entry?.kind === 'pack' && entry.packDir && fs.existsSync(entry.packDir)) {
    try {
      fs.rmSync(entry.packDir, { recursive: true, force: true });
    } catch (e) {
      logError('Pack cleanup failed:', e);
    }
  }
  return next;
}

// Copy any pack-provided mods into plugins/ if they aren't already present
// in plugins/ or plugins_disabled/. Skips files that exist to avoid
// clobbering a user's local edits. Returns a list of what was copied.
function installPackAssets(profile) {
  if (profile.kind !== 'pack' || !profile.packDir) return [];
  if (!fs.existsSync(profile.packDir)) {
    logError(`Pack dir missing for profile ${profile.id}: ${profile.packDir}`);
    return [];
  }
  const results = [];
  return results; // Placeholder; real copy happens in applyProfile scope where we have gamePath.
}

// Every installed mod's normalized baseName (enabled + disabled dirs), plus the
// subset that is currently switched OFF.
//
// The disabled half matters on first run. scanMods merges plugins/ and
// plugins_disabled/, so seeding Standard from `all` alone made every mod the
// user had deliberately parked in plugins_disabled/ a member with no record that
// it was off - and applyProfile then computes `desired = members - disabled` and
// ENABLES everything in desired. A user migrating from another manager with
// seven crashing mods parked as disabled pressed Play once and loaded all seven.
function installedBaseNames(gamePath) {
  try {
    const { mods } = scanMods(gamePath);
    return {
      all: mods.map((m) => normBase(m.baseName)),
      disabled: mods.filter((m) => !m.enabled).map((m) => normBase(m.baseName)),
    };
  } catch {
    return { all: [], disabled: [] };
  }
}

// Ensure the permanent Standard profile exists and stays the universal set.
// First run: create it seeded with every installed mod (so nothing is lost).
// Every run: fold any "orphan" installed mod (present on disk but in NO profile -
// e.g. a DLL dropped into plugins/ by hand) into Standard, so files never vanish
// from the UI. Returns the full profile list (Standard first).
function ensureStandardProfile(gamePath) {
  const list = loadAll();
  const scanned = gamePath ? installedBaseNames(gamePath) : { all: [], disabled: [] };
  const installed = scanned.all;
  let std = list.find((p) => p.isStandard || p.id === STANDARD_ID);
  let changed = false;

  if (!std) {
    std = {
      id: STANDARD_ID,
      isStandard: true,
      name: 'Standard Profile',
      kind: 'snapshot',
      modBaseNames: installed.slice(),
      // Seeded alongside the members, so a mod the user had already switched off
      // stays off. See installedBaseNames.
      disabledBaseNames: scanned.disabled.slice(),
      packDir: null,
      source: null,
      description: '',
      // The visible, default-ON built-ins. This was `[]` until 2026-08-03, and
      // an empty array here is NOT "no opinion" - the launch reconcile in
      // App.jsx treats it as "every visible feature is OFF" and writes that
      // into config.features, which is what the in-game mod reads. So a fresh
      // install turned the user's Specials back off the moment they pressed
      // Play, and the only things that survived were the hidden infra modules
      // the reconcile skips. That is the "I enabled the Specials and nothing
      // loaded in game" report.
      //
      // MIRRORS defaultBuiltinFeatureIds() in src/lib/create-profile.js
      // (status 'available' && !hidden && defaultEnabled). It is duplicated
      // rather than imported because that file is renderer ESM and this is
      // main-process CJS; check-standard-seed.mjs fails the build if the two
      // ever disagree, so the duplication cannot rot.
      builtinFeatures: ['wristband', 'camera', 'setup-tiles', 'nametags'],
      // Standard is the base every other profile inherits from. An empty block
      // means "use the built-in defaults" until the user edits a feature here;
      // the renderer's resolver (src/lib/feature-config.js) fills the gaps.
      featureConfig: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    list.unshift(std);
    changed = true;
  }

  // Backfill featureConfig on Standard profiles that predate per-profile
  // feature settings, so the shape is always present (the resolver tolerates
  // its absence, but a consistent shape avoids surprises downstream).
  if (std && !std.featureConfig) {
    std.featureConfig = {};
    changed = true;
  }

  // Fold "orphan" mods - installed on disk but in NO profile at all (e.g. a DLL
  // hand-dropped into plugins/ by the user) - into Standard so they aren't lost.
  // Mods that ARE in some profile are deliberately left alone: a mod installed
  // into another profile but NOT Standard stays out of Standard. Standard is a
  // curated profile (the default/home), not a mirror of the plugins folder.
  //
  // `removedBaseNames` is what makes "Remove from Standard" actually stick.
  // Without it, removing a mod that lived only in Standard left it in no
  // profile at all, so it looked like an orphan and this fold put it straight
  // back on the next launch. The removal silently undid itself.
  //
  // Matching is case-insensitive here (matchKey, not normBase) so a membership
  // entry whose case differs from the name on disk cannot produce a duplicate
  // Standard entry or a phantom orphan.
  const excluded     = new Set((std.removedBaseNames || []).map(matchKey));
  const inSomeProfile = new Set(list.flatMap((p) => (p.modBaseNames || []).map(matchKey)));
  const seen    = new Set((std.modBaseNames || []).map(matchKey));
  const nextStd = [...(std.modBaseNames || [])];
  // An orphan that is sitting in plugins_disabled/ is adopted as a member that
  // is switched OFF, for the same reason first-run seeding records it: adopting
  // it as a plain member means the next apply turns it on, which is the app
  // deciding something the user already decided the other way.
  const offNow  = new Set(scanned.disabled.map(matchKey));
  const nextOff = [...(std.disabledBaseNames || [])];
  const offSeen = new Set(nextOff.map(matchKey));
  let added = false;
  for (const b of installed) {
    const k = matchKey(b);
    if (!k || seen.has(k) || inSomeProfile.has(k) || excluded.has(k)) continue;
    seen.add(k);
    nextStd.push(b);
    if (offNow.has(k) && !offSeen.has(k)) { nextOff.push(b); offSeen.add(k); }
    added = true;
  }
  if (added) {
    std.modBaseNames = nextStd;
    if (nextOff.length !== (std.disabledBaseNames || []).length) std.disabledBaseNames = nextOff;
    std.updatedAt = Date.now();
    changed = true;
  }

  // Drop archive entries for mods that are no longer installed, so the list
  // cannot grow forever and a reinstall of the same mod behaves like a fresh
  // one. Every profile, not just Standard: custom profiles carry archives now,
  // and an archive row for a file that no longer exists is a row whose Restore
  // button cannot work and whose Delete button has nothing to delete.
  //
  // Skipped entirely when there is no game path (or the scan found nothing),
  // because "installed" is then empty for want of anywhere to look, and pruning
  // against it would silently empty every archive in the app.
  if (gamePath && installed.length) {
    const onDisk = new Set(installed.map(matchKey));
    for (const p of list) {
      if (!Array.isArray(p.removedBaseNames) || !p.removedBaseNames.length) continue;
      const keep = p.removedBaseNames.filter((b) => onDisk.has(matchKey(b)));
      if (keep.length === p.removedBaseNames.length) continue;
      p.removedBaseNames = keep;
      const at = pruneArchivedAt(p);
      if (at) p.archivedAt = at; else delete p.archivedAt;
      p.updatedAt = Date.now();
      changed = true;
    }
  }

  // One-time rename (2026-08-08): 'pregame-tiles' -> 'setup-tiles'. Every
  // profile, not just Standard. builtinFeatures is the source of truth the
  // launch reconcile writes into config.features, so a profile still naming the
  // old id would switch the feature OFF the moment the user pressed Play -
  // and silently, because an unrecognised id looks exactly like a feature the
  // user chose not to enable.
  //
  // Renamed in place to keep its position, and only when the new id is not
  // already present, so a profile carrying both cannot end up with a duplicate.
  //
  // featureConfig is keyed by the same id, so it moves with it - otherwise the
  // user keeps the feature but silently loses every setting they configured
  // for it, which the resolver would refill with defaults and look intentional.
  for (const p of list) {
    if (Array.isArray(p.builtinFeatures) && p.builtinFeatures.includes('pregame-tiles')) {
      p.builtinFeatures = p.builtinFeatures.includes('setup-tiles')
        ? p.builtinFeatures.filter((f) => f !== 'pregame-tiles')
        : p.builtinFeatures.map((f) => (f === 'pregame-tiles' ? 'setup-tiles' : f));
      p.updatedAt = Date.now();
      changed = true;
    }
    const fc = p.featureConfig;
    if (fc && Object.prototype.hasOwnProperty.call(fc, 'pregame-tiles')) {
      if (!Object.prototype.hasOwnProperty.call(fc, 'setup-tiles')) fc['setup-tiles'] = fc['pregame-tiles'];
      delete fc['pregame-tiles'];
      p.updatedAt = Date.now();
      changed = true;
    }
  }

  if (changed) saveAll(list);
  return list;
}

// Purge a mod baseName from EVERY profile (including Standard). Called after
// "Delete entirely" removes the physical file, so no profile keeps a dangling
// reference to a mod that no longer exists on disk. Returns the updated list.
function removeModFromAllProfiles(baseName) {
  const list = loadAll();
  const key = matchKey(baseName);
  let changed = false;
  for (const p of list) {
    const arr = p.modBaseNames || [];
    const next = arr.filter((b) => matchKey(b) !== key);
    if (next.length !== arr.length) {
      p.modBaseNames = next;
      p.updatedAt = Date.now();
      changed = true;
    }
  }
  // Also drop the mod from every profile's ARCHIVE and switched-off record. The
  // file is gone, so an archive entry has nothing left to restore - it would
  // render a Restore button that cannot work - and keeping the exclusion would
  // make a later reinstall of the same mod behave differently from a first
  // install (it would be held out of that profile for no visible reason).
  //
  // Every profile, not just Standard: this is the function "Delete permanently"
  // calls, and a delete started from modpack "1"'s archive has to clear the
  // archive rows in Standard and in every other modpack too.
  for (const p of list) {
    for (const field of ['removedBaseNames', 'disabledBaseNames']) {
      if (!Array.isArray(p[field]) || !p[field].length) continue;
      const keep = p[field].filter((b) => matchKey(b) !== key);
      if (keep.length === p[field].length) continue;
      p[field] = keep;
      p.updatedAt = Date.now();
      changed = true;
    }
    if (p.archivedAt && Object.prototype.hasOwnProperty.call(p.archivedAt, key)) {
      const at = pruneArchivedAt(p);
      if (at) p.archivedAt = at; else delete p.archivedAt;
      changed = true;
    }
  }
  if (changed) saveAll(list);
  return list;
}

// Re-point every profile's membership from one mod name to another. Called
// after the file itself is renamed on disk.
//
// Without this, renaming a mod from the Standard page silently ejected it from
// every profile that held it: membership still named the old file, which no
// longer exists, so the mod vanished from the lists AND applyProfile stopped
// enabling it. ProfilesView already did this for renames started from a profile
// page; this makes the main-process behaviour the same wherever the rename came
// from. Returns the updated list.
function renameModInAllProfiles(oldName, newName) {
  const list = loadAll();
  const from = matchKey(oldName);
  const to = normBase(newName);
  if (!from || !to) return list;
  let changed = false;
  for (const p of list) {
    const arr = p.modBaseNames || [];
    let touched = false;
    const next = arr.map((b) => { if (matchKey(b) !== from) return b; touched = true; return to; });
    if (!touched) continue;
    // A rename onto a name the profile already holds would leave a duplicate.
    const seen = new Set();
    p.modBaseNames = next.filter((b) => { const k = matchKey(b); if (seen.has(k)) return false; seen.add(k); return true; });
    p.updatedAt = Date.now();
    changed = true;
  }
  // The side-lists key on the same names, so they have to follow the rename too
  // or a renamed mod silently loses its "switched off" state - and, now that
  // removedBaseNames is a user-visible archive, an un-renamed archive entry
  // would be a row naming a file that no longer exists, which the prune in
  // ensureStandardProfile then DELETES on the next launch. Renaming a mod would
  // quietly empty it out of every archive holding it.
  for (const p of list) {
    for (const field of ['removedBaseNames', 'disabledBaseNames']) {
      if (!Array.isArray(p[field]) || !p[field].length) continue;
      const nextList = p[field].map((b) => (matchKey(b) === from ? to : b));
      if (!nextList.some((b, i) => b !== p[field][i])) continue;
      p[field] = nextList;
      p.updatedAt = Date.now();
      changed = true;
    }
    // archivedAt is keyed by matchKey, so the key itself has to move.
    if (p.archivedAt && Object.prototype.hasOwnProperty.call(p.archivedAt, from)) {
      const ts = p.archivedAt[from];
      delete p.archivedAt[from];
      p.archivedAt[matchKey(to)] = ts;
      changed = true;
    }
  }
  if (changed) saveAll(list);
  return list;
}

function applyProfile(gamePath, profileId) {
  const profiles = loadAll();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error('Profile not found');

  const pluginsDir = getPluginsDir(gamePath);
  const disabledDir = path.join(gamePath, 'BepInEx', 'plugins_disabled');

  // ── Core-DLL sweep (anti-piracy) ────────────────────────────────
  // The paid feature code (the "core") must NEVER sit on disk in the game
  // folder as a plain DLL - it's streamed from the desktop app and loaded in
  // memory by the loader stub instead. Sweep any Excalibur.dll (or renamed
  // variant like .dll.old) wherever it may linger. Shares mod-payload's
  // sweepCore so both the launch path and profile-apply enforce the exact same
  // rule; the loader stub + public deps + fonts are deliberately preserved.
  try {
    sweepCore(gamePath);
  } catch (e) {
    logError('Excalibur core sweep failed:', e);
  }

  // For pack profiles: copy any missing files from the staged pack dir
  // into plugins/ so they're available before the enable/disable pass.
  // Copy failures collected, not just logged: a pack asset that does not land is
  // a mod the profile claims to have and the game will not load, and the toggle
  // pass below cannot see the difference (the file simply is not in the scan).
  // Silently applying "successfully" with half a pack missing is the same lie as
  // a silently failed toggle.
  const assetFailures = [];
  if (profile.kind === 'pack' && profile.packDir && fs.existsSync(profile.packDir)) {
    for (const name of profile.modBaseNames) {
      const safe = path.basename(name);
      if (safe !== name) continue;
      const src = path.join(profile.packDir, safe);
      if (!fs.existsSync(src)) continue;
      const inPlugins = path.join(pluginsDir, safe);
      const inDisabled = path.join(disabledDir, safe);
      if (fs.existsSync(inPlugins) || fs.existsSync(inDisabled)) continue;
      try {
        fs.mkdirSync(pluginsDir, { recursive: true });
        const stat = fs.statSync(src);
        if (stat.isDirectory()) fs.cpSync(src, inPlugins, { recursive: true, force: true });
        else fs.copyFileSync(src, inPlugins);
        logInfo(`Installed pack asset ${safe} → plugins/`);
      } catch (e) {
        logError('Pack asset copy failed for', safe, e);
        assetFailures.push({ name: safe, error: e.message });
      }
    }
  }

  const { mods } = scanMods(gamePath);
  // matchKey, NOT normBase. This is the line that decides what the GAME loads,
  // and it used to compare case-sensitively while every other layer (the
  // Standard list, ProfilesView rows, the membership writers, the Standard
  // fold) compares case-insensitively. A membership entry whose case differed
  // from the file on disk therefore showed as a member in the UI and got
  // DISABLED here - the profile looked right on screen and was wrong in game,
  // with nothing to explain the difference.
  const desired = new Set((profile.modBaseNames || []).map(matchKey));
  // `disabledBaseNames` are members the user has switched OFF by hand. Only the
  // Standard Profile has them, because only its page has per-mod switches (that
  // is what its "2/7 on" count means). Applying has to honour those switches:
  // the enabled/disabled state on disk is destroyed the moment another profile
  // is applied, so without this record, returning to Standard would either turn
  // every member back on (overriding the user every single launch) or leave
  // them all off (an unmodded game). Custom profiles never carry the field, so
  // for them this is a no-op and applying still means "all members on".
  for (const b of profile.disabledBaseNames || []) desired.delete(matchKey(b));
  const results = [];
  const failed = [...assetFailures];
  for (const m of mods) {
    const shouldBeEnabled = desired.has(matchKey(m.baseName));
    if (m.enabled === shouldBeEnabled) continue;
    // A mod's DATA FOLDER is not a profile member and never moves. Skipped
    // BEFORE the toggle, not after, so it is not counted as a move either.
    //
    // Counting it was a real bug: toggleMod refuses these during a bulk apply
    // (GorillaShirts packs, wallpapers), but the result was recorded as
    // `ok: true` regardless - so the toast said "Set up 1 mod to match Standard
    // Profile", nothing had actually moved, and the folder was still mismatched
    // at the NEXT launch. The same toast, every single launch, forever.
    if (m.isDataFolder) continue;
    try {
      // bulk: a profile switch must never sweep a mod's DATA folder into
      // plugins_disabled/ - see toggleMod. This is the path the GorillaShirts
      // report came through.
      const r = toggleMod(m.path, shouldBeEnabled, { bulk: true });
      // Belt and braces for anything else toggleMod declines: a refusal is
      // neither a move (do not toast it) nor a failure (do not block launch).
      if (r && r.skipped) continue;
      results.push({ id: m.id, ok: true, enabled: shouldBeEnabled });
    } catch (e) {
      results.push({ id: m.id, ok: false, error: e.message });
      failed.push({ name: m.displayName || m.baseName || m.id, error: e.message });
    }
  }

  // A partial apply is a FAILURE, and it has to be reported as one.
  //
  // This used to return `results` with `{ok:false}` entries buried in it, the
  // IPC handler wrapped the whole array in ok(...), and every caller in the app
  // only ever counted `.filter(x => x.ok)`. Nothing anywhere read the failures.
  // So a DLL held by antivirus or a crashed session stayed enabled, the toast
  // said "Set up 6 mods to match Cosmetics Pack", the profile page listed 6
  // mods, and the headset loaded 7 - which is the exact class of drift this
  // whole file exists to prevent, re-entering through the error path.
  //
  // Throwing is what makes the EXISTING guards work: the profiles:apply handler
  // already wraps this in try/catch and returns {ok:false,error}, and both
  // App.handleLaunch and handleSwitchToStandard already refuse to launch on
  // {ok:false}. The plugins folder is left as it is - some mods moved, some did
  // not - but the user is told, and the game is not started on a loadout nobody
  // described.
  if (failed.length) {
    const err = new Error(
      failed.length === 1
        ? `Could not set up "${failed[0].name}": ${failed[0].error}`
        : `Could not set up ${failed.length} mods, including "${failed[0].name}": ${failed[0].error}`,
    );
    err.code = 'APPLY_INCOMPLETE';
    err.results = results;
    err.failed = failed;
    throw err;
  }
  return results;
}

module.exports = { listProfiles, saveProfile, deleteProfile, applyProfile, replaceAll, ensureStandardProfile, removeModFromAllProfiles, renameModInAllProfiles, normBase, matchKey, STANDARD_ID };
