'use strict';

// Serves and deploys the built-in Excalibur mod.
//
// NOTHING Excalibur is written to BepInEx/plugins. The bootstrap is a BepInEx
// PATCHER (BepInEx/patchers/Excalibur.Patcher.dll) - the only Excalibur file on
// disk in the game folder. It hooks onto the Unity main thread and streams the
// real core in memory. Layout:
//   - Encrypted core (electron/payload/excalibur-core.pae) ships inside the app,
//     streamed over the local bridge at launch, decrypted + loaded in memory -
//     never on disk in the game folder.
//   - Patcher + public dependency DLLs + fonts (electron/payload/mod-stage/) are
//     split at deploy: the patcher → BepInEx/patchers, deps + fonts → the app's
//     own runtime data dir (mod-runtime), NOT the game folder.
//
// scripts/build-mod.mjs produces those artifacts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { logInfo, logError, getWritableBaseDir } = require('./logger.cjs');

// electron/payload/ is inside electron/, so it is bundled by both
// electron-packager (not in the --ignore list) and electron-builder
// (files: ["electron/**/*"]). __dirname resolves correctly in dev and in the
// packaged asar.
function payloadDir()   { return path.join(__dirname, 'payload'); }
function corePaePath()  { return path.join(payloadDir(), 'excalibur-core.pae'); }
function modStage()     { return path.join(payloadDir(), 'mod-stage'); }

// The app's own writable data dir where the mod's public dependency DLLs + fonts
// are deployed - deliberately OUTSIDE the game folder. Nothing Excalibur sits in
// BepInEx/plugins; the only on-disk game-folder file is the patcher, in
// BepInEx/patchers. Same base as bridge.token (which the C# bootstrap reads), so
// the two agree on the location.
function runtimeDir()   { return path.join(getWritableBaseDir(), 'mod-runtime'); }

// The BepInEx patcher - the ONLY Excalibur file on disk in the game folder,
// deployed to BepInEx/patchers. Everything else in the stage (deps + fonts) goes
// to the app runtime dir.
const PATCHER_FILE = /^Excalibur\.Patcher\./i;

// The encrypted core bytes to stream to the loader. Returns null if the mod
// hasn't been built (dev tree without `npm run build:mod`).
function readEncryptedCore() {
  const p = corePaePath();
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  } catch (e) {
    logError('[ModPayload] failed to read core payload:', e.message);
    return null;
  }
}

// The build's signature over the DECRYPTED core, from the manifest written
// beside the .pae by scripts/build-mod.mjs. Returns null when the mod was built
// without a signing key (a dev build) - the patcher decides what to do about
// that, this just reports the truth rather than inventing a value.
function coreManifestPath() { return path.join(payloadDir(), 'excalibur-core.manifest.json'); }

function readCoreManifest() {
  try {
    const p = coreManifestPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // A malformed manifest must not stop the mod loading on a dev machine; it
    // degrades to "unsigned", which is visible in the log line above.
    logError('[ModPayload] could not read core manifest:', e.message);
    return null;
  }
}

function readCoreSignature() {
  const man = readCoreManifest();
  const core = (man?.assemblies || []).find((a) => a.name === 'Excalibur.Core');
  return core?.signature || null;
}

// ── The paid halves ─────────────────────────────────────────────────────────
//
// Excalibur.Pro and Excalibur.ProPlus are NOT in this app. They are not in the
// installer, not in app.asar, not on disk anywhere. They are fetched from the
// server at launch, against the account's LIVE tier, and held in memory for as
// long as the game session needs them.
//
// That last part is the whole point and it is worth being explicit about: if
// these were ever written to disk, "subscribe for one month, keep the files
// forever" would work, and the split would have bought nothing over the old
// RequiredTier check. So there is deliberately no cache file, no temp file, and
// no "just for debugging" dump path in this module.
//
// A memory cache with a short TTL does exist, and it is not the same thing. The
// patcher retries its fetch on a backoff (a lost socket race, the game booting
// before the app finished starting), and each retry would otherwise be a fresh
// round trip carrying ~300 KB. The TTL is short enough that a genuinely new
// launch re-asks the server - which is what makes a cancelled subscription stop
// working at the next launch rather than at the next app restart.
const TIER_API_URL = process.env.MOD_CORE_API_URL || 'https://excaliburgtag.com/api/mod-core';
const TIER_CACHE_MS = 10 * 60 * 1000;
// An EMPTY answer is cached far more briefly. "You are free tier" is sometimes
// a lie with a short half-life - a Stripe webhook that has not landed yet, a
// tier RPC blip the server's own retry did not cover - and the old shared TTL
// meant one such answer stuck for 10 minutes of relaunches. A real free
// account costs one extra round trip per minute; a mis-answered paying
// customer stops losing whole sessions to it.
const TIER_EMPTY_CACHE_MS = 60 * 1000;
// Per-attempt budget. The PATCHER waits 40 s for the whole payload_response,
// so the total spent here (attempts x timeout + backoffs, plus the peer check
// in main.js) must stay comfortably inside that: 3 x 8 s + (1.5 + 3) s = 28.5 s
// worst case. The old shape was ONE attempt at 12 s - a single lost packet
// exchange or slow link, and a paying customer ran free for the whole session,
// because nothing on any side ever asks again once the core boots.
const TIER_TIMEOUT_MS = 8_000;
const TIER_FETCH_ATTEMPTS = 3;
const TIER_RETRY_DELAYS_MS = [1_500, 3_000];

let _tierCache = null;   // { forToken, at, assemblies:[{name,dataBase64,signature,sha256,size}] }

// The last "R2 is serving a different build than this checkout" result, so the
// UI can say it out loud. A log line was not enough: the paid assemblies are
// fetched during a GAME LAUNCH, when nobody is reading modmanager.log, and the
// older payloads in R2 are still validly signed - so the patcher accepts them
// and the stale build just quietly misbehaves. That cost a whole evening of
// testing a wheel fix that was never in the game.
//
// null means "checked, and they agree" as well as "not checked yet"; the UI
// only ever reacts to a non-null value, so the two are the same to it.
let _paidBuildMismatch = null;

function getPaidBuildMismatch() { return _paidBuildMismatch; }

function clearTierCache() { _tierCache = null; }

// Returns [] for a free account, for a signed-out app, and for any failure.
//
// FAILING TO [] IS DELIBERATE. The alternative - refusing to serve the payload
// at all when the server is unreachable - would mean a Cloudflare blip stops
// every user launching the game with any Excalibur at all. The free core is
// already on disk, so the honest degraded state is "you get the free mod this
// launch", which is also exactly what happens when the player is offline. The
// owner accepted online-required for the PAID half specifically, not for the
// whole mod.
// ── DEV: serve the LOCAL build, with no setup whatsoever ────────────────────
//
// `npm run build:mod` writes dist-tier-payloads/, and until now NOTHING under
// electron/ ever read it - the paid assemblies were always fetched from R2. So
// a developer who rebuilt the mod and relaunched silently got their PREVIOUS
// build, because the older payload in R2 is still validly signed and the
// patcher accepts it. Nothing fails, nothing warns in the game, and the change
// you just made simply is not there. That cost a full evening.
//
// The env-var route (MOD_CORE_API_URL + scripts/dev-mod-core-server.mjs) has
// existed for a while and is not good enough: it only applies to a process
// launched from the one terminal that exported it, so launching the app any
// other way silently goes back to R2. Dev testing has to work by default or it
// does not work at all.
//
// THIS IS NOT A NEW TRUST HOLE. It reads the SAME encrypted, SIGNED .pae bytes
// the dev server already served over HTTP, and the patcher still verifies the
// real signature on every byte it loads - an unsigned local build is refused
// here exactly as it would be from R2. It is gated on app.isPackaged === false
// AND the directory existing, and verify-package.cjs bans dist-tier-payloads/
// from the installer, so a shipped build cannot reach this path.
const TIER_FILES = {
  'Excalibur.Pro':     'excalibur-pro.pae',
  'Excalibur.ProPlus': 'excalibur-proplus.pae',
};

function readLocalTierAssemblies() {
  try {
    // Absent or throwing outside a real Electron main process - treat as
    // packaged, i.e. take the safe path and use the network.
    if (require('electron').app.isPackaged !== false) return null;
  } catch { return null; }
  try {
    const dir = path.join(__dirname, '..', 'dist-tier-payloads');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'tier-manifest.json'), 'utf8'));
    const out = [];
    for (const meta of manifest.assemblies || []) {
      const file = TIER_FILES[meta.name];
      if (!file) continue;            // the free core never travels this path
      if (!meta.signature) continue;  // the patcher would refuse it anyway
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) continue;
      out.push({
        name:       meta.name,
        tier:       meta.tier,
        sha256:     meta.sha256,
        size:       meta.size,
        signature:  meta.signature,
        dataBase64: fs.readFileSync(p).toString('base64'),
      });
    }
    return out.length ? { assemblies: out, builtAt: manifest.builtAt } : null;
  } catch { return null; }
}

async function fetchTierAssemblies(token) {
  // Before the token check on purpose: in dev the local build is the truth
  // regardless of what the server would say this account is entitled to, which
  // is the entire point of a dev box.
  const local = readLocalTierAssemblies();
  if (local) {
    // Running the local build, so there is nothing stale to warn about.
    _paidBuildMismatch = null;
    logInfo(`[ModPayload] DEV: serving ${local.assemblies.length} paid assembl`
          + `${local.assemblies.length === 1 ? 'y' : 'ies'} from dist-tier-payloads/ `
          + `(${local.assemblies.map((a) => a.name).join(', ')}) built ${local.builtAt || 'unknown'}. `
          + 'R2 not consulted - this is your local `npm run build:mod` output.');
    return local.assemblies;
  }

  if (!token) {
    // SAY SO. This used to be a bare `return []` - the single most silent way
    // a paying customer lost their paid features. An expired 7-day token at
    // game-launch time produced zero evidence anywhere that paid was even
    // skipped.
    logError('[ModPayload] no fresh auth token at payload time - the paid assemblies were NOT '
           + 'requested. If this account has a paid tier, sign in again in the app.');
    return [];
  }

  const now = Date.now();
  if (_tierCache && _tierCache.forToken === token) {
    const age = now - _tierCache.at;
    const ttl = _tierCache.assemblies.length ? TIER_CACHE_MS : TIER_EMPTY_CACHE_MS;
    if (age < ttl) {
      // SAY SO. A silent cache hit is indistinguishable from a fresh download in
      // the log, which is precisely how stale assemblies went unnoticed through
      // a whole evening of "publish, relaunch, looks identical".
      logInfo(`[ModPayload] reusing the paid assemblies cached ${Math.round(age / 1000)}s ago`
            + ' (cleared when the game exits)');
      return _tierCache.assemblies;
    }
  }

  // The server prefers the payload set built together with THIS app's core, so
  // a not-yet-updated install keeps receiving assemblies that match what it
  // actually runs, instead of whatever was published most recently.
  const coreBuiltAt = readCoreManifest()?.builtAt || undefined;

  // One attempt. Returns the response, or throws for the retry loop below.
  const attemptFetch = async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIER_TIMEOUT_MS);
    try {
      return await fetch(TIER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ coreBuiltAt }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let res = null;
    for (let attempt = 1; attempt <= TIER_FETCH_ATTEMPTS; attempt++) {
      try {
        res = await attemptFetch();
        // 5xx is the server (or its database) having a moment, and one moment
        // used to cost the whole game session - nothing on any side re-asks
        // once the core boots. Anything else is a real answer; take it.
        if (res.status < 500) break;
        logError(`[ModPayload] tier payload request got HTTP ${res.status}`
               + (attempt < TIER_FETCH_ATTEMPTS ? ' - retrying' : ''));
      } catch (e) {
        res = null;
        logError('[ModPayload] tier payload attempt failed:',
                 e.name === 'AbortError' ? `timed out after ${TIER_TIMEOUT_MS} ms` : e.message,
                 attempt < TIER_FETCH_ATTEMPTS ? '- retrying' : '');
      }
      if (attempt < TIER_FETCH_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, TIER_RETRY_DELAYS_MS[attempt - 1] || 3_000));
      }
    }
    if (!res) return [];
    if (!res.ok) {
      // 401 is not an error worth shouting about - it is a signed-out or expired
      // session, and the auth layer handles that on its own schedule.
      if (res.status !== 401) {
        logError(`[ModPayload] tier payload request failed: HTTP ${res.status}`);
      }
      return [];
    }
    const body = await res.json();
    const list = Array.isArray(body?.assemblies) ? body.assemblies : [];
    const usable = list.filter((a) => a && a.name && a.dataBase64);
    _tierCache = { forToken: token, at: now, assemblies: usable };
    // builtAt is in this line ON PURPOSE. Without it there is no way to tell a
    // freshly published assembly from a stale one, and a ten-minute memory
    // cache once made several test launches silently run the previous build.
    logInfo(`[ModPayload] tier=${body?.tier || '?'} → ${usable.length} paid assembl${usable.length === 1 ? 'y' : 'ies'}`
          + (usable.length ? ` (${usable.map((a) => a.name).join(', ')})` : '')
          + ` built ${body?.builtAt || 'unknown'}`);

    // "You forgot to run `npm run mod:publish`" has to be a line somebody can
    // read, because otherwise it is invisible: the older payloads in R2 are
    // still validly signed, so the patcher accepts them, and a Pro assembly
    // built against a previous core just quietly misbehaves. The build stamps
    // the same builtAt into the local manifest and the published one, so a
    // mismatch means exactly one thing.
    try {
      const local = readCoreManifest();
      if (local?.builtAt && body?.builtAt && local.builtAt !== body.builtAt) {
        logError('[ModPayload] the paid assemblies in R2 are from a DIFFERENT build than this app '
               + `(server ${body.builtAt}, app ${local.builtAt}). `
               + 'Run `npm run mod:publish` after a mod build, or paid features may misbehave.');
        _paidBuildMismatch = { serverBuiltAt: body.builtAt, appBuiltAt: local.builtAt };
      } else {
        // Clear on agreement, so publishing (or pointing at the dev server)
        // makes the warning go away on the very next launch rather than
        // sticking around until the app restarts.
        _paidBuildMismatch = null;
      }
    } catch { /* diagnostic only */ }
    return usable;
  } catch (e) {
    // Only body parsing can land here now - each attempt's own errors are
    // caught (and retried) inside the loop above.
    logError('[ModPayload] could not read the tier payload response:', e.message);
    return [];
  }
}

function hasBuiltMod() {
  try {
    const dir = modStage();
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => PATCHER_FILE.test(f));
  } catch {
    return false;
  }
}

// True for the real core assembly (Excalibur.dll) OR any renamed variant of it
// (Excalibur.dll.old, .dll.disabled, .dll.bak, ...) and its pdb/deps sidecars.
// The loader stub is "Excalibur.Loader.*" and public deps are "DiscordRPC.dll"
// etc., NONE of which match - so those are always preserved. Renamed variants
// matter: BepInEx ignores a non-".dll" file, but a user could rename one back to
// ".dll", and a pre-loader core still carried [BepInPlugin] so it would then
// chainload outside Excalibur - exactly the "load without the app" hole we close.
function isCoreArtifact(name) {
  return /^Excalibur\.dll(\..+)?$/i.test(name)   // Excalibur.dll + any .suffix variant
      || /^Excalibur\.pdb$/i.test(name)
      || /^Excalibur\.deps\.json$/i.test(name);
}

// Remove the valuable core assembly from anywhere it might sit on disk in the
// game folder - an old on-disk build, a renamed leftover, or a copy a user
// dropped in trying to sideload. The loader stub + public deps + fonts are left
// untouched. Scans (not a fixed path list) so renamed variants can't slip past.
function sweepCore(gamePath) {
  if (!gamePath) return;
  const dirs = [
    path.join(gamePath, 'BepInEx', 'plugins'),
    path.join(gamePath, 'BepInEx', 'plugins', 'Excalibur'),
    path.join(gamePath, 'BepInEx', 'plugins_disabled'),
    path.join(gamePath, 'BepInEx', 'plugins_disabled', 'Excalibur'),
  ];
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !isCoreArtifact(e.name)) continue;
      const full = path.join(dir, e.name);
      try { fs.unlinkSync(full); logInfo('[ModPayload] swept core artifact:', full); }
      catch (err) { logError('[ModPayload] could not sweep', full, '-', err.message); }
    }
  }
}

// Luma's assets used to be staged into mod-runtime for EVERY account (see the
// note where stageLumaBundle used to live in scripts/build-mod.mjs). luma-looks
// is pro_plus, so that was the shader bundle for a paid feature sitting on free
// machines; the bundle and its default settings are embedded in
// Excalibur.ProPlus now and are never written to disk.
//
// Stopping the staging only fixes NEW installs. Anyone who ran an Excalibur
// build between 2026-07-31 and 2026-08-12 still has the files, so remove them
// here. This runs on every deploy, is cheap (three unlink attempts on paths that
// will not exist after the first run) and is safe to keep indefinitely.
//
// SCOPE, deliberately narrow:
//   - ONLY the app's own mod-runtime dir. A standalone Luma Looks install under
//     BepInEx/plugins/LumaLooks is the user's separate mod and is left alone.
//   - NEVER BepInEx/config/LumaLooks/settings.json. That is the player's own
//     tuning, and deleting it would silently reset the look of a paying user
//     who has spent time on it.
const STALE_LUMA_FILES = ['lumalooks.bundle', 'default-settings.json', 'luma-presets.json'];

function sweepLumaAssets() {
  let removed = 0;
  for (const name of STALE_LUMA_FILES) {
    const full = path.join(runtimeDir(), name);
    try {
      if (!fs.existsSync(full)) continue;
      fs.unlinkSync(full);
      removed++;
      logInfo('[ModPayload] swept stale Luma asset:', full);
    } catch (e) {
      // Not fatal. A locked file means the player keeps a stale copy of an asset
      // that is now inert (nothing reads mod-runtime for it unless the ProPlus
      // assembly was delivered anyway) - not a reason to fail a game launch.
      logError('[ModPayload] could not sweep', full, '-', e.message);
    }
  }
  return removed;
}

// Camera screenshots used to be written to plugins/excalibur-camera (and got
// renamed to .backup-* folders). Those are the user's photos, so we MOVE them to
// Pictures\Excalibur Camera (where new shots go now) rather than delete, then
// remove the empty folder from plugins. Never deletes a folder that still holds
// un-moved photos.
function migrateCameraShots(gamePath) {
  const picturesBase = path.join(os.homedir(), 'Pictures', 'Excalibur Camera');
  const re = /^excalibur-camera(\..*)?$/i;
  const roots = [
    path.join(gamePath, 'BepInEx', 'plugins'),
    path.join(gamePath, 'BepInEx', 'plugins_disabled'),
  ];
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !re.test(e.name)) continue;
      const srcDir = path.join(root, e.name);
      try {
        let moved = 0, failed = 0;
        const files = fs.readdirSync(srcDir);
        if (files.length) fs.mkdirSync(picturesBase, { recursive: true });
        for (const f of files) {
          const from = path.join(srcDir, f);
          let to = path.join(picturesBase, f);
          // Avoid clobbering an existing shot of the same name.
          if (fs.existsSync(to)) {
            const ext = path.extname(f);
            to = path.join(picturesBase, `${path.basename(f, ext)}-${e.name}${ext}`);
          }
          try {
            try { fs.renameSync(from, to); }
            catch { fs.copyFileSync(from, to); fs.unlinkSync(from); }  // cross-volume fallback
            moved++;
          } catch { failed++; }
        }
        // Only remove the folder if nothing was left behind.
        if (failed === 0) {
          fs.rmSync(srcDir, { recursive: true, force: true });
          logInfo(`[ModPayload] moved ${moved} camera shot(s) out of plugins → ${picturesBase}, removed ${e.name}`);
        } else {
          logError(`[ModPayload] left ${e.name} in plugins - ${failed} shot(s) could not be moved`);
        }
      } catch (err) { logError('[ModPayload] camera-shot migration failed for', e.name, '-', err.message); }
    }
  }
}

// Migration: nothing Excalibur belongs in BepInEx/plugins anymore, so remove the
// whole old plugins/Excalibur folder (stub + deps + fonts from prior versions),
// relocate any camera-shot folders, and drop any loose font at the plugins /
// plugins_disabled roots.
function cleanPluginFolder(gamePath) {
  const oldFolder = path.join(gamePath, 'BepInEx', 'plugins', 'Excalibur');
  try {
    if (fs.existsSync(oldFolder)) {
      fs.rmSync(oldFolder, { recursive: true, force: true });
      logInfo('[ModPayload] removed old plugins/Excalibur folder');
    }
  } catch (e) { logError('[ModPayload] could not remove old plugins/Excalibur:', e.message); }

  migrateCameraShots(gamePath);

  const looseNames = ['gorilla-tag-font.otf', 'excalibur-title.ttf'];
  const roots = [
    path.join(gamePath, 'BepInEx', 'plugins'),
    path.join(gamePath, 'BepInEx', 'plugins_disabled'),
  ];
  for (const root of roots) {
    for (const n of looseNames) {
      const p = path.join(root, n);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) { fs.unlinkSync(p); logInfo('[ModPayload] removed loose mod asset:', p); } } catch {}
    }
  }
}

// Deploy the mod for launch. NOTHING Excalibur lands in BepInEx/plugins: the
// bootstrap is a BepInEx patcher in BepInEx/patchers (BepInEx can only load from
// disk, and patchers is not the plugins folder). Its public dependency DLLs +
// fonts go to the app's own runtime dir, and the encrypted core is never on disk
// at all - it streams in memory. No-op when the payload hasn't been built.
function deployPatcher(gamePath) {
  if (!gamePath) return { ok: false, error: 'no game path' };
  const bepinex = path.join(gamePath, 'BepInEx');
  if (!fs.existsSync(bepinex)) return { ok: false, error: 'BepInEx not installed' };

  // Strip any on-disk core + old plugins-folder leftovers FIRST, unconditionally.
  sweepCore(gamePath);
  cleanPluginFolder(gamePath);
  // Same idea, for the paid Luma assets earlier builds staged to mod-runtime.
  sweepLumaAssets();

  if (!hasBuiltMod()) {
    // Nothing to install (unbuilt dev tree, or a quarantined/corrupt payload).
    return { ok: false, error: 'mod payload not built' };
  }

  const src = modStage();
  const patcherDest = path.join(bepinex, 'patchers');
  const runtimeDest = runtimeDir();
  const failed = [];
  try {
    fs.mkdirSync(patcherDest, { recursive: true });
    fs.mkdirSync(runtimeDest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      // Patcher → BepInEx/patchers; everything else (deps + fonts) → app runtime.
      const dest = PATCHER_FILE.test(name) ? patcherDest : runtimeDest;
      const target = path.join(dest, name);
      const source = path.join(src, name);
      // SKIP WHAT IS ALREADY THERE. This runs on the main process while the
      // user is pressing Play, and the stage is ~40 files including 28 fonts
      // and a 379 KB shader bundle - copying all of it every launch froze the
      // window for seconds on a fast PC. Size + mtime is the same check every
      // build tool uses for this, and the files are build output: they only
      // differ when the mod was actually rebuilt.
      try {
        const a = fs.statSync(source);
        const b = fs.statSync(target);
        if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000) continue;
      } catch { /* missing target (or unreadable) - fall through and copy */ }
      try {
        fs.copyFileSync(source, target);
        // Carry the source mtime across so the next launch can tell they match.
        try { fs.utimesSync(target, fs.statSync(source).atime, fs.statSync(source).mtime); } catch { }
      } catch (e) {
        // A read-only target (fonts copied from a read-only source keep the
        // bit) throws EPERM and used to abort the whole deploy. Clear the
        // attribute and retry; only a second failure is fatal.
        try {
          if (fs.existsSync(target)) fs.chmodSync(target, 0o666);
          fs.copyFileSync(source, target);
          try { fs.utimesSync(target, fs.statSync(source).atime, fs.statSync(source).mtime); } catch { }
        } catch (e2) {
          failed.push(`${name}: ${e2.message}`);
        }
      }
    }
  } catch (e) {
    logError('[ModPayload] deploy failed:', e.message);
    return { ok: false, error: e.message };
  }

  if (failed.length) {
    logError('[ModPayload] some mod files failed to deploy:', failed.join('; '));
    return { ok: false, error: `Could not deploy: ${failed.join('; ')}` };
  }
  logInfo('[ModPayload] deployed patcher to', patcherDest, '| runtime assets to', runtimeDest);
  return { ok: true };
}

// Remove the patcher from BepInEx/patchers so a plain Steam launch (game closed,
// or launched without Excalibur) loads NOTHING Excalibur - BepInEx has nothing
// of ours to pick up. Called when the game closes and on app quit. The patcher
// is re-deployed by deployPatcher on the next launch through Excalibur. The
// inert deps in the app data dir are left alone (they never load without it).
function removePatcher(gamePath) {
  if (!gamePath) return;
  const dir = path.join(gamePath, 'BepInEx', 'patchers');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isFile() || !PATCHER_FILE.test(e.name)) continue;
    try { fs.unlinkSync(path.join(dir, e.name)); logInfo('[ModPayload] removed patcher (idle):', e.name); }
    catch (err) { logError('[ModPayload] could not remove patcher', e.name, '-', err.message); }
  }
}

module.exports = {
  readEncryptedCore, readCoreSignature, readCoreManifest,
  fetchTierAssemblies, clearTierCache, getPaidBuildMismatch,
  deployPatcher, removePatcher, sweepCore, sweepLumaAssets, isCoreArtifact, cleanPluginFolder,
  hasBuiltMod, payloadDir, runtimeDir,
};
