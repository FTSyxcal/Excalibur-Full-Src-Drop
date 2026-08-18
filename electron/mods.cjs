// Mod discovery and toggling.
//
// Discovery:
//   Enabled mods live in <game>\BepInEx\plugins\, disabled ones in the
//   sibling folder <game>\BepInEx\plugins_disabled\. Both are scanned and
//   merged into one list so the UI shows everything in the same grid.
//
// Toggling:
//   Toggling moves the file/folder between those two directories without
//   touching its name. Earlier versions of Excalibur renamed with a
//   ".disabled" suffix instead; that broke mods whose code reads their own
//   DLL by name. If we find any leftovers from that era we migrate them on
//   the next scan.
//
// DLL metadata:
//   VS_VERSIONINFO is read from the PE resource section to surface a nicer
//   display name / version. If parsing fails we fall back to the filename.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readPeVersionInfo } = require('./pe-version.cjs');
const { logError, logInfo, logWarn } = require('./logger.cjs');
// For the containment anchor in resolveModRoots. config.cjs only requires
// logger.cjs, so this cannot create a cycle.
const { loadConfig } = require('./config.cjs');

const PLUGINS_SUBPATH = path.join('BepInEx', 'plugins');
const DISABLED_SUBPATH = path.join('BepInEx', 'plugins_disabled');

function getPluginsDir(gamePath) {
  if (!gamePath) throw new Error('Game path is not configured');
  return path.join(gamePath, PLUGINS_SUBPATH);
}

function getDisabledDir(gamePath) {
  if (!gamePath) throw new Error('Game path is not configured');
  return path.join(gamePath, DISABLED_SUBPATH);
}

function hashFile(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function deterministicHue(seed) {
  // Stable color per mod - hash the name so the same mod always lights up the
  // same. Not cryptographic; just a cheap visual differentiator.
  const h = crypto.createHash('sha1').update(seed).digest();
  return h[0] * 360 / 256;
}

function prettifyName(raw) {
  // "MyCoolMod.dll" -> "My Cool Mod"
  return raw
    .replace(/\.dll$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Product names that are TEMPLATE LEFTOVERS, not the mod's name. A BepInEx
// plugin scaffolded from the common template ships with productName
// "BepInUpdater" and plenty of authors never change it - so a real mod arrives
// on disk claiming to be somebody else's updater, and the list showed four
// separate rows called "BepInUpdater" whose files were GorillaCosmeticToss.dll,
// GorillaShirtsBepInEx.dll and so on.
//
// The filename is the more honest source in exactly these cases, so a name on
// this list is ignored and the prettified filename wins. Anything not listed
// keeps its embedded name, which is right far more often than not.
const BOILERPLATE_PRODUCT = /^(bepin(ex)?[-_ ]?updater|bepinex[-_ ]?plugin(\s?template)?|plugin\s?template|myplugin|my\s?first\s?plugin|classlibrary\d*|template)$/i;

function describeDll(dllAbsPath, fallbackName) {
  let displayName = prettifyName(fallbackName);
  let version = null;
  let description = null;
  try {
    const info = readPeVersionInfo(dllAbsPath);
    if (info) {
      const embedded = info.productName || info.fileDescription;
      if (embedded && !BOILERPLATE_PRODUCT.test(String(embedded).trim())) {
        displayName = embedded;
      }
      version = info.productVersion || info.fileVersion || null;
      description = info.fileDescription || null;
    }
  } catch (e) {
    logError('PE parse failed for', dllAbsPath, e);
  }
  return { displayName, version, description };
}

// One-time sweep: any file/folder in plugins/ whose name ends with
// ".disabled" is from the legacy scheme. Strip the suffix and move it into
// plugins_disabled/. Handles both `Foo.dll.disabled` and `Custom.disabled/`.
function migrateLegacyDisabled(pluginsDir, disabledDir) {
  if (!fs.existsSync(pluginsDir)) return;
  let migrated = 0;
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    const name = entry.name;
    if (!name.endsWith('.disabled')) continue;
    const cleanName = name.replace(/\.disabled$/, '');
    const src = path.join(pluginsDir, name);
    try {
      fs.mkdirSync(disabledDir, { recursive: true });
      let dst = path.join(disabledDir, cleanName);
      if (fs.existsSync(dst)) {
        // Collision - preserve whichever was already in plugins_disabled
        // under a backup name so we never clobber content silently.
        const backup = path.join(disabledDir, `${cleanName}.legacy-${Date.now()}`);
        fs.renameSync(dst, backup);
      }
      fs.renameSync(src, dst);
      migrated++;
    } catch (e) {
      logError('migrateLegacyDisabled failed for', name, e);
    }
  }
  if (migrated) {
    logInfo(`Migrated ${migrated} legacy .disabled ${migrated === 1 ? 'entry' : 'entries'} out of plugins/`);
  }
}

function buildModEntry(parentDir, entry, enabled) {
  const abs = path.join(parentDir, entry.name);

  if (entry.isDirectory()) {
    const baseName = entry.name;
    const primaryDll = findPrimaryDll(abs);
    let size = 0;
    let mtime = 0;
    try {
      size = dirSize(abs);
      mtime = fs.statSync(abs).mtimeMs;
    } catch {
      // ignore
    }
    const meta = primaryDll
      ? describeDll(primaryDll, baseName)
      : { displayName: prettifyName(baseName), version: null, description: null };
    // Recorded identity wins over the guess. hashFile on the wrong .dll is not
    // a harmless miss: the hash is what identifies the mod, so it can attribute
    // this folder to a completely different mod that ships the same library.
    const marker = readModMarker(abs);
    const sha256 = marker?.primarySha256 || (primaryDll ? hashFile(primaryDll) : null);
    return {
      id: abs,
      kind: 'folder',
      // No .dll anywhere inside => this is a mod's DATA (GorillaShirts packs,
      // wallpapers, custom maps), not a mod. toggleMod REFUSES to move these;
      // the flag lets the UI say so instead of offering a switch that no-ops.
      isDataFolder: !findPrimaryDll(abs) && !containsAnyDll(abs),
      path: abs,
      enabled,
      fileName: entry.name,
      baseName,
      displayName: meta.displayName,
      version: meta.version,
      description: meta.description,
      sizeBytes: size,
      modifiedAt: mtime,
      sha256,
      hue: deterministicHue(baseName),
      // Full recursive tree - every nested entry is a real toggleable
      // mod with its own `path`/`enabled`. Empty for empty folders so
      // the UI can still render the row + show a "+ Add mod" affordance.
      children: walkFolderTree(abs, enabled),
    };
  }

  if (!entry.isFile()) return null;
  if (!entry.name.toLowerCase().endsWith('.dll')) return null;

  const baseName = entry.name;
  let size = 0;
  let mtime = 0;
  try {
    const stat = fs.statSync(abs);
    size = stat.size;
    mtime = stat.mtimeMs;
  } catch {
    // ignore
  }
  const meta = describeDll(abs, baseName);
  const sha256 = hashFile(abs);
  return {
    id: abs,
    kind: 'dll',
    path: abs,
    enabled,
    fileName: entry.name,
    baseName,
    displayName: meta.displayName,
    version: meta.version,
    description: meta.description,
    sizeBytes: size,
    modifiedAt: mtime,
    sha256,
    hue: deterministicHue(baseName),
  };
}

// Recursively walk a folder under either plugins/ or plugins_disabled/,
// returning fully-formed mod entries for every nested DLL and subfolder.
// `parentEnabled` is propagated from whichever root the walk started in -
// every nested entry's `enabled` field reflects which root its real path
// sits under, so a child can be independently toggled even when its
// parent folder is enabled.
function walkFolderTree(folderPath, parentEnabled) {
  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const children = [];
  for (const entry of entries) {
    const built = buildModEntry(folderPath, entry, parentEnabled);
    if (built) children.push(built);
  }
  children.sort(sortModEntries);
  return children;
}

// Folder/DLL/folder-then-DLL alphabetical sort. Reused for both the top
// level list and every nested level so the rendered tree has a
// consistent shape regardless of depth.
function sortModEntries(a, b) {
  // Same rule as the top level: no enabled/disabled tiebreak, so toggling a
  // mod inside a folder doesn't make it jump around either.
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return (a.displayName || a.fileName || '').localeCompare(
    b.displayName || b.fileName || '', undefined, { sensitivity: 'base' }
  );
}

// Entries that are Excalibur's OWN, not community mods - they must never surface
// in the mod list or scan results. Covers the manager/core/patcher/loader
// artifacts (Excalibur, Excalibur.dll, Excalibur.Patcher.dll, Excalibur.backup-*)
// AND the built-in feature folders like the excalibur-camera screenshot folder
// (and its .backup-* variants). The built-in features load through the app, so
// none of these belong alongside the user's installed mods. The regex matches
// "excalibur" followed by a separator (. or -) or end of name, so a real
// community mod wouldn't be caught unless it literally used the Excalibur brand.
function isManagerEntry(name) {
  if (!name) return false;
  // Luma Looks is a BUILT-IN feature being folded into the client, not a
  // community mod, so its engine folder and the timestamped "LumaLooks
  // backups" directories it leaves behind are ours to hide - same rule, same
  // reason as the Excalibur artifacts above. Matches "lumalooks" or
  // "luma-looks"/"luma looks" followed by a separator or end of name, so a
  // community mod would have to literally use the Luma Looks brand to be
  // caught. This FILTERS the list; it never deletes anything on disk.
  if (/^luma[-_ ]?looks([-._ ]|$)/i.test(name)) return true;
  return /^excalibur([-.]|$)/i.test(name);
}

// A backup WE made, for ANY mod - `<name>.backup-<epoch ms>`.
//
// isManagerEntry above only ever covered Excalibur's and Luma Looks' own
// artifacts, so a backup taken of somebody else's mod was left to surface in
// the list as a mod in its own right. A real install ended up showing fourteen
// rows reading "Wallpapers.backup 1785531722757 - Folder - 0 mods - 0 on",
// which is the shape of the bug the user actually SEES: not the folder on disk,
// but the list insisting each one is a mod they have installed.
//
// Deliberately strict. The suffix must be `.backup-` followed by digits and
// nothing else, because that is exactly what toggleMod writes - so a community
// mod called "Backup" or "Backup Tool" is not caught, and neither is a folder a
// user named "Wallpapers.backup" by hand.
//
// This FILTERS the list. It never deletes anything: pruning is toggleMod's job
// and is deliberately conservative about unique content (see below).
// BepInEx's own updater. Not a mod anyone chose, nothing a user toggles, and
// switching it off does not change what loads in the game - so it does not
// belong in a list of "your mods" any more than the Excalibur artifacts above.
// Matches an entry whose name IS the updater, so a mod that merely mentions
// updating in its name is untouched. FILTERS the list; deletes nothing.
function isUpdaterEntry(name) {
  return /^bepin(ex)?[-_ ]?updater([-._ ]|$)/i.test(String(name || ''));
}

function isBackupArtifact(name) {
  return typeof name === 'string' && /\.backup-\d+$/.test(name);
}

// The standalone camera DLL is a separate product for people WITHOUT the
// client — on a machine running Excalibur it double-loads against the
// built-in camera that streams through the app (forced debug panels, input
// fights). Dev tooling (watch:mods / Test Lab's Update-mods, or a session
// with the deploy env var set) kept re-copying it into plugins, so the
// client now evicts it on every scan — whoever writes it, it does not
// survive. EXCALIBUR_KEEP_STANDALONE=1 is the escape hatch for deliberate
// standalone-in-game testing.
function evictStandaloneCamera(pluginsDir, disabledDir) {
  if (process.env.EXCALIBUR_KEEP_STANDALONE === '1') return;
  for (const dir of [pluginsDir, disabledDir]) {
    try {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (/^ExcaliburCamera\.dll(\.backup-\d+)?$/i.test(f)) {
          fs.rmSync(path.join(dir, f), { force: true });
          logWarn(`scanMods: evicted standalone ${f} - the client streams the built-in camera (set EXCALIBUR_KEEP_STANDALONE=1 to keep it)`);
        }
      }
    } catch { /* locked while the game runs - next scan gets it */ }
  }
}

function scanMods(gamePath) {
  const pluginsDir = getPluginsDir(gamePath);
  const disabledDir = getDisabledDir(gamePath);

  // Clean up leftovers from the old ".disabled" suffix scheme before scan.
  migrateLegacyDisabled(pluginsDir, disabledDir);
  evictStandaloneCamera(pluginsDir, disabledDir);

  if (!fs.existsSync(pluginsDir)) {
    return { pluginsDir, exists: false, mods: [] };
  }

  const mods = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (isManagerEntry(entry.name) || isUpdaterEntry(entry.name) || isBackupArtifact(entry.name)) continue;
    const m = buildModEntry(pluginsDir, entry, true);
    if (m) mods.push(m);
  }
  if (fs.existsSync(disabledDir)) {
    for (const entry of fs.readdirSync(disabledDir, { withFileTypes: true })) {
      if (isManagerEntry(entry.name) || isUpdaterEntry(entry.name) || isBackupArtifact(entry.name)) continue;
      const m = buildModEntry(disabledDir, entry, false);
      if (m) mods.push(m);
    }
  }

  // Folders before loose DLLs, then alphabetical. Deliberately NOT sorted by
  // enabled state: it used to put enabled mods first, so flicking a mod's
  // switch made its row jump to the top of the list and flicking it back sent
  // it away again. A list that reorders itself under the control you just
  // pressed is disorienting, and it made a freshly installed mod appear to
  // move around on its own. Order now depends only on what a mod IS.
  mods.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  });

  return { pluginsDir, exists: true, mods };
}

function listFolderChildren(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true })
      // Our own bookkeeping, not part of the mod. It cannot become a mod entry
      // (that path requires .dll) but it would otherwise sit in the user's file
      // list looking like something they were meant to understand or delete.
      .filter((e) => e.name !== '.excalibur-mod.json');
    const children = entries.map((e) => {
      const p = path.join(folderPath, e.name);
      const isDir = e.isDirectory();
      let sizeBytes = 0;
      let version = null;
      try {
        if (isDir) {
          sizeBytes = dirSize(p);
        } else {
          sizeBytes = fs.statSync(p).size;
          if (e.name.toLowerCase().endsWith('.dll')) {
            const info = readPeVersionInfo(p);
            version = info?.productVersion || info?.fileVersion || null;
          }
        }
      } catch {
        // ignore unreadable entries
      }
      return {
        name: e.name,
        kind: isDir ? 'dir' : 'file',
        isDll: !isDir && e.name.toLowerCase().endsWith('.dll'),
        sizeBytes,
        version,
      };
    });
    children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return children;
  } catch {
    return [];
  }
}

// The identity a multi-file install recorded for itself.
//
// findPrimaryDll below is a GUESS: it prefers `<FolderName>.dll` and otherwise
// takes whichever .dll readdir returns first. That is right for a mod whose
// title matches its filename and wrong for everything else - "Neon Grapples"
// (a space, so no matching file) resolves to a dependency, and a mod shipping
// 0Harmony resolves to 0Harmony. The Mods page hashes whatever it picks, so a
// wrong pick means the mod is unidentifiable or, worse, attributed to whatever
// else ships those exact bytes.
//
// mods:install-archive writes the answer down instead. Absent for a hand-dropped
// folder or an older install, and the guess still covers those.
function readModMarker(folderPath) {
  try {
    const raw = fs.readFileSync(path.join(folderPath, '.excalibur-mod.json'), 'utf8');
    const m = JSON.parse(raw);
    if (m && typeof m === 'object' && typeof m.primarySha256 === 'string') return m;
  } catch { /* no marker, or unreadable - fall back to the guess */ }
  return null;
}

function findPrimaryDll(folderPath) {
  try {
    const files = fs.readdirSync(folderPath);
    const folderBase = path.basename(folderPath);
    const same = files.find((f) => f.toLowerCase() === `${folderBase.toLowerCase()}.dll`);
    if (same) return path.join(folderPath, same);
    const any = files.find((f) => f.toLowerCase().endsWith('.dll'));
    return any ? path.join(folderPath, any) : null;
  } catch {
    return null;
  }
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const items = fs.readdirSync(cur, { withFileTypes: true });
    for (const it of items) {
      const p = path.join(cur, it.name);
      if (it.isDirectory()) stack.push(p);
      else if (it.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          // ignore
        }
      }
    }
  }
  return total;
}

// Resolve the BepInEx roots for a mod path. Returns
// { gameRoot, currentRoot, mirrorRoot, relPath, currentlyEnabled } or
// throws if the path lies outside both roots.
//
// ANCHORED to the configured game folder, and that is the whole point.
//
// This used to walk up the tree looking for any ancestor directory literally
// NAMED 'plugins' or 'plugins_disabled', and accept the path if it found one.
// It never consulted the config, so "inside plugins/" really meant "somewhere
// under a folder that happens to be called plugins" - on any drive. And this is
// the ONLY guard on toggle, rename, move and delete, the last of which is
// `fs.rmSync(recursive: true, force: true)`. The comment above deleteMod
// asserted the opposite ("can only ever remove something living under
// plugins/") and was simply wrong: a renderer asking to delete
// `C:\Users\me\AppData\Roaming\JetBrains\IntelliJIdea\plugins\x` was obliged.
//
// `gameRoot` may be passed explicitly (tests, and any caller that already knows
// which install it is operating on). Otherwise it comes from the saved config.
// If NO game path is configured at all - genuine first run, nothing to compare
// against - the name-based behaviour is kept, because there is no anchor to
// check and refusing every operation would break setup.
function resolveModRoots(modPath, gameRoot) {
  const resolved = path.resolve(modPath);
  let anchor = gameRoot || null;
  if (!anchor) {
    try { anchor = loadConfig()?.gamePath || null; } catch { anchor = null; }
  }
  const expectedBep = anchor ? path.resolve(anchor, 'BepInEx') : null;
  // Walk up the tree until we find a parent named 'plugins' or
  // 'plugins_disabled'. The grandparent is BepInEx/, which is what we
  // need for mirror computations.
  let dir = path.dirname(resolved);
  while (dir && dir !== path.dirname(dir)) {
    const base = path.basename(dir);
    if (base === 'plugins' || base === 'plugins_disabled') {
      const bepRoot = path.dirname(dir);
      // The name matched. Now check it is OUR BepInEx, not just something that
      // happens to be laid out like one.
      if (expectedBep && path.resolve(bepRoot).toLowerCase() !== expectedBep.toLowerCase()) {
        throw new Error(`Refusing to touch a path outside the managed Gorilla Tag folder: ${modPath}`);
      }
      const pluginsDir = path.join(bepRoot, 'plugins');
      const disabledDir = path.join(bepRoot, 'plugins_disabled');
      const currentlyEnabled = base === 'plugins';
      const currentRoot = currentlyEnabled ? pluginsDir : disabledDir;
      const mirrorRoot  = currentlyEnabled ? disabledDir : pluginsDir;
      const relPath = path.relative(currentRoot, resolved);
      return { bepRoot, pluginsDir, disabledDir, currentRoot, mirrorRoot, relPath, currentlyEnabled };
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Mod is not inside plugins/ or plugins_disabled/: ${modPath}`);
}

// Windows reports the read-only ATTRIBUTE as a missing owner-write bit in
// stat().mode, which is the one EPERM cause we can actually name for the user.
// Files only: Windows sets the read-only attribute on ordinary folders as a
// shell hint (it means "this folder is customised"), so trusting it for a
// directory would hand the wrong explanation to anyone who has ever changed a
// folder icon.
function isReadOnlyFile(p) {
  try {
    if (!p) return false;
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o200) === 0;
  } catch {
    return false;
  }
}

// Map an EBUSY/EPERM rename failure to a friendly FILE_LOCKED error so
// the renderer can surface "close Gorilla Tag" copy consistently.
//
// EPERM used to go straight to that message, and on Windows EPERM is not only
// "another process is holding this file open" - it is equally the errno for a
// file carrying the read-only attribute, which closing the game will never
// change. So a user whose DLL came out of a zip read-only was told, forever, to
// close a game that was not even running, and nothing they could do to the game
// would ever make the rename work. The read-only case is detected first and
// gets its own code and its own instruction; EBUSY and every other EPERM (a
// genuine sharing violation) keep FILE_LOCKED, which is the code callers match
// on.
function wrapLockError(e, verb = 'modify', targetPath = null) {
  if (e.code !== 'EBUSY' && e.code !== 'EPERM') return e;
  if (e.code === 'EPERM' && isReadOnlyFile(targetPath)) {
    const err = new Error(
      `Could not ${verb} "${path.basename(targetPath)}" - the file is marked read-only. ` +
      'Untick "Read-only" in its Properties, then try again.'
    );
    err.code = 'FILE_READ_ONLY';
    return err;
  }
  const err = new Error(
    `Could not ${verb} the mod - the file is locked. Make sure Gorilla Tag is fully closed.`
  );
  err.code = 'FILE_LOCKED';
  return err;
}

// Are these two paths the same content? Files compare by size then bytes;
// FOLDERS compare recursively (same child names, each child the same).
//
// A folder mod is a real and common shape - Wallpapers, GorillaTextureLoader,
// MonkeFrames on a live install - and the previous file-only check answered
// "not identical" for every one of them, because readFileSync() on a directory
// throws EISDIR and the catch reported that as a difference. The caller reads
// this as "the destination holds something DIFFERENT, preserve it", so an
// identical folder was backed up on every single toggle.
//
// Deliberately compares CONTENT rather than trusting mtime: these two trees are
// copies moved between plugins/ and plugins_disabled/, and a copy is exactly
// the operation that does not preserve timestamps.
function sameEntry(a, b) {
  let sa, sb;
  try { sa = fs.statSync(a); sb = fs.statSync(b); } catch { return false; }
  if (sa.isDirectory() !== sb.isDirectory()) return false;

  if (!sa.isDirectory()) {
    if (sa.size !== sb.size) return false;
    try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
  }

  let ea, eb;
  try {
    ea = fs.readdirSync(a).sort();
    eb = fs.readdirSync(b).sort();
  } catch { return false; }
  if (ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i++) {
    if (ea[i] !== eb[i]) return false;
    if (!sameEntry(path.join(a, ea[i]), path.join(b, eb[i]))) return false;
  }
  return true;
}

// How many backups holding UNIQUE content we keep per mod. Redundant ones are
// always pruned regardless; this only bounds the ones whose deletion would
// genuinely lose something, so it is a rotation depth rather than a tidy-up
// threshold. Three is enough to undo a couple of bad toggles without letting a
// mod that rewrites its own files every launch grow a folder per toggle.
const MAX_UNIQUE_BACKUPS = 3;

// Every file inside `root`, as relative-path -> absolute-path. Flat, so two
// trees can be compared by path regardless of how they nest.
function fileMap(root, rel = '', out = new Map()) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const abs = path.join(root, e.name);
    const key = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) fileMap(abs, key, out);
    else out.set(key, abs);
  }
  return out;
}

// True when EVERY file in `backupPath` also exists, byte-for-byte, at the same
// relative path in at least one of `keepers`. Only then is deleting the backup
// guaranteed to lose nothing.
//
// A plain file backup is handled too: it is redundant when some keeper is an
// identical file.
function backupIsRedundant(backupPath, keepers) {
  let st;
  try { st = fs.statSync(backupPath); } catch { return false; }
  const live = keepers.filter((k) => { try { return fs.existsSync(k); } catch { return false; } });
  // Nothing left to compare against: refuse to prune. If the backup is the only
  // copy of anything, it is the last thing that should be deleted.
  if (!live.length) return false;

  if (!st.isDirectory()) return live.some((k) => sameEntry(backupPath, k));

  const mine = fileMap(backupPath);
  // An empty backup folder holds nothing to lose.
  if (mine.size === 0) return true;
  const theirs = live.filter((k) => { try { return fs.statSync(k).isDirectory(); } catch { return false; } })
    .map((k) => fileMap(k));
  if (!theirs.length) return false;

  for (const [rel, abs] of mine) {
    const covered = theirs.some((m) => m.has(rel) && sameEntry(abs, m.get(rel)));
    if (!covered) return false;   // unique content - keep the whole backup
  }
  return true;
}

// Enable or disable a mod by moving its path between the plugins/ and
// plugins_disabled/ mirror trees. Supports arbitrary nesting - a DLL at
// plugins/Cosmetics/HUD/A.dll toggles to plugins_disabled/Cosmetics/HUD/A.dll,
// creating intermediate parent folders as needed.

// ── A DATA FOLDER IS NOT A MOD ───────────────────────────────────────────────
// A folder under plugins/ holding no .dll ANYWHERE in its tree is not a mod, it
// is some mod's data - and moving it is data loss, not a toggle.
//
// The case that found this (2026-08-07, tester report): GorillaShirts stores
// every installed shirt pack as a subfolder beside its own DLL --
//     Content = new ContentLoader(Path.GetDirectoryName(Plugin.Info.Location));
//     string folderPath = Path.Combine(RootLocation, info.Title);
// -- so each pack lands as a TOP-LEVEL FOLDER in BepInEx/plugins/. Excalibur
// listed each one as a toggleable mod and, on a disable or a profile switch,
// renamed it into plugins_disabled/. GorillaShirts then could not find its
// folder, recreated an empty one, and every imported shirt looked deleted.
//
// RECURSIVE, unlike findPrimaryDll which only reads the top level: a genuine
// folder-mod may keep its DLL a level down, and refusing to move that would
// break a real mod to protect a fake problem.
function containsAnyDll(dir, depth = 0) {
  if (depth > 8) return false;              // pathological nesting - stop, treat as data
  let entries;
  // UNREADABLE MEANS "ASSUME MOD". A permissions error must not silently make
  // a real mod unmovable; the existing behaviour is the safer default there.
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.dll')) return true;
  }
  for (const e of entries) {
    if (e.isDirectory() && containsAnyDll(path.join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

function isDataFolder(p) {
  try { return fs.statSync(p).isDirectory() && !containsAnyDll(p); } catch { return false; }
}

function toggleMod(modPath, enable, opts = {}) {
  if (!fs.existsSync(modPath)) {
    throw new Error(`Mod not found: ${modPath}`);
  }

  const { mirrorRoot, relPath, currentlyEnabled } = resolveModRoots(modPath);
  if (currentlyEnabled === enable) {
    // Already where it should be; nothing to do.
    return { path: modPath, enabled: enable };
  }

  // Guarded HERE, not in each caller, because every path that can move a mod -
  // the toggle switch, Disable all (setAllMods) and a profile switch
  // (profiles.cjs applyProfile) - funnels through this one function. A guard
  // per caller is a guard somebody forgets at the fourth call site.
  // BULK ONLY. An explicit toggle from the UI is a deliberate, visible,
  // reversible act - the folder shows up in plugins_disabled/ and the switch
  // flips back. What wipes content is the AUTOMATIC kind: a profile switch or
  // Disable all sweeping a folder the user never thought of as a mod, while the
  // owning mod quietly recreates an empty one at the next launch.
  //
  // Scoped this way after the existing tests caught the first attempt, which
  // refused every move: `Wallpapers` is the same shape (a third-party mod
  // recreates it each launch) and users do legitimately toggle it by hand.
  // Blocking that to fix this would have traded one broken feature for another.
  if (opts.bulk && isDataFolder(modPath)) {
    logWarn(`toggleMod: SKIPPING "${path.basename(modPath)}" during a bulk operation - it `
          + 'holds no .dll anywhere inside, so it is a DATA folder belonging to some mod. '
          + 'Sweeping it is how imported content (GorillaShirts packs, wallpapers, custom '
          + 'maps) gets wiped. Toggle it by hand if you really mean to.');
    return { path: modPath, enabled: currentlyEnabled, skipped: 'data-folder' };
  }

  const targetPath = path.join(mirrorRoot, relPath);
  const targetParent = path.dirname(targetPath);
  fs.mkdirSync(targetParent, { recursive: true });

  if (fs.existsSync(targetPath)) {
    // Defensive: a duplicate at the destination "shouldn't happen", but it
    // happens CONSTANTLY for mods an external tool auto-deploys into plugins/
    // (e.g. a dotnet post-build) while our disabled copy sits in the mirror:
    // every toggle collides. Blind backups piled up timestamped junk in the
    // game folder. Now: identical duplicate → dedupe silently; real content
    // difference → keep ONE backup (newest), pruning older ones first.
    // BOTH halves below used to be file-only, and a FOLDER mod tripped each of
    // them in the direction that creates junk. A real install ended up with
    // TWELVE `Wallpapers.backup-<epoch>` folders, one per toggle, each holding
    // the same three PNGs, all of them showing up in the mods list as
    // "Folder - 0 mods - 0 on".
    //
    //   * sameEntry: readFileSync() on a directory throws EISDIR, the catch
    //     turned that into `false`, so a folder mod was NEVER seen as identical
    //     - not even when it was byte-for-byte the same - and always took the
    //     backup path.
    //   * the prune: rmSync without `recursive` throws EISDIR on a directory,
    //     and ONE try/catch wrapped the whole loop, so the first folder backup
    //     aborted the pruning of every remaining one. The prune could therefore
    //     never clear a folder backup, which is precisely the only kind this
    //     bug produces. Two failures compounding: one makes the junk, the other
    //     guarantees it accumulates.
    const identical = sameEntry(modPath, targetPath);
    if (identical) {
      fs.rmSync(modPath, { force: true, recursive: true });
      logWarn(`toggleMod: destination already had an identical ${relPath} - deduped, no backup needed`);
      return { path: targetPath, enabled: enable };
    }
    {
      const dir = path.dirname(targetPath);
      const base = path.basename(targetPath);
      // Anchored, and digits only: `startsWith(base + '.backup-')` also matched
      // things like `Wallpapers.backup-1.keep`, which is somebody's own file.
      const rx = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.backup-\\d+$`);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { /* nothing to prune */ }
      // Oldest first - the timestamp is the suffix, so a numeric sort on it is
      // chronological.
      const found = names.filter((f) => rx.test(f))
        .sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop()));

      const rm = (f, why) => {
        // try/catch PER ENTRY: one undeletable leftover (locked by the game,
        // permissions) must not stop the others being cleared.
        try { fs.rmSync(path.join(dir, f), { force: true, recursive: true }); }
        catch (e) { logWarn(`toggleMod: could not prune ${f}: ${e.message}`); return false; }
        logInfo(`toggleMod: pruned ${f} (${why})`);
        return true;
      };

      // Pass 1: anything provably REDUNDANT goes, always. This is the case that
      // produced the reported bug - fourteen byte-identical copies of the same
      // three PNGs - and it is always safe, because every file in them still
      // exists elsewhere.
      const unique = [];
      for (const f of found) {
        if (backupIsRedundant(path.join(dir, f), [modPath, targetPath])) rm(f, 'identical content kept elsewhere');
        else unique.push(f);
      }

      // Pass 2: the ones that hold content found NOWHERE else. The old code
      // deleted these too, which is a data-loss bug wearing a tidy-up costume:
      // on the real install one of them was the only surviving copy of the
      // user's own `excalibur wallpaper.png`.
      //
      // They cannot be kept forever either, or a mod whose files genuinely
      // change on every launch grows a folder per toggle - the same complaint in
      // a different shape. So they rotate: keep the newest few, and say so in
      // the log when one is dropped, because that IS a deletion of the last copy
      // of something.
      const room = Math.max(0, MAX_UNIQUE_BACKUPS - 1);   // -1: one is about to be taken
      for (const f of unique.slice(0, Math.max(0, unique.length - room))) {
        logWarn(`toggleMod: dropping ${f} - it held unique content, but ${MAX_UNIQUE_BACKUPS} unique backups is the cap`);
        rm(f, 'oldest unique backup, over the cap');
      }
    }
    const backup = `${targetPath}.backup-${Date.now()}`;
    fs.renameSync(targetPath, backup);
    logWarn(`toggleMod: destination already had a DIFFERENT ${relPath}, backed up to ${backup}`);
  }

  try {
    fs.renameSync(modPath, targetPath);
  } catch (e) {
    throw wrapLockError(e, 'toggle', modPath);
  }
  return { path: targetPath, enabled: enable };
}

// ── New helpers: rename, move, createFolder, suggestRegistryMatch ─────

// Reject path-separator/relative-traversal/empty names so a user typing
// in the rename input can't break out of plugins/ or overwrite a
// neighbour by accident.
function sanitizeName(name, { allowDots = true } = {}) {
  if (typeof name !== 'string') throw new Error('Name must be a string.');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Name cannot be empty.');
  if (trimmed === '.' || trimmed === '..') throw new Error('Invalid name.');
  if (/[\\/:*?"<>|]/.test(trimmed)) throw new Error('Name contains illegal characters.');
  if (!allowDots && trimmed.includes('.')) throw new Error('Folder name cannot contain dots.');
  if (trimmed.length > 200) throw new Error('Name is too long.');
  return trimmed;
}

// "Do these two paths name the same thing on disk?" Windows is
// case-insensitive, so plugins/MonkeMod.dll and plugins/monkemod.dll are ONE
// file and existsSync answers yes to both spellings - realpath is what tells
// that apart from two genuinely different neighbours. The fallback only runs
// when a path cannot be resolved at all, which callers here have already ruled
// out with existsSync.
function isSameFsEntry(a, b) {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  }
}

// Rename a mod file or folder in place (same parent directory). For DLL
// files the .dll suffix is auto-preserved if the user forgot it. Folder
// names are accepted as-is. Refuses to clobber an existing neighbour.
//
// Two things this got wrong, both of them consequences of the mirror layout:
//
//   * Fixing capitalisation was impossible, and the error blamed the user's own
//     file. The "nothing to do" check compared names case-SENSITIVELY, so
//     "MonkeMod.dll" -> "monkemod.dll" fell through to an existsSync collision
//     check that runs on a case-INSENSITIVE filesystem and matched the very
//     file being renamed: 'A file named "monkemod.dll" already exists here.'
//     about itself, with no way out. A target that resolves to the SAME entry
//     is now a rename that must proceed - renameSync performs the case change
//     happily on Windows - and only a genuinely DIFFERENT neighbour is refused.
//   * The twin in the other root was left behind. plugins/Foo.dll and
//     plugins_disabled/Foo.dll are ONE mod that happens to have a copy on both
//     sides; renaming only the copy in front of us meant the next scan listed
//     TWO mods (Bar on, Foo off) and the orphaned Foo was re-adopted into
//     Standard as a "new" mod on the next launch. Both copies now move
//     together, or neither does.
function renameMod(modPath, newName) {
  if (!fs.existsSync(modPath)) throw new Error(`Mod not found: ${modPath}`);
  const roots = resolveModRoots(modPath); // guard: must lie under either root
  const sanitized = sanitizeName(newName);
  const parent = path.dirname(modPath);
  const stat = fs.statSync(modPath);
  const isFile = stat.isFile();
  const oldName = path.basename(modPath);
  let finalName = sanitized;
  if (isFile && oldName.toLowerCase().endsWith('.dll') && !finalName.toLowerCase().endsWith('.dll')) {
    finalName = `${finalName}.dll`;
  }
  if (finalName === oldName) {
    return { path: modPath, renamed: false };
  }
  const targetPath = path.join(parent, finalName);
  if (fs.existsSync(targetPath) && !isSameFsEntry(targetPath, modPath)) {
    throw new Error(`A ${isFile ? 'file' : 'folder'} named "${finalName}" already exists here.`);
  }

  // The same relative path under the other root - present only when this mod
  // has a copy on both sides.
  const mirrorPath = path.join(roots.mirrorRoot, roots.relPath);
  const hasMirror = fs.existsSync(mirrorPath);
  const mirrorTarget = path.join(path.dirname(mirrorPath), finalName);
  if (hasMirror && fs.existsSync(mirrorTarget) && !isSameFsEntry(mirrorTarget, mirrorPath)) {
    // Refused BEFORE anything moves: renaming only the visible copy is exactly
    // how one mod turns into two, so a blocked twin blocks the whole rename.
    throw new Error(
      `A ${isFile ? 'file' : 'folder'} named "${finalName}" already exists in the ${roots.currentlyEnabled ? 'disabled' : 'enabled'} folder.`
    );
  }

  try {
    fs.renameSync(modPath, targetPath);
  } catch (e) {
    throw wrapLockError(e, 'rename', modPath);
  }
  let mirrorRenamed = false;
  if (hasMirror) {
    try {
      fs.renameSync(mirrorPath, mirrorTarget);
      mirrorRenamed = true;
    } catch (e) {
      // Put the first rename back rather than leave the two halves disagreeing.
      // A half-renamed pair is the bug this function exists to avoid, so an
      // untouched mod plus an error is strictly better than a silent split.
      try {
        fs.renameSync(targetPath, modPath);
      } catch (rollbackErr) {
        logError('renameMod: could not roll back', targetPath, rollbackErr);
      }
      throw wrapLockError(e, 'rename', mirrorPath);
    }
  }
  return { path: targetPath, renamed: true, mirrorPath: mirrorRenamed ? mirrorTarget : null };
}

// Move a mod into a different directory. destDir must lie under either
// plugins/ or plugins_disabled/ (or equal one of those roots). Crossing
// roots flips the enabled state implicitly, which is the expected UX
// when a user drops an enabled mod onto a disabled folder.
function moveMod(modPath, destDir) {
  if (!fs.existsSync(modPath)) throw new Error(`Mod not found: ${modPath}`);
  const src = resolveModRoots(modPath);
  // A null/empty dest means "move out to the top level" - the root of whichever
  // tree (plugins/ or plugins_disabled/) the mod currently lives in, so its
  // enabled/disabled state is preserved. Otherwise validate the given dest is
  // inside one of the BepInEx roots (this also throws if dest is the modPath
  // itself or its descendant - prevents moving a folder into itself).
  const resolvedDest = path.resolve(destDir || src.currentRoot);
  const underPlugins  = resolvedDest === src.pluginsDir  || resolvedDest.startsWith(src.pluginsDir  + path.sep);
  const underDisabled = resolvedDest === src.disabledDir || resolvedDest.startsWith(src.disabledDir + path.sep);
  if (!underPlugins && !underDisabled) {
    throw new Error('Destination must be inside plugins/ or plugins_disabled/.');
  }
  if (resolvedDest === path.resolve(modPath) || resolvedDest.startsWith(path.resolve(modPath) + path.sep)) {
    throw new Error('Cannot move a folder into itself.');
  }
  fs.mkdirSync(resolvedDest, { recursive: true });
  const targetPath = path.join(resolvedDest, path.basename(modPath));
  if (path.resolve(targetPath) === path.resolve(modPath)) {
    return { path: modPath, moved: false, enabled: src.currentlyEnabled };
  }
  if (fs.existsSync(targetPath)) {
    throw new Error(`A "${path.basename(modPath)}" already exists in that folder.`);
  }
  try {
    fs.renameSync(modPath, targetPath);
  } catch (e) {
    throw wrapLockError(e, 'move', modPath);
  }
  return {
    path: targetPath,
    moved: true,
    enabled: underPlugins,
  };
}

// Create an empty folder under plugins/ or plugins_disabled/ (or
// anywhere nested under either root). Used by the "+ New folder" button
// in the Mods page so users can bucket their mods without leaving the app.
function createFolder(gamePath, parentDir, folderName) {
  const sanitized = sanitizeName(folderName, { allowDots: false });
  const pluginsDir = getPluginsDir(gamePath);
  const disabledDir = getDisabledDir(gamePath);
  const resolvedParent = path.resolve(parentDir);
  const underPlugins  = resolvedParent === pluginsDir  || resolvedParent.startsWith(pluginsDir  + path.sep);
  const underDisabled = resolvedParent === disabledDir || resolvedParent.startsWith(disabledDir + path.sep);
  if (!underPlugins && !underDisabled) {
    throw new Error('New folders must be inside plugins/ or plugins_disabled/.');
  }
  fs.mkdirSync(resolvedParent, { recursive: true });
  const targetPath = path.join(resolvedParent, sanitized);
  if (fs.existsSync(targetPath)) {
    throw new Error(`A folder named "${sanitized}" already exists here.`);
  }
  fs.mkdirSync(targetPath);
  return { path: targetPath, enabled: underPlugins };
}

// Permanently delete a mod (a DLL) or an entire folder. resolveModRoots guards
// the path so this can only ever remove something living under plugins/ or
// plugins_disabled/ - never an arbitrary path the renderer might pass.
function deleteMod(modPath) {
  if (!fs.existsSync(modPath)) return { path: modPath, deleted: false };
  resolveModRoots(modPath); // guard: must lie under either BepInEx root
  try {
    fs.rmSync(modPath, { recursive: true, force: true });
  } catch (e) {
    throw wrapLockError(e, 'delete', modPath);
  }
  return { path: modPath, deleted: true };
}

// ── Registry similarity helper ────────────────────────────────────────
// Levenshtein edit distance between two strings. Iterative O(m*n) DP -
// 200-char cap on each input via sanitizeName means worst case is tiny.
function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  const row = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) row[j] = j;
  for (let i = 1; i <= la; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= lb; j++) {
      const tmp = row[j];
      row[j] = (a.charCodeAt(i - 1) === b.charCodeAt(j - 1))
        ? prev
        : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = tmp;
    }
  }
  return row[lb];
}

function normalizeForMatch(s) {
  return String(s || '').replace(/\.dll$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// Given a (possibly user-typed) mod base name, find the closest match
// in the registry's bepinex_mods catalog. Returns the best candidate
// within a fuzzy edit-distance threshold, or null if nothing's close.
// Threshold scales with length so short names need exact-ish matches
// while longer names tolerate 2-3 typos.
function suggestRegistryMatch(typedName, registryMods) {
  if (!typedName || !Array.isArray(registryMods) || registryMods.length === 0) return null;
  const a = normalizeForMatch(typedName);
  if (!a) return null;
  let best = null;
  for (const r of registryMods) {
    const candidate = r?.name;
    if (!candidate) continue;
    const b = normalizeForMatch(candidate);
    if (!b) continue;
    if (a === b) {
      return { suggestion: candidate, confidence: 'exact', distance: 0, registryEntry: r };
    }
    const d = levenshtein(a, b);
    const longer = Math.max(a.length, b.length);
    const maxAllowed = longer <= 6 ? 1 : (longer <= 12 ? 2 : 3);
    if (d <= maxAllowed && (!best || d < best.distance)) {
      best = { suggestion: candidate, confidence: 'fuzzy', distance: d, registryEntry: r };
    }
  }
  return best;
}

// Byte-for-byte "is this the same content?", used to tell a re-drop of a file
// the user already has from a genuinely different mod wearing the same name.
// Recurses for folder mods, which are small (a DLL or three plus config).
function sameContent(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.isDirectory() !== sb.isDirectory()) return false;
    if (!sa.isDirectory()) {
      if (sa.size !== sb.size) return false;
      return fs.readFileSync(a).equals(fs.readFileSync(b));
    }
    const na = fs.readdirSync(a).sort();
    const nb = fs.readdirSync(b).sort();
    if (na.length !== nb.length) return false;
    for (let i = 0; i < na.length; i++) {
      if (na[i] !== nb[i]) return false;
      if (!sameContent(path.join(a, na[i]), path.join(b, na[i]))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// The same relative path under the other root, or null for a path that is not
// under either. Used to notice a mod's disabled twin.
function mirrorPathFor(p) {
  try {
    const { mirrorRoot, relPath } = resolveModRoots(p);
    return path.join(mirrorRoot, relPath);
  } catch {
    return null;
  }
}

// Where a dropped item should actually land.
//
// installMods used to be `path.join(target, name)` with an unconditional
// copyFileSync / cpSync({force:true}) on top - the ONE mutation in this file
// that did not guard a collision. renameMod throws, moveMod throws,
// createFolder throws, toggleMod takes a backup; install silently destroyed.
// Dropping a stranger's Cosmetics.dll wiped out the working Cosmetics.dll it
// landed on: no prompt, no backup, and nothing on disk to restore from.
//
// Now, identical bytes are a no-op (re-dropping a file you already have is not
// an error and should not litter plugins/ with copies), and different bytes
// install ALONGSIDE as "Name (2).dll", incrementing. The renderer already
// expects that shape - ModsLanding's norm() strips a trailing " (2)" when
// matching a mod to the registry, which is a suffix nothing in this file ever
// produced until now.
//
// The disabled twin counts as a collision too. Installing Foo.dll while
// plugins_disabled/Foo.dll exists otherwise creates a pair that reads as two
// mods sharing one identity, which is the same confusion renameMod now refuses
// to create.
function findInstallSpot(targetDir, name, src) {
  const ext = /\.dll$/i.test(name) ? name.slice(-4) : '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n <= 99; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    const dest = path.join(targetDir, candidate);
    const twin = mirrorPathFor(dest);
    const destTaken = fs.existsSync(dest);
    const twinTaken = !!twin && fs.existsSync(twin);
    if (destTaken && sameContent(src, dest)) return { dest, name: candidate, skipped: true };
    if (twinTaken && sameContent(src, twin)) return { dest: twin, name: candidate, skipped: true };
    if (!destTaken && !twinTaken) return { dest, name: candidate, skipped: false };
  }
  throw new Error(`There are already too many copies of "${name}" installed.`);
}

// Copy dropped files/folders into the plugins layout. Accepts DLLs (flat)
// and directories (recursive folder mod). Non-DLL files are rejected so
// users can't accidentally dump unrelated content. Valid install targets
// are plugins/ root, any subfolder inside plugins/, or inside
// plugins_disabled/ (for installing into a folder mod that's currently
// disabled - keeps it disabled).
//
// Per-file result shape: the original { src, name, ok, kind, dest } plus
// `renamedTo` when a collision forced a "(2)" name and `skipped: true` when the
// exact same bytes were already installed (`dest` then points at the copy that
// was already there). `name` is always the name that ended up ON DISK, because
// that is what callers record as profile membership.
function installMods(gamePath, targetDir, sourcePaths) {
  const pluginsDir = getPluginsDir(gamePath);
  const disabledDir = getDisabledDir(gamePath);
  const resolvedPlugins = path.resolve(pluginsDir);
  const resolvedDisabled = path.resolve(disabledDir);
  const target = targetDir ? path.resolve(targetDir) : resolvedPlugins;

  const insidePlugins =
    target === resolvedPlugins || target.startsWith(resolvedPlugins + path.sep);
  const insideDisabled =
    target === resolvedDisabled || target.startsWith(resolvedDisabled + path.sep);
  if (!insidePlugins && !insideDisabled) {
    throw new Error('Install target must be inside plugins/ or plugins_disabled/');
  }
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });

  const results = [];
  for (const src of sourcePaths) {
    try {
      if (!src || !fs.existsSync(src)) {
        results.push({ src, ok: false, error: 'File not found' });
        continue;
      }
      const stat = fs.statSync(src);
      const name = path.basename(src);
      const isDir = stat.isDirectory();

      if (!isDir && !name.toLowerCase().endsWith('.dll')) {
        results.push({ src, name, ok: false, error: `Skipped ${name} (only .dll files or folders can be installed)` });
        continue;
      }

      const spot = findInstallSpot(target, name, src);
      const kind = isDir ? 'dir' : 'file';
      if (spot.skipped) {
        logInfo(`installMods: ${name} is already installed with identical bytes at ${spot.dest} - skipped`);
        results.push({ src, name: spot.name, ok: true, kind, dest: spot.dest, skipped: true });
        continue;
      }
      if (isDir) {
        fs.cpSync(src, spot.dest, { recursive: true, force: true });
      } else {
        fs.copyFileSync(src, spot.dest);
      }
      if (spot.name !== name) {
        logWarn(`installMods: ${name} already exists with different content - installed alongside as ${spot.name}`);
        results.push({ src, name: spot.name, ok: true, kind, dest: spot.dest, renamedTo: spot.name });
      } else {
        results.push({ src, name: spot.name, ok: true, kind, dest: spot.dest });
      }
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM') {
        const err = new Error(`${path.basename(src)} is locked - close Gorilla Tag and try again.`);
        err.code = 'FILE_LOCKED';
        results.push({ src, ok: false, error: err.message });
      } else {
        results.push({ src, ok: false, error: e.message });
      }
    }
  }
  return results;
}

// Match key for "is this scanned file the mod that list entry names?". Same
// rule as profiles.cjs matchKey (strip .dll, lowercase) - kept as a local copy
// because profiles.cjs already requires THIS file, so importing it back would
// be a cycle.
function modMatchKey(name) {
  return String(name || '').replace(/\.dll$/i, '').toLowerCase();
}

// Enable or disable mods in bulk.
//
// With no `baseNames`, acts on every scanned mod. With a list, acts on ONLY
// those. The scoped form exists because the Standard page's "Enable all /
// Disable all" button sits next to a count of STANDARD's members ("2/7 on")
// but called the unscoped form, so it toggled every DLL in the plugins folder -
// including mods that belong to another profile and are deliberately not in
// Standard. "Enable all" therefore loaded mods into the game that the page
// never listed, which is the worst kind of drift: running in game, invisible
// in the UI.
// It also used to iterate the TOP LEVEL only, so every mod nested inside a
// folder was silently skipped. A DLL at plugins/Cosmetics/HUD.dll is a
// first-class toggleable entry - it has its own `path` and `enabled`, the grid
// renders a switch for it, and a profile can list it by base name without
// listing its parent folder. "Enable all" simply never reached it, and the
// button reported success having done nothing for that mod. The walk now
// descends into `children`, with one rule: once an entry has been acted on, its
// subtree is left alone, because a folder that moved took its children with it
// (and a folder that FAILED to move must not be half-emptied instead).
function setAllMods(gamePath, enable, baseNames = null) {
  const { mods } = scanMods(gamePath);
  const only = Array.isArray(baseNames) ? new Set(baseNames.map(modMatchKey)) : null;
  const results = [];
  const walk = (list) => {
    for (const m of list) {
      // Scoping is unchanged: an out-of-scope folder is not toggled, but we
      // still look inside it, because the scoped list can name a child without
      // naming its parent.
      const inScope = !only || only.has(modMatchKey(m.baseName));
      if (inScope && m.enabled !== enable) {
        try {
          const r = toggleMod(m.path, enable, { bulk: true });
          results.push({ id: m.id, ok: true, newPath: r.path });
        } catch (e) {
          results.push({ id: m.id, ok: false, error: e.message });
        }
        continue;
      }
      if (m.children && m.children.length) walk(m.children);
    }
  };
  walk(mods);
  return results;
}

module.exports = {
  isDataFolder,
  scanMods,
  toggleMod,
  setAllMods,
  installMods,
  renameMod,
  moveMod,
  createFolder,
  deleteMod,
  isManagerEntry,
  isUpdaterEntry,
  isBackupArtifact,
  backupIsRedundant,
  suggestRegistryMatch,
  getPluginsDir,
  getDisabledDir,
};
