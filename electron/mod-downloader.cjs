'use strict';

// Downloads mods from GitHub releases and installs them into BepInEx/plugins/.
// DLLs go to BepInEx/plugins/{ModName}/{file.dll}.
// ZIPs are extracted to the game root (they already contain the BepInEx tree).

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { logInfo, logError } = require('./logger.cjs');

const REGISTRY_PATH = path.join(__dirname, '..', 'mods-registry.json');

// A catalogue asset should never be anywhere near this big; the largest entry
// today is Bark at ~12 MB. The cap exists because the whole body is buffered in
// memory in the MAIN process, so an oversized or hostile response takes the
// entire app down rather than one page. Matches the 200 MB ceiling the
// community install path already uses in main.js.
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
// A stalled socket used to leave the row on "Downloading..." forever with no
// cancel affordance anywhere on the page. github-repo.cjs already sets a
// timeout on its own requests; this is the same idea for the file itself.
const DOWNLOAD_TIMEOUT_MS = 120_000;

// ── Trust boundary ────────────────────────────────────────────────────────────
//
// The `mod` object arrives over IPC FROM THE RENDERER, so nothing on it is
// trustworthy in the main process, however trustworthy mods-registry.json is.
// electron/mods.cjs already enforces exactly this for every path it writes
// ("Install target must be inside plugins/ or plugins_disabled/", :687) and this
// module previously applied that discipline to `extractTo` and to nothing else -
// `mod.name` was joined straight into a path, and updateMod's `currentPath` was
// validated by a file-extension regex alone.

// The bare name of a mod, as a filename component and nothing more. Rejects
// separators and traversal rather than sanitising them, because a registry entry
// that needs sanitising is a registry bug we want to hear about, not paper over.
function safeModName(raw) {
  const name = String(raw || '').trim();
  if (!name) throw new Error('This mod has no name, so there is nowhere to install it.');
  if (name !== path.basename(name) || name.includes('/') || name.includes('\\')) {
    throw new Error(`Refusing to install a mod whose name is a path: ${name}`);
  }
  if (name === '.' || name === '..' || /[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) {
    throw new Error(`Refusing to install a mod with an unusable name: ${name}`);
  }
  return name;
}

// Resolve `target` and prove it stays inside `root`. Used for every write this
// module performs, not just zip extraction.
function containedPath(root, target, label) {
  const base = path.resolve(root);
  const dest = path.resolve(base, target);
  if (dest !== base && !dest.startsWith(base + path.sep)) {
    throw new Error(`Refusing to write outside the game folder: ${label || target}`);
  }
  return dest;
}

function assertDownloadUrl(url, modName) {
  const raw = String(url || '');
  if (!raw) throw new Error(`${modName || 'This mod'} has no download link in the catalogue, so it cannot be installed.`);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`${modName || 'This mod'} has an unreadable download link in the catalogue.`); }
  // https only. Plain http is a downgrade, and `data:`/`file:` would let a
  // caller plant bytes with no network at all.
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing to download over ${parsed.protocol.replace(':', '')}. Only https links are allowed.`);
  }
  return raw;
}

// One place that knows how to fetch a mod file: https-only, time-limited, and
// size-capped both by the advertised Content-Length and by what actually arrives
// (a hostile server can lie about the former).
async function fetchModFile(url, modName, { expectedSha256 = null } = {}) {
  const safeUrl = assertDownloadUrl(url, modName);
  const res = await fetch(safeUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) {
    // 404 on a `releases/latest` asset almost always means the mod author
    // renamed or removed the file, which the person holding the app can do
    // nothing about - so say that rather than just the number.
    if (res.status === 404) {
      throw new Error(`${modName || 'This mod'} is no longer published at the link in our catalogue (404). It has probably been renamed or removed upstream.`);
    }
    throw new Error(`Download failed with HTTP ${res.status}.`);
  }
  const advertised = Number(res.headers.get('content-length') || 0);
  if (advertised && advertised > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${modName || 'This mod'} is ${Math.round(advertised / 1048576)} MB, which is larger than Excalibur will download.`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${modName || 'This mod'} is larger than Excalibur will download.`);
  }
  if (!buf.length) throw new Error(`${modName || 'This mod'} downloaded as an empty file.`);

  // A 200 is not proof of the right bytes.
  //
  // A captive portal, a corporate proxy, an ISP interception page or a broken CDN
  // node all answer 200 with HTML, and that HTML used to be written into
  // plugins/<Mod>.dll - or, on the update path, straight OVER a working mod.
  // Nothing downstream would notice: the file hashes fine and describeDll falls
  // back to the filename, so it renders as a perfectly normal installed mod that
  // simply never loads.
  //
  // Managed assemblies start "MZ" and zips start "PK". Two bytes, no false
  // positives on anything we legitimately serve.
  const magic = buf.slice(0, 2).toString('latin1');
  // Same rule the install/update paths use to decide zip-vs-dll, so this check
  // can never disagree with what the caller is about to do with the bytes.
  const wantsZip = urlLooksLikeZip(safeUrl);
  if (wantsZip ? magic !== 'PK' : magic !== 'MZ') {
    throw new Error(
      `${modName || 'This mod'} did not download correctly - the server sent something that is not a `
      + `${wantsZip ? 'zip archive' : 'mod file'}. This usually means a network or Wi-Fi sign-in page got in the way. `
      + 'Nothing was changed; please try again.',
    );
  }

  // And when we know what the bytes SHOULD be, insist on it.
  //
  // Curated downloads had no integrity check of any kind, while the community
  // install path already refused to write on a hash mismatch ("the bytes must be
  // the bytes that were scanned"). The catalogue presented to users as the safe
  // one was the less verified of the two - and runAutoUpdates re-fetches these
  // URLs unattended at boot, overwriting the live file in place.
  //
  // expectedSha256 comes from excalibur_identify_mods, i.e. a hash we recorded
  // independently from GitHub's release metadata. Null means "we cannot know",
  // and is deliberately NOT treated as verified: it skips the check rather than
  // refusing a legitimate update.
  if (expectedSha256) {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== String(expectedSha256).toLowerCase()) {
      throw new Error(
        `${modName || 'This mod'} failed its integrity check, so nothing was written. `
        + 'The file we received is not the file we expected. Please try again in a few minutes.',
      );
    }
  }

  return buf;
}

// Write through a temp file in the same directory, then rename over the target.
// `writeFileSync` opens with truncate-then-write, so a crash, a full disk or an
// antivirus grabbing the handle mid-write left a 0-byte or half-written DLL that
// getInstalledMods still happily reported as installed. rename within one
// directory is atomic, so the destination is either the old file or the whole
// new one.
function writeFileAtomic(dest, buf) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.${Date.now()}.part`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

function detectLoader(gamePath) {
  if (!gamePath) return 'none';
  if (fs.existsSync(path.join(gamePath, 'winhttp.dll')))  return 'bepinex';
  if (fs.existsSync(path.join(gamePath, 'version.dll'))) return 'melonloader';
  return 'none';
}

// Strip the suffixes an install can carry, in the order they nest:
// `Foo.dll.disabled` -> `Foo`. Same rule as mods.cjs:83, deliberately.
const bareName = (n) => String(n).replace(/\.disabled$/i, '').replace(/\.dll$/i, '');

// RECURSIVE, and DLL-aware. Two bugs lived in the flat readdir this replaces:
//
//  1. It only looked at the top level, while the Mods page scans the whole tree
//     (mods.cjs:193 `walkFolderTree`) and ships first-class tools for nesting -
//     createFolder, moveMod, drag-to-folder. So the moment a user filed
//     `Bark.dll` under `plugins/Gameplay/`, THIS page called Bark "not
//     installed", offered Install, and wrote a SECOND copy to the top level -
//     two assemblies with one BepInPlugin GUID, and the nested one could not be
//     removed from here afterwards.
//  2. It counted every directory entry, so `README.md` and `config.cfg` were
//     reported as installed mods. Harmless until a catalogue name collides with
//     one.
//
// Folders still count by their own name (folder-per-mod is the most common
// layout), AND their contents are walked, so both conventions resolve.
function getInstalledMods(gamePath) {
  if (!gamePath) return [];
  const roots = [
    path.join(gamePath, 'BepInEx', 'plugins'),
    path.join(gamePath, 'BepInEx', 'plugins_disabled'),
  ];
  const names = new Set();
  const MAX_DEPTH = 6; // deep enough for any real layout, shallow enough to never hang

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subfolder shouldn't blank the whole list
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // our own manifest dir, and dotfiles
      if (entry.isDirectory()) {
        names.add(bareName(entry.name).toLowerCase());
        if (depth < MAX_DEPTH) walk(path.join(dir, entry.name), depth + 1);
        continue;
      }
      // Files only count if they are actually a mod binary.
      if (/\.dll(\.disabled)?$/i.test(entry.name) || /\.disabled$/i.test(entry.name)) {
        names.add(bareName(entry.name).toLowerCase());
      }
    }
  };

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, 0);
  }
  return [...names];
}

// The three IPC handlers that call this return fail(e) on a throw, and the
// Download page renders that message verbatim. So whatever comes out of here is
// read by a USER, not a developer - and the raw Node error was not readable by
// anyone. A real install shipped without this file and showed its owner:
//
//   ENOENT, mods-registry.json not found in C:\...\resources\app.asar
//
// next to a Retry button that could never succeed, because retrying does not put
// a file into an archive. That is a packaging fault the person holding it can do
// nothing about, so say that, and say what they CAN do.
//
// scripts/verify-package.cjs now fails the build when this file is missing from
// app.asar, so a build with this fault should never reach anyone again. This
// message is the second line of defence, for a build made outside that guard.
function loadRegistry() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      logError(`[downloader] mods-registry.json missing from the package at ${REGISTRY_PATH}`);
      throw new Error(
        'The mod catalogue is missing from this installation of Excalibur. '
        + 'This is a fault in the build itself, not something Retry can fix - '
        + 'reinstalling with the latest version should resolve it.',
      );
    }
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    logError(`[downloader] mods-registry.json is not valid JSON: ${e.message}`);
    throw new Error('The mod catalogue in this installation is corrupt. Reinstalling Excalibur should resolve it.');
  }
}

// Where a ZIP mod's contents get extracted. Default (no extractTo) is the game
// root, which is correct for zips that already contain a `BepInEx/...` tree
// (BepInEx itself, MonkeFrames, etc). Some mods instead ship a zip whose files
// sit at the archive root with no BepInEx prefix (e.g. GorillaTextureLoader:
// its DLL + a `packs/` folder side by side, where the mod resolves packs
// relative to its own DLL location). Those set extractTo to a plugins subfolder
// like "BepInEx/plugins/GorillaTextureLoader" so the DLL and its data land
// together and the folder name matches the mod name (keeping install detection
// and uninstall - which key off the bare folder/file name - working unchanged).
// The path is game-root-relative and is guarded so a registry entry can never
// write outside the game folder.
function resolveExtractDir(gamePath, extractTo) {
  if (!extractTo) return gamePath;
  const root = path.resolve(gamePath);
  const dest = path.resolve(root, extractTo);
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    throw new Error(`Refusing to extract outside the game folder: ${extractTo}`);
  }
  return dest;
}

// Is this URL a zip? Decided on the PATH, not the whole URL, so a link carrying
// a query string or fragment (`.../X.zip?token=...`) is still recognised as an
// archive instead of being written to disk as `X.dll`.
function urlLooksLikeZip(url) {
  try { return new URL(url).pathname.toLowerCase().endsWith('.zip'); }
  catch { return String(url || '').toLowerCase().endsWith('.zip'); }
}

// Where we record what a ZIP install put on disk. Without this, uninstall could
// only ever find things whose name happens to sit at the top of plugins/ - which
// is why a root-extracted archive used to leave every one of its files behind
// and report "is not on disk" while the mod was plainly still installed.
// Folders that belong to the GAME or the mod LOADER, never to a single mod.
// Compared against the path RELATIVE TO gamePath, so a mod's own `config/` or
// `core/` subfolder inside its install directory is still removable - only the
// shared ones at these exact locations are protected.
const SHARED_INSTALL_DIRS = new Set([
  'bepinex',
  'bepinex/plugins',
  'bepinex/plugins_disabled',
  'bepinex/config',
  'bepinex/core',
  'bepinex/patchers',
  'bepinex/cache',
  'mono',
  'dotnet',
  'gorillatag_data',
]);

const MANIFEST_DIR = ['BepInEx', '.excalibur', 'installs'];
const manifestPath = (gamePath, name) =>
  path.join(gamePath, ...MANIFEST_DIR, `${Buffer.from(String(name).toLowerCase()).toString('hex')}.json`);

function writeInstallManifest(gamePath, name, entries) {
  try {
    const p = manifestPath(gamePath, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ name, installedAt: Date.now(), entries }, null, 2));
  } catch (e) {
    // Never fail an install because bookkeeping failed; uninstall just falls
    // back to the plugins sweep, which is what it always did.
    logError(`[downloader] could not write install manifest for ${name}: ${e.message}`);
  }
}

function readInstallManifest(gamePath, name) {
  try { return JSON.parse(fs.readFileSync(manifestPath(gamePath, name), 'utf8')); }
  catch { return null; }
}

async function installMod(gamePath, mod, { onProgress } = {}) {
  if (!gamePath) throw new Error('Game path is not configured.');
  if (!fs.existsSync(gamePath)) throw new Error('The Gorilla Tag folder Excalibur has saved no longer exists. Set it again in Settings.');

  const name  = safeModName(mod && mod.name);
  const isZip = urlLooksLikeZip(mod.downloadUrl);

  logInfo(`[Downloader] Downloading ${name} from ${mod.downloadUrl}`);
  onProgress?.(`Downloading ${name}…`);

  const buf = await fetchModFile(mod.downloadUrl, name);

  onProgress?.(`Installing ${name}…`);

  if (isZip) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buf);
    const dest = resolveExtractDir(gamePath, mod.extractTo);

    // STAGE FIRST, then move into place. Extracting straight over the game
    // folder meant a corrupt archive, a disk-full, or the app being killed
    // mid-extract left a half-written tree over live game files - and for
    // BepInEx that tree includes winhttp.dll and BepInEx/core. Decompressing
    // everything into a sibling folder first means a bad archive fails before
    // anything the game loads has been touched.
    // `written` records only TOP-LEVEL entries, and for a root-extracted archive
    // (no extractTo, e.g. MonkeFrames) the top-level entry is the literal
    // directory `BepInEx`. Uninstall used to rmSync each recorded entry
    // recursively, so removing one such mod deleted the whole BepInEx tree:
    // every other installed mod, plugins_disabled, and all mod configs.
    // `files` - every file at any depth, relative to dest - lets uninstall
    // remove precisely what this mod put there and nothing else.
    const { written, files } = extractZipStaged(zip, gamePath, dest);

    writeInstallManifest(gamePath, name, {
      kind: 'zip',
      // Where the archive landed, relative to the game folder, plus what it put
      // there. Both are needed: `extractTo` mods live under plugins/, root
      // archives (BepInEx, MonkeFrames) do not.
      dir: path.relative(gamePath, dest).split(path.sep).join('/'),
      top: written,
      files,
    });
    logInfo(`[Downloader] Extracted ${name} to ${dest} (${written.length} top-level entries)`);
  } else {
    // Install the DLL loose as plugins/<ModName>.dll rather than wrapping it in a
    // per-mod subfolder. A bare DLL loads identically in BepInEx (it scans the
    // plugins tree), matches the drag-in install path, and - importantly - keeps
    // the mod showing as an individual mod (with its owner avatar) on the Mods
    // page instead of a generic folder icon. getInstalledMods and uninstallMod
    // both key off the bare name (strip .dll → <ModName>), so we MUST name the
    // file after mod.name (not the raw download filename) for detection/removal
    // to match; existing folder installs stay detected too. Single-DLL mods only;
    // ZIPs keep their own extracted tree.
    const pluginsDir = path.join(gamePath, 'BepInEx', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    // `name` is validated (safeModName), and the join is re-checked against the
    // plugins folder so this can never write outside it however the caller
    // spelled the name.
    const dest = containedPath(pluginsDir, `${name}.dll`, name);
    writeFileAtomic(dest, buf);
    logInfo(`[Downloader] Installed ${name} → ${dest}`);
  }

  return { ok: true };
}

// Extract a zip into `dest` WITHOUT ever leaving a half-written tree over live
// game files.
//
// Decompress into a sibling staging folder first, then move entry by entry. A
// corrupt archive, a full disk, or the app being killed mid-extract fails while
// everything the game loads is still untouched. For BepInEx that matters more
// than usual: a root archive's tree includes winhttp.dll and BepInEx/core, so a
// half-written one is a game that no longer starts.
//
// Pulled out of installMod on 2026-08-02 because updateMod did NOT do any of
// this - it called `extractAllTo(dest, true)` straight onto the live folder, so
// the exact failure installMod had already been fixed for was still reachable
// through the update button. One copy, both callers.
//
// Returns { written, files }: top-level entry names (what uninstall used to key
// on) and every file at any depth relative to dest (what it keys on now).
function extractZipStaged(zip, gamePath, dest) {
  const stage = path.join(gamePath, `.excalibur-staging-${process.pid}-${Date.now()}`);
  const written = [];
  const files = [];
  try {
    fs.mkdirSync(stage, { recursive: true });
    zip.extractAllTo(stage, /* overwrite= */ true);

    fs.mkdirSync(dest, { recursive: true });
    const move = (fromDir, toDir, rel) => {
      for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
        const from = path.join(fromDir, entry.name);
        const to   = path.join(toDir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          fs.mkdirSync(to, { recursive: true });
          if (!rel) written.push(relPath); // only top-level entries need recording
          move(from, to, relPath);
        } else {
          fs.rmSync(to, { force: true });
          fs.renameSync(from, to);
          if (!rel) written.push(relPath);
          files.push(relPath);
        }
      }
    };
    move(stage, dest, '');
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return { written, files };
}

// Update an already-installed mod to its latest release. Overwrites the mod's
// CURRENT on-disk file in place (handles enabled, disabled, and folder-nested
// installs), so nothing gets orphaned or duplicated. ZIP mods extract over the
// game root the same way a fresh install does.
async function updateMod(gamePath, mod, { onProgress } = {}) {
  if (!gamePath) throw new Error('Game path is not configured.');
  const url = mod.downloadUrl;
  const label = safeModName(mod.name || mod.baseName);
  const isZip = urlLooksLikeZip(url);

  logInfo(`[Downloader] Updating ${label} from ${url}`);
  onProgress?.(`Updating ${label}…`);

  const buf = await fetchModFile(url, label, { expectedSha256: mod.expectedSha256 || null });

  if (isZip) {
    const AdmZip = require('adm-zip');
    const dest = resolveExtractDir(gamePath, mod.extractTo);
    const { written, files } = extractZipStaged(new AdmZip(buf), gamePath, dest);

    // Refresh the install manifest. An update rewrites the file set, and
    // uninstall reads this to remove precisely what the mod put on disk - so a
    // stale manifest from the PREVIOUS version would leave the new version's
    // files behind, or try to delete files that are no longer there.
    writeInstallManifest(gamePath, label, {
      kind: 'zip',
      dir: path.relative(gamePath, dest).split(path.sep).join('/'),
      top: written,
      files,
    });
    logInfo(`[Downloader] Updated ${label} (zip staged into ${dest}, ${written.length} top-level entries)`);
    return { ok: true };
  }

  // Overwrite the existing DLL wherever it currently lives (keeps its enabled/
  // disabled state + folder location); fall back to the canonical bare path.
  //
  // `currentPath` comes from the RENDERER. It used to be accepted on the
  // strength of a file-extension regex alone, which meant any absolute path
  // ending `.dll` was writable and `mkdirSync(..., {recursive:true})` would
  // build the folder tree to reach it. Now it has to prove it lives under
  // BepInEx/, the same containment mods.cjs enforces on every path it is handed.
  const bepinexDir = path.join(gamePath, 'BepInEx');
  const pluginsDir = path.join(bepinexDir, 'plugins');
  let current = path.join(pluginsDir, `${label}.dll`);
  if (mod.currentPath && /\.dll(\.disabled)?$/i.test(mod.currentPath)) {
    // Throws (rather than silently falling back) so a genuinely wrong path is
    // reported instead of quietly updating a different file than the caller meant.
    current = containedPath(bepinexDir, mod.currentPath, 'the mod’s current location');
  }
  fs.mkdirSync(path.dirname(current), { recursive: true });
  writeFileAtomic(current, buf);
  logInfo(`[Downloader] Updated ${label} → ${current}`);
  return { ok: true };
}

function uninstallMod(gamePath, mod) {
  if (!gamePath) throw new Error('Game path is not configured.');
  // The install side can drop a mod as any of:
  //   plugins/<Name>/            (folder-per-mod, most common)
  //   plugins/<Name>.dll         (bare single-DLL)
  //   plugins/<Name>.dll.disabled  (toggled off)
  //   plugins_disabled/...       (any of the above under the disabled dir)
  // getInstalledMods scans ALL of these and strips suffixes, so the
  // frontend correctly sees the mod as installed. Uninstall used to
  // only try the folder form, which meant bare-DLL / disabled / and
  // any zip-extracted mod silently no-op'd with `{ok:true}` while the
  // file stayed on disk. Now we sweep every candidate and match
  // case-insensitively (Windows FS is CI, but the code shouldn't rely
  // on that when scanning a directory).
  const target = String(mod.name || '').toLowerCase();
  if (!target) return { ok: false, error: 'Mod has no name.' };

  // BepInEx is the mod LOADER, not a mod. It has no presence in plugins/, so the
  // sweep below could never find it and returned "BepInEx is not on disk. It may
  // have already been removed." - while the banner directly above said BepInEx
  // was detected, and winhttp.dll was untouched. Two things were wrong: the
  // message was false, and the operation is not one we should perform casually
  // anyway. Removing the loader stops EVERY installed mod from loading, and
  // deleting the BepInEx folder to achieve it would take the user's whole
  // plugins tree (and their configs) with it.
  //
  // So: say what is true, and point at the thing that actually does this. The
  // Download page also no longer offers the control - see canUninstallFromCatalogue.
  if (target === 'bepinex') {
    return {
      ok: false,
      error: 'BepInEx is the mod loader, so Excalibur will not remove it from here - '
           + 'every installed mod would stop loading. Delete winhttp.dll from the Gorilla Tag '
           + 'folder if you really want it gone.',
    };
  }

  const removed = [];

  // A ZIP install records exactly what it wrote (see writeInstallManifest), so
  // an archive that extracted to the game root - or to a folder whose name does
  // not match the mod's - can now be removed properly instead of leaving every
  // one of its files behind.
  const manifest = readInstallManifest(gamePath, mod.name);
  if (manifest?.entries?.kind === 'zip') {
    const base = containedPath(gamePath, manifest.entries.dir || '.', 'the recorded install folder');
    const fileList = Array.isArray(manifest.entries.files) ? manifest.entries.files : null;

    if (fileList) {
      // Preferred path: remove exactly the files this archive wrote, then prune
      // the folders that are left empty. A shared directory that still holds
      // another mod's files simply survives the prune, which is the point.
      const dirsTouched = new Set();
      for (const rel of fileList) {
        let full;
        try { full = containedPath(base, rel, rel); } catch { continue; }
        dirsTouched.add(path.dirname(full));
        if (!fs.existsSync(full)) continue;
        try { fs.rmSync(full, { force: true }); removed.push(full); }
        catch (e) { return { ok: false, error: `Could not remove ${rel}: ${e.message}` }; }
      }
      // Deepest first, so a nested tree collapses from the leaves up. Stops at
      // `base` and never removes a directory that still has anything in it.
      const baseResolved = path.resolve(base);
      for (const dir of [...dirsTouched].sort((a, b) => b.length - a.length)) {
        let cur = path.resolve(dir);
        while (cur.startsWith(baseResolved) && cur !== baseResolved) {
          try {
            if (fs.readdirSync(cur).length > 0) break;
            fs.rmdirSync(cur);
          } catch { break; }
          cur = path.dirname(cur);
        }
      }
    } else if (Array.isArray(manifest.entries.top)) {
      // LEGACY manifest, written before the file list existed: all we have is
      // the top-level entry names. For a root-extracted archive that entry is a
      // shared directory such as `BepInEx`, and recursively deleting it removes
      // every OTHER mod, plugins_disabled and all mod configs. Refuse those and
      // let the plugins sweep below do what it can; leaving a few files behind
      // is recoverable, deleting someone's whole mod folder is not.
      for (const rel of manifest.entries.top) {
        let full;
        try { full = containedPath(base, rel, rel); } catch { continue; }
        const relToGame = path.relative(gamePath, full).split(path.sep).join('/').toLowerCase();
        if (SHARED_INSTALL_DIRS.has(relToGame)) {
          logError(`[downloader] refusing to recursively remove the shared folder ${relToGame} `
                 + `for "${mod.name}" (legacy install manifest with no file list)`);
          continue;
        }
        if (!fs.existsSync(full)) continue;
        try {
          fs.rmSync(full, { recursive: true, force: true });
          removed.push(full);
        } catch (e) {
          return { ok: false, error: `Could not remove ${rel}: ${e.message}` };
        }
      }
    }
    try { fs.rmSync(manifestPath(gamePath, mod.name), { force: true }); } catch { /* best effort */ }
  }

  const roots = [
    path.join(gamePath, 'BepInEx', 'plugins'),
    path.join(gamePath, 'BepInEx', 'plugins_disabled'),
  ];

  // RECURSIVE, to stay in step with getInstalledMods. That scanner now walks the
  // tree (because the Mods page lets users file mods into subfolders), so a flat
  // sweep here would report "is not on disk" for a mod the page is simultaneously
  // showing as installed - trading the old bug for a worse one.
  let failure = null;
  const sweep = (dir, depth) => {
    if (failure) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (failure) return;
      if (entry.name.startsWith('.')) continue;
      // Normalise the entry's bare name the same way getInstalledMods
      // does - strip `.disabled` and `.dll` (in that order) and lower-
      // case. That gives us the same key the frontend uses to decide
      // "is this installed", so a match here is guaranteed to be the
      // right item.
      const bare = bareName(entry.name).toLowerCase();
      const full = path.join(dir, entry.name);
      const nameMatches = bare === target
        && (entry.isDirectory() || /\.dll(\.disabled)?$/i.test(entry.name) || /\.disabled$/i.test(entry.name));

      // A DIRECTORY needs more than a matching name before we recursively
      // delete it.
      //
      // This sweep walks the whole plugins tree (up to depth 6) because the Mods
      // page lets people file mods into subfolders - and it used to remove ANY
      // directory whose name matched, recursively. People name their
      // organisational folders after mods, so uninstalling "Camera" from the
      // catalogue could take out a `Camera/` folder the user had created and
      // filled with other things. A name collision is not evidence of ownership,
      // and this is an unrecoverable delete.
      //
      // So: require the folder to actually CONTAIN this mod's assembly. If it
      // does not, it is somebody's folder that happens to share a name - leave
      // it alone and descend into it instead, where the real .dll will match on
      // its own terms. Files are unchanged: a `<name>.dll` IS the mod.
      let isMatch = nameMatches;
      if (nameMatches && entry.isDirectory()) {
        let holdsOurDll = false;
        try {
          holdsOurDll = fs.readdirSync(full, { withFileTypes: true }).some((c) =>
            c.isFile()
            && bareName(c.name).toLowerCase() === target
            && /\.dll(\.disabled)?$/i.test(c.name));
        } catch { holdsOurDll = false; }
        if (!holdsOurDll) {
          isMatch = false;
          logError(`[downloader] "${entry.name}" matches the mod name but holds no ${target}.dll - `
                 + 'treating it as a user folder and not deleting it');
        }
      }

      if (isMatch) {
        try {
          fs.rmSync(full, { recursive: true, force: true });
          removed.push(full);
        } catch (e) {
          // Surface the failure rather than swallowing it - a locked DLL
          // (game still holding the file) is the most likely cause and
          // the user needs to know to close Gorilla Tag.
          failure = /EBUSY|EPERM|EACCES/i.test(e.code || e.message || '')
            ? `Could not remove ${entry.name} because the file is in use. Make sure Gorilla Tag is fully closed, then try again.`
            : `Could not remove ${entry.name}: ${e.message}`;
        }
        continue; // removed (or failed); nothing left to descend into
      }
      if (entry.isDirectory() && depth < 6) sweep(full, depth + 1);
    }
  };

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    sweep(root, 0);
  }
  if (failure) return { ok: false, error: failure };

  if (!removed.length) {
    return { ok: false, error: `${mod.name} is not on disk. It may have already been removed.` };
  }

  logInfo(`[Downloader] Uninstalled ${mod.name} - removed ${removed.join(', ')}`);
  return { ok: true };
}

// The catalogue lists BepInEx as an entry so it can be installed from the page,
// but it is the loader, not a mod: it lives at the game root, removing it stops
// every other mod loading, and uninstallMod refuses it. The Download page asks
// this before deciding whether to render an uninstall control at all, so the
// two ends cannot drift into showing a button that always fails.
const isLoaderEntry = (name) => String(name || '').toLowerCase() === 'bepinex';

module.exports = {
  detectLoader, getInstalledMods, loadRegistry, installMod, updateMod, uninstallMod,
  isLoaderEntry,
};
