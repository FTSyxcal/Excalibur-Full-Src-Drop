// .gtmp mod pack format.
//
// A .gtmp is just a zip with:
//   manifest.json   - pack metadata + file manifest
//   mods/<name>     - each selected mod at the top-level (flat DLL) or as
//                     a folder (for folder mods, containing their contents)
//
// Keeping the container a plain zip means people can inspect / hand-edit
// packs with any zip tool and nothing proprietary is baked in.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { logError, logInfo } = require('./logger.cjs');

const MANIFEST_VERSION = 1;

function exportPack(modPaths, metadata, outPath) {
  const zip = new AdmZip();
  const mods = [];

  for (const modPath of modPaths) {
    if (!fs.existsSync(modPath)) {
      throw new Error(`Mod not found: ${modPath}`);
    }
    const name = path.basename(modPath);
    const stat = fs.statSync(modPath);
    if (stat.isDirectory()) {
      // addLocalFolder mirrors the folder structure under the zip path.
      zip.addLocalFolder(modPath, `mods/${name}`);
      mods.push({ name, kind: 'folder' });
    } else if (name.toLowerCase().endsWith('.dll')) {
      zip.addLocalFile(modPath, 'mods');
      mods.push({ name, kind: 'dll' });
    } else {
      // Skip anything non-DLL so packs can't smuggle random files in.
      logError(`Skipped non-DLL file during pack export: ${modPath}`);
    }
  }

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    name: metadata.name || 'Untitled Pack',
    description: metadata.description || '',
    author: metadata.author || '',
    createdAt: new Date().toISOString(),
    excaliburVersion: '1.0.0',
    mods,
  };

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.writeZip(outPath);

  logInfo(`Exported pack "${manifest.name}" with ${mods.length} mod(s) → ${outPath}`);
  return { path: outPath, manifest };
}

// Parses a .gtmp and returns the manifest + a handle for extraction.
// Throws on missing / malformed manifest.
function readPack(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Pack not found: ${filePath}`);
  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch (e) {
    throw new Error(`Could not read pack (is it a .gtmp file?): ${e.message}`);
  }
  const entry = zip.getEntry('manifest.json');
  if (!entry) throw new Error('Invalid .gtmp - missing manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(entry.getData().toString('utf8'));
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON: ${e.message}`);
  }
  if (!manifest || !Array.isArray(manifest.mods)) {
    throw new Error('manifest.json is missing the mods array');
  }
  return { manifest, zip };
}

function importPack(filePath, targetDir, options = {}) {
  const { overwrite = false } = options;
  const { manifest, zip } = readPack(filePath);

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const resolvedTarget = path.resolve(targetDir);

  const results = [];
  for (const mod of manifest.mods) {
    if (!mod || typeof mod.name !== 'string') {
      results.push({ ok: false, error: 'Malformed manifest entry' });
      continue;
    }

    // Safety: reject any name that would escape the plugins folder.
    const safe = path.basename(mod.name);
    if (safe !== mod.name) {
      results.push({ name: mod.name, ok: false, error: 'Invalid mod name' });
      continue;
    }

    const destPath = path.join(resolvedTarget, safe);
    if (!path.resolve(destPath).startsWith(resolvedTarget + path.sep)
        && path.resolve(destPath) !== resolvedTarget) {
      results.push({ name: safe, ok: false, error: 'Refused path traversal' });
      continue;
    }

    if (fs.existsSync(destPath) && !overwrite) {
      results.push({ name: safe, ok: false, error: 'Already installed', skipped: true });
      continue;
    }

    try {
      if (mod.kind === 'folder') {
        extractFolderTo(zip, `mods/${safe}/`, destPath);
        results.push({ name: safe, ok: true, kind: 'folder' });
      } else {
        const entry = zip.getEntry(`mods/${safe}`);
        if (!entry) throw new Error('Missing file in pack');
        if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
        fs.writeFileSync(destPath, entry.getData());
        results.push({ name: safe, ok: true, kind: 'dll' });
      }
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM') {
        results.push({
          name: safe,
          ok: false,
          error: `${safe} is locked - close Gorilla Tag and try again.`,
        });
      } else {
        results.push({ name: safe, ok: false, error: e.message });
      }
    }
  }

  logInfo(
    `Imported pack "${manifest.name}" - ` +
      `${results.filter((r) => r.ok).length} installed, ` +
      `${results.filter((r) => r.skipped).length} skipped, ` +
      `${results.filter((r) => !r.ok && !r.skipped).length} failed`
  );

  return { manifest, results };
}

function extractFolderTo(zip, prefix, destFolder) {
  // Clear the destination first if overwriting so stale files don't hang
  // around from a previous install.
  if (fs.existsSync(destFolder)) fs.rmSync(destFolder, { recursive: true, force: true });
  fs.mkdirSync(destFolder, { recursive: true });

  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith(prefix)) continue;
    const relative = entry.entryName.slice(prefix.length);
    if (!relative) continue;
    const dst = path.join(destFolder, relative);

    // Defensive: ensure the resolved path stays inside destFolder.
    const resolvedDst = path.resolve(dst);
    const resolvedRoot = path.resolve(destFolder);
    if (!resolvedDst.startsWith(resolvedRoot + path.sep) && resolvedDst !== resolvedRoot) {
      continue;
    }

    if (entry.isDirectory) {
      fs.mkdirSync(resolvedDst, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(resolvedDst), { recursive: true });
      fs.writeFileSync(resolvedDst, entry.getData());
    }
  }
}

// Stage a .gtmp's mods under a dedicated folder without touching the live
// plugins directory. Returns the manifest + extraction path for a caller
// that wants to wrap the pack in a profile.
function extractPackForProfile(filePath, packsBaseDir, packId) {
  const { manifest, zip } = readPack(filePath);
  const destDir = path.join(packsBaseDir, packId);
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  // Drop the manifest at the top so the pack dir is self-contained.
  fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  for (const mod of manifest.mods) {
    if (!mod || typeof mod.name !== 'string') continue;
    const safe = path.basename(mod.name);
    if (safe !== mod.name) continue;

    // `path.basename` is NOT a containment check, and this is the exact hole it
    // leaves. basename('.') === '.' and basename('..') === '..', so both pass
    // the `safe !== mod.name` test above unchanged, and then:
    //
    //   name '.'   ->  dest === destDir        (the pack folder itself)
    //   name '..'  ->  dest === packsBaseDir   (EVERY pack the user has)
    //
    // extractFolderTo() opens by rmSync(destFolder, { recursive: true }) to
    // clear stale files, so a .gtmp carrying a mod entry named ".." deleted the
    // user's entire packs directory the moment they opened it. The file is
    // shared between users, so this is reachable by anyone who can hand someone
    // a pack. Verified: path.join('<packs>/<id>', '..') === '<packs>'.
    if (safe === '.' || safe === '..' || safe === '') continue;

    const dest = path.join(destDir, safe);

    // Belt and braces: the resolved destination must sit strictly INSIDE the
    // pack folder. Catches anything the name checks above did not anticipate,
    // and costs nothing.
    const rel = path.relative(path.resolve(destDir), path.resolve(dest));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      logError('extractPackForProfile: refusing entry that escapes the pack folder:', mod.name);
      continue;
    }
    try {
      if (mod.kind === 'folder') {
        extractFolderTo(zip, `mods/${safe}/`, dest);
      } else {
        const entry = zip.getEntry(`mods/${safe}`);
        if (!entry) continue;
        fs.writeFileSync(dest, entry.getData());
      }
    } catch (e) {
      logError('extractPackForProfile failed for', safe, e);
    }
  }
  logInfo(`Staged pack "${manifest.name}" to ${destDir}`);
  return { manifest, destDir };
}

module.exports = { exportPack, readPack, importPack, extractPackForProfile };
