// Per-profile desktop shortcuts.
//
// A shortcut is a Windows .lnk on the user's desktop that points at THIS exe
// and carries `excalibur://play/<profileId>` as its argument. Double-clicking
// it wakes (or cold-starts) Excalibur, which applies that profile and launches
// Gorilla Tag. One click from the desktop into a specific modpack.
//
// Three things here are load-bearing and were each a real bug:
//
//  1. THE ARGUMENT SHAPE DIFFERS IN DEV. A packaged build's execPath IS
//     Excalibur.exe, so the URL is the only argument. In dev, execPath is
//     electron.exe, which needs the project directory BEFORE the URL or it
//     opens a blank Electron with no app in it. registerProtocolHandler() in
//     main.js already knew this; the shortcut writer did not, so every
//     shortcut made during development was silently broken.
//
//  2. OWNERSHIP IS READ BACK FROM THE .lnk, NOT INFERRED FROM ITS NAME.
//     Names change (rename a profile) and collide (two profiles called
//     "Test"). Reading each .lnk's arguments and pulling the profile id out is
//     the only identification that survives both, and it is what makes
//     "already has a shortcut", removal, and rename-cleanup correct.
//
//  3. ICON CONVERSION IS BEST-EFFORT, NEVER FATAL. A profile icon can be a
//     .webp, an animated .gif, or a file the user has since deleted. Any
//     failure falls back to the Excalibur icon, because a shortcut with the
//     wrong icon is a cosmetic problem and a shortcut that failed to be
//     created is a broken feature.
//
// Windows-only by construction. Every entry point returns a typed failure on
// other platforms rather than throwing.

const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL = 'excalibur';
const SUFFIX = ' - Excalibur';

// ── Pure helpers ────────────────────────────────────────────────────────
// Exported for electron/shortcuts.test.cjs, which runs in plain node. Nothing
// in this block may touch Electron, the filesystem, or process state.

// Characters Windows forbids in a filename, plus control characters.
//
// Spaces and hyphens are deliberately NOT in here: both are legal in a
// Windows filename, and stripping them would turn "Half-Life mods" into
// "Half Life mods" for no reason. u002f is the forward slash and u005c the
// backslash, written as escapes so the class stays readable.
// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARS = /[<>:"|?*\u002f\u005c\u0000-\u001f]/g;

// Names Windows reserves for devices. A file called `CON.lnk` cannot be
// created at all, and the error it raises says nothing about why.
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Trailing dots and spaces are dropped too: Explorer silently strips them, so
// the file we wrote and the file we later look for would disagree.
function safeShortcutName(name) {
  const cleaned = String(name ?? '')
    .replace(INVALID_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '')
    .trim();
  if (!cleaned) return 'Modpack';
  return RESERVED_DEVICE.test(cleaned) ? `${cleaned} modpack` : cleaned;
}

// "Speedrun" -> "Speedrun - Excalibur.lnk"
function shortcutFileName(name) {
  return `${safeShortcutName(name)}${SUFFIX}.lnk`;
}

function playUrl(profileId) {
  return `${PROTOCOL}://play/${encodeURIComponent(String(profileId))}`;
}

// Quote only when needed; an unconditional quote is harmless on Windows but
// makes the args string harder to read in the shortcut properties dialog.
function quoteArg(a) {
  return /[\s"]/.test(String(a)) ? `"${String(a)}"` : String(a);
}

// The full argument string for the .lnk. See note 1 at the top of this file:
// dev needs the app directory before the URL, packaged must NOT have it.
function buildShortcutArgs({ profileId, appPath, isPackaged }) {
  const url = playUrl(profileId);
  if (isPackaged || !appPath) return url;
  return `${quoteArg(appPath)} ${url}`;
}

// Sizes Explorer picks between. 256 is what the large-icon views use; 16 is
// the one in the taskbar and the shortcut properties dialog.
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

// Assemble a Windows .ico from one PNG per size.
//
// This is hand-rolled rather than delegated to the `png-to-ico` package, which
// was the first attempt and does not work here: that package is ESM-only, and
// Electron 31's bundled Node cannot `require()` an ES module. It threw
// ERR_REQUIRE_ESM inside the icon try/catch, which swallowed it, so every
// shortcut silently fell back to the Excalibur icon and the feature looked
// like it worked. Plain Node 22+ CAN require ESM, so it passed outside
// Electron - the failure only existed in the app.
//
// The format is small enough not to be worth a dependency: a 6-byte header, a
// 16-byte directory entry per image, then the image data. Windows Vista and
// later read PNG-compressed entries at any size, which is what nativeImage
// hands us, so no BMP encoding is needed.
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);        // reserved
  header.writeUInt16LE(1, 2);        // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  images.forEach((img, i) => {
    const b = i * 16;
    // 256 is stored as 0: the field is one byte and 256 does not fit.
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, b + 0);
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, b + 1);
    dir.writeUInt8(0, b + 2);        // palette size (0 = truecolour)
    dir.writeUInt8(0, b + 3);        // reserved
    dir.writeUInt16LE(1, b + 4);     // colour planes
    dir.writeUInt16LE(32, b + 6);    // bits per pixel
    dir.writeUInt32LE(img.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

// Pull the profile id back out of a .lnk's argument string. Returns null for
// anything that is not one of our play shortcuts, which is how we ignore every
// other icon on the desktop (including Excalibur's own launcher shortcut).
function parseProfileIdFromArgs(args) {
  if (typeof args !== 'string' || !args) return null;
  const m = args.match(/excalibur:\/\/play\/([^\s"]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).trim() || null;
  } catch {
    return m[1].trim() || null;
  }
}

// ── Electron-backed implementation ──────────────────────────────────────
// Required lazily so the pure helpers above stay importable from plain node.

function electron() {
  // eslint-disable-next-line global-require
  return require('electron');
}

function isWindows() {
  return process.platform === 'win32';
}

function desktopDir() {
  return electron().app.getPath('desktop');
}

// Every .lnk on the desktop that is one of ours, as { profileId, file }.
// Unreadable entries are skipped rather than failing the sweep: one corrupt
// shortcut belonging to something else must not stop us reporting the rest.
function listProfileShortcuts() {
  if (!isWindows()) return [];
  const { shell } = electron();
  let dir;
  try { dir = desktopDir(); } catch { return []; }
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lnk'));
  } catch { return []; }

  const found = [];
  for (const f of entries) {
    const file = path.join(dir, f);
    try {
      const profileId = parseProfileIdFromArgs(shell.readShortcutLink(file)?.args);
      if (profileId) found.push({ profileId, file });
    } catch { /* not readable, or not a shortcut we care about */ }
  }
  return found;
}

// Turn a profile's custom image into an .ico stored with our other app data.
// Returns an absolute .ico path, or null meaning "use the Excalibur icon".
//
// Cached on the source file's mtime, so picking a new profile icon produces a
// new .ico while re-creating a shortcut with an unchanged icon costs nothing.
async function ensureIcoFor(profileId, iconPath) {
  if (!iconPath) return null;
  try {
    if (!fs.existsSync(iconPath)) return null;
    const { app, nativeImage } = electron();
    const stat = fs.statSync(iconPath);
    const safeId = String(profileId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(app.getPath('userData'), 'shortcut-icons');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${safeId}-${Math.round(stat.mtimeMs)}.ico`);
    if (fs.existsSync(out)) return out;

    // nativeImage reads png/jpg/webp with no dependency of ours. An animated
    // gif decodes to its first frame, which is what an icon wants anyway, and
    // an unreadable file yields an empty image rather than throwing.
    const img = nativeImage.createFromPath(iconPath);
    if (!img || img.isEmpty()) return null;

    // One PNG per size, all downscaled from the source. Explorer picks the
    // nearest and scales it; giving it exact sizes is what keeps the small
    // ones legible instead of a mushy resample of the 256.
    const images = [];
    for (const size of ICO_SIZES) {
      const png = img.resize({ width: size, height: size, quality: 'best' }).toPNG();
      if (png && png.length) images.push({ size, png });
    }
    if (!images.length) return null;
    fs.writeFileSync(out, buildIco(images));

    // Drop older .ico files for this profile so the folder does not grow every
    // time the user changes their icon.
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`${safeId}-`) && f !== path.basename(out)) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    } catch { /* housekeeping only */ }

    return out;
  } catch {
    // See note 3: an icon problem must never cost the user their shortcut.
    return null;
  }
}

// Pick a filename that does not belong to a DIFFERENT profile. Reusing our own
// is correct (re-creating updates it in place); taking another profile's is not.
function freeShortcutPath(dir, name, profileId) {
  const { shell } = electron();
  const base = safeShortcutName(name);
  for (let i = 0; i < 50; i++) {
    const file = path.join(dir, i === 0 ? `${base}${SUFFIX}.lnk` : `${base} (${i + 1})${SUFFIX}.lnk`);
    if (!fs.existsSync(file)) return file;
    try {
      if (parseProfileIdFromArgs(shell.readShortcutLink(file)?.args) === profileId) return file;
    } catch { /* unreadable - treat as taken and try the next name */ }
  }
  return path.join(dir, `${base}-${Date.now()}${SUFFIX}.lnk`);
}

async function createProfileShortcut({ profileId, name, iconPath } = {}) {
  if (!isWindows()) throw new Error('Desktop shortcuts are only supported on Windows.');
  if (!profileId) throw new Error('Missing profile id.');
  const { app, shell } = electron();

  const dir = desktopDir();
  fs.mkdirSync(dir, { recursive: true });

  // Any shortcut this profile already owns, whatever it is called now.
  const previous = listProfileShortcuts().filter((s) => s.profileId === String(profileId));
  const file = freeShortcutPath(dir, name, String(profileId));

  const icon = await ensureIcoFor(profileId, iconPath);
  const args = buildShortcutArgs({
    profileId,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  });

  const wrote = shell.writeShortcutLink(file, 'create', {
    target: process.execPath,
    args,
    // cwd matters in dev: electron.exe resolves a relative app path against it.
    cwd: path.dirname(process.execPath),
    description: `Play ${safeShortcutName(name)} in Gorilla Tag with Excalibur`,
    icon: icon || process.execPath,
    iconIndex: 0,
  });
  if (!wrote) throw new Error('Windows refused to write the shortcut file.');

  // Renamed profile: remove the .lnk carrying the old name so the user is not
  // left with two icons that do the same thing.
  for (const stale of previous) {
    if (path.resolve(stale.file) !== path.resolve(file)) {
      try { fs.unlinkSync(stale.file); } catch { /* leave it if it will not go */ }
    }
  }

  return { path: file, icon: icon || null, usedProfileIcon: !!icon };
}

function removeProfileShortcut(profileId) {
  if (!isWindows()) return { removed: 0 };
  let removed = 0;
  for (const s of listProfileShortcuts()) {
    if (s.profileId !== String(profileId)) continue;
    try { fs.unlinkSync(s.file); removed++; } catch { /* in use, or already gone */ }
  }
  return { removed };
}

// Which profiles currently have a shortcut, as a plain map the renderer can
// hold in state: { [profileId]: '<path>' }.
function shortcutStatus() {
  const map = {};
  for (const s of listProfileShortcuts()) {
    if (!map[s.profileId]) map[s.profileId] = s.file;
  }
  return map;
}

module.exports = {
  PROTOCOL,
  SUFFIX,
  safeShortcutName,
  shortcutFileName,
  playUrl,
  buildShortcutArgs,
  parseProfileIdFromArgs,
  buildIco,
  ICO_SIZES,
  listProfileShortcuts,
  createProfileShortcut,
  removeProfileShortcut,
  shortcutStatus,
  ensureIcoFor,
};
