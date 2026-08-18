// Steam detection + game launching.
//
// Detection strategy:
//   1. Read HKCU\Software\Valve\Steam\SteamPath from the registry via `reg query`.
//      This is more reliable than probing fixed paths and survives non-default
//      installs.
//   2. Parse <steam>\steamapps\libraryfolders.vdf to enumerate every Steam
//      library the user has configured (Steam stores games across multiple
//      drives for most users).
//   3. For each library, check steamapps\common\Gorilla Tag. We also scan
//      libraries' "apps" array for app ID 1533390 so we only consider
//      libraries that actually claim to own the game.
//
// Launching:
//   Launch the game EXE inside the user's SELECTED game folder directly. We used
//   to hand off to Steam (`steam.exe -applaunch <appid>`), but Steam always runs
//   whichever copy IT has registered - so if the user pointed Excalibur at a
//   different Gorilla Tag folder, Steam silently launched a different install and
//   none of their mods loaded. Launching the exe ourselves guarantees the folder
//   the user picked is the folder that actually runs.

const { execFileSync, execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logInfo, logError } = require('./logger.cjs');

const GORILLA_TAG_APP_ID = '1533390';
const GORILLA_TAG_FOLDER_NAME = 'Gorilla Tag';
const GORILLA_TAG_EXE = 'Gorilla Tag.exe';
const STEAM_APPID_FILE = 'steam_appid.txt';

function getSteamPathFromRegistry() {
  try {
    // `reg query` returns parseable text. The relevant line looks like:
    //     SteamPath    REG_SZ    C:/Program Files (x86)/Steam
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8' }
    );
    const match = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (!match) return null;
    // Steam stores this with forward slashes; normalize.
    return path.normalize(match[1].trim());
  } catch (e) {
    logError('Registry read failed:', e);
    return null;
  }
}

// Minimal VDF (Valve's config format) parser. We don't need full fidelity -
// we just want the list of library path values and their app arrays. This
// handles the top-level "libraryfolders" block that Steam writes today.
function parseLibraryFoldersVdf(vdfText) {
  // Brace-COUNTING, not a lazy regex.
  //
  // The old block matcher was lazy up to the first newline-then-brace, and every
  // library block contains a nested "apps" sub-block whose closing brace IS that
  // first one. So the captured body was truncated right there, and the follow-up
  // match for the apps block then had no closing brace to find. Result: paths
  // parsed fine and `apps` came back EMPTY for every library, always - so the
  // "is Gorilla Tag installed in this library" signal silently never fired.
  // Verified against a realistic libraryfolders.vdf before this rewrite, and
  // covered by electron/steam-vdf.test.cjs.
  //
  // Nested blocks cannot be matched by one regex; counting braces is the
  // smallest thing that is actually correct.
  const libraries = [];
  const headerRe = /"(\d+)"\s*\{/g;
  let m;
  while ((m = headerRe.exec(vdfText)) !== null) {
    // Walk from this opening brace to its matching close.
    let depth = 1;
    let i = m.index + m[0].length;
    const bodyStart = i;
    while (i < vdfText.length && depth > 0) {
      const ch = vdfText[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth !== 0) break;             // malformed file: stop rather than guess
    const body = vdfText.slice(bodyStart, i - 1);
    headerRe.lastIndex = i;             // resume AFTER this whole block

    const pathMatch = body.match(/"path"\s+"([^"]+)"/i);
    if (!pathMatch) continue;
    const libPath = pathMatch[1].replace(/\\\\/g, '\\');

    // Same treatment for the nested apps block.
    const apps = [];
    const appsHeader = body.match(/"apps"\s*\{/i);
    if (appsHeader) {
      let d = 1;
      let j = appsHeader.index + appsHeader[0].length;
      const appsStart = j;
      while (j < body.length && d > 0) {
        const ch = body[j];
        if (ch === '{') d++;
        else if (ch === '}') d--;
        j++;
      }
      if (d === 0) {
        const appsBody = body.slice(appsStart, j - 1);
        const appRe = /"(\d+)"\s+"\d+"/g;
        let a;
        while ((a = appRe.exec(appsBody)) !== null) apps.push(a[1]);
      }
    }
    libraries.push({ path: libPath, apps });
  }
  return libraries;
}

function gtPluginCount(gtFolder) {
  try {
    const p = path.join(gtFolder, 'BepInEx', 'plugins');
    return fs.existsSync(p) ? fs.readdirSync(p).filter((f) => /\.dll$/i.test(f)).length : 0;
  } catch { return 0; }
}

// Enumerate every Gorilla Tag folder across all Steam libraries, with the
// signals we use to rank them: whether the library claims the app id, whether
// the real game exe is present (a launchable install vs a leftover/mods-only
// folder), and how many mods sit in its plugins folder.
function listGorillaTagFolders(libraries) {
  const seen = new Set();
  const out = [];
  for (const lib of libraries) {
    const folder = path.join(lib.path, 'steamapps', 'common', GORILLA_TAG_FOLDER_NAME);
    const key = folder.toLowerCase();
    if (seen.has(key) || !fs.existsSync(folder)) continue;
    seen.add(key);
    out.push({
      path: folder,
      claims: lib.apps.includes(GORILLA_TAG_APP_ID),
      hasExe: fs.existsSync(path.join(folder, GORILLA_TAG_EXE)),
      mods: gtPluginCount(folder),
    });
  }
  return out;
}

// On-demand "find my Gorilla Tag" scan: enumerate every GT folder across all
// Steam libraries (across drives), sorted best-first. Powers the manual picker
// for users whose game or mods live somewhere auto-detect didn't prefer.
function detectAllGorillaTagFolders() {
  const steamPath = getSteamPathFromRegistry();
  if (!steamPath) return [];
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  let libraries = [];
  if (fs.existsSync(vdfPath)) {
    try { libraries = parseLibraryFoldersVdf(fs.readFileSync(vdfPath, 'utf8')); } catch { /* fall through */ }
  }
  libraries.push({ path: steamPath, apps: [] }); // include the main library too
  const found = listGorillaTagFolders(libraries);
  found.sort(rankGorillaTagFolders);
  return found;
}

// Rank Gorilla Tag folders. A folder we can actually LAUNCH wins, always - a
// leftover copy stuffed with mods is useless if the game exe isn't in it (and
// ranking by mod count is exactly how users ended up managing a dead folder
// while Steam quietly launched a different install). So: real game exe first,
// then the library Steam actually claims the app id in, and only then mod count
// as a tiebreak between two equally-real installs.
function rankGorillaTagFolders(a, b) {
  if (a.hasExe !== b.hasExe) return a.hasExe ? -1 : 1;
  if (a.claims !== b.claims) return a.claims ? -1 : 1;
  if (b.mods !== a.mods) return b.mods - a.mods;
  return 0;
}

// The folder we'd recommend: the best-ranked one that is actually launchable.
// Powers the "no game in this folder" modal's one-click fix.
function recommendedGorillaTagFolder() {
  try {
    return detectAllGorillaTagFolders().find((f) => f.hasExe) || null;
  } catch {
    return null;
  }
}

function findGorillaTagInLibraries(libraries) {
  const candidates = listGorillaTagFolders(libraries);
  if (candidates.length === 0) return null;
  candidates.sort(rankGorillaTagFolders);
  return candidates[0].path;
}

function detectGorillaTagPath() {
  const steamPath = getSteamPathFromRegistry();
  if (!steamPath) {
    return { steamInstalled: false, gamePath: null, steamPath: null };
  }

  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (!fs.existsSync(vdfPath)) {
    // Steam exists but the VDF doesn't - unusual, fall back to main library.
    const fallback = path.join(steamPath, 'steamapps', 'common', GORILLA_TAG_FOLDER_NAME);
    return {
      steamInstalled: true,
      steamPath,
      gamePath: fs.existsSync(fallback) ? fallback : null,
    };
  }

  const vdfText = fs.readFileSync(vdfPath, 'utf8');
  const libraries = parseLibraryFoldersVdf(vdfText);
  const gamePath = findGorillaTagInLibraries(libraries);
  logInfo('Detected game path:', gamePath);
  return { steamInstalled: true, steamPath, gamePath };
}

const RESOLUTION_MAP = {
  '720':  [1280, 720],
  '1080': [1920, 1080],
  '1440': [2560, 1440],
  '2160': [3840, 2160],
};

// Native resolution of the display the game will open on, in PHYSICAL pixels
// ([w, h]), or null if it can't be determined. Electron is required lazily so
// this module stays loadable - and testable - outside the Electron runtime.
function nativeResolutionFor(monitor) {
  try {
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    // Unity's -monitor is 1-based; anything else ('default', junk) = primary.
    const idx = Number(monitor);
    const target = (Number.isInteger(idx) && idx >= 1 && displays[idx - 1])
      ? displays[idx - 1]
      : screen.getPrimaryDisplay();
    // display.size is in DIPs - scale back up or a 150% display reports 1280x720.
    const scale = target.scaleFactor || 1;
    const w = Math.round(target.size.width * scale);
    const h = Math.round(target.size.height * scale);
    return (w > 0 && h > 0) ? [w, h] : null;
  } catch {
    return null; // no Electron screen API (tests, early startup) - caller degrades.
  }
}

// Modes that are SUPPOSED to cover the whole display. Left unsized, Unity falls
// back to its persisted window size - a stock 1024x768 on a fresh profile - so
// "borderless fullscreen" opened a small 4:3 box on a 1080p monitor. GT's own
// "<name> Default" registry values are 1024x768 as well, so the display-restore
// path can't correct it either; the size has to be passed at launch.
const FULL_DISPLAY_MODES = new Set(['borderless', 'fullscreen']);

// Frame rate -> the value for `-max-frame-rate`, or null to pass no flag.
//
// 'unlimited' becomes -1, Unity's uncapped sentinel - the same value the in-game
// Uncap Framerate tool writes to Application.targetFrameRate
// (mod/Features/PerformanceModule.cs). Anything else has to be a plain number;
// junk is dropped rather than forwarded, because config.json is a file on disk
// that people do hand-edit and these args go straight onto a spawn line.
//
// This is a COPY of normaliseFrameRate() in src/lib/launch-options.js - keep the
// two in step. electron/ is CommonJS and can't import the renderer's ESM, and
// validating only in the UI would leave a hand-edited config unchecked.
const FRAME_RATE_MAX = 10000;

function frameRateArg(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'default') return null;
  if (s === 'unlimited') return '-1';
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.min(FRAME_RATE_MAX, n));
}

function buildExtraArgs(options = {}, nativeRes = null) {
  const args = [];
  const opts = options || {};
  const res = RESOLUTION_MAP[opts.resolution]
    || (FULL_DISPLAY_MODES.has(opts.displayMode) ? nativeRes : null);
  if (res) args.push('-screen-width', String(res[0]), '-screen-height', String(res[1]));
  if (opts.monitor && opts.monitor !== 'default') args.push('-monitor', String(opts.monitor));
  if (opts.displayMode === 'windowed') args.push('-screen-fullscreen', '0');
  else if (opts.displayMode === 'fullscreen') args.push('-screen-fullscreen', '1');
  else if (opts.displayMode === 'borderless') args.push('-screen-fullscreen', '0', '-popupwindow');
  const fps = frameRateArg(opts.frameRate);
  if (fps !== null) args.push('-max-frame-rate', fps);
  if (opts.customArgs?.trim()) args.push(...opts.customArgs.trim().split(/\s+/));
  return args;
}

// Gorilla Tag authenticates with its backend (Mothership/PlayFab) using a Steam
// auth ticket, which requires `SteamAPI_Init()` to succeed. That needs Steam
// CONTEXT: either the game was launched BY Steam, or a `steam_appid.txt` holding
// the app id sits next to the exe. Spawning the exe bare gives neither, so
// SteamAPI_Init() fails -> `Steamworks is not initialized` -> the login call
// throws -> NO cosmetics, NO daily board, NO lobbies (the exact symptoms a bare
// exe launch produced). This writes the context file so auth works whether we
// launch through Steam or directly. Steam's file-integrity check ignores it, so
// it's safe to leave in the game folder. Idempotent.
function ensureSteamAppId(gamePath) {
  try {
    const f = path.join(gamePath, STEAM_APPID_FILE);
    if (!fs.existsSync(f) || fs.readFileSync(f, 'utf8').trim() !== GORILLA_TAG_APP_ID) {
      fs.writeFileSync(f, GORILLA_TAG_APP_ID, 'utf8');
    }
    return true;
  } catch (e) {
    logError('Could not write steam_appid.txt (Steam auth may fail):', e);
    return false;
  }
}

function steamExePath() {
  const sp = getSteamPathFromRegistry();
  if (!sp) return null;
  const exe = path.join(sp, 'steam.exe');
  return fs.existsSync(exe) ? exe : null;
}

// Launch Gorilla Tag so it can actually AUTHENTICATE with Steam (see
// ensureSteamAppId for why a bare exe launch breaks cosmetics/servers).
//
// Two launch paths, picked automatically:
//   * If the selected folder IS Steam's registered install (the normal case),
//     we hand off to Steam (`steam.exe -applaunch <appid> <args>`). That is the
//     canonical, most reliable way to get a valid Steam auth ticket, and Steam
//     runs THIS exact (modded) folder - so there's no "wrong copy" problem.
//   * If the user points us at a NON-Steam folder, we run the exe directly so
//     their chosen folder is the one that launches; the steam_appid.txt we wrote
//     supplies the Steam context so auth still succeeds.
//
//   'steamvr' - Steam VR Mode (`-vrmode OpenVR`), matching the XRSDKOpenVR
//               loader the game ships and boot.config already pre-inits.
//   'quest'   - Meta Quest over Link / Air Link. We start the Oculus PC client
//               so the runtime is live, and pass NO -vrmode at all. See
//               vrArgsForMode() below for why that is the fix, not an omission.
//
// `options` maps to Unity CLI flags: resolution, monitor, displayMode,
// frameRate, customArgs. Steam forwards everything after the app id to the game.
//
// Throws an Error with `.code = 'NO_GAME_AT_PATH'` if there's no game exe in the
// selected folder - the renderer turns that into the "no game here" modal rather
// than silently launching something else.
// ── Why "quest" passes no -vrmode ───────────────────────────────────────────
//
// It used to pass `-vrmode Oculus`, and users reported that launching with Meta
// Quest PCVR simply did not work while SteamVR did. That is not a coincidence:
// `Oculus` names an XR loader that this game does not contain.
//
// Read straight off a Gorilla Tag install:
//
//   Gorilla Tag_Data/UnitySubsystems/  ->  UnityOpenXR, XRSDKOpenVR
//   Gorilla Tag_Data/Managed/          ->  Unity.XR.OpenXR.dll,
//                                          Unity.XR.OpenXR.Features.MetaQuestSupport.dll,
//                                          Unity.XR.OpenVR.dll
//                                          ...and NO Unity.XR.Oculus.dll
//   Gorilla Tag_Data/boot.config       ->  xrsdk-pre-init-library=XRSDKOpenVR
//
// So the game's two runtimes are OpenVR (SteamVR) and OpenXR. `-vrmode` drives
// Unity's LEGACY VRDevice path - the strings around it in UnityPlayer.dll are
// all "[VRDevice] Successfully created device %s" - and that path has no OpenXR
// device at all. `-vrmode OpenVR` lines up with a loader that exists, which is
// why SteamVR works. `Oculus` lines up with nothing.
//
// Meta's Link runtime is reached through OPENXR, not through a Unity "Oculus"
// device. Unity XR Plugin Management initialises OpenXR against whatever the
// system's active OpenXR runtime is, and for a Link user that is Meta's. So the
// correct thing to pass for Quest is nothing: start the Oculus runtime, then
// let the game's own XR initialisation find it.
//
// Deliberately NOT guessed at: there is no evidence UnityPlayer accepts a
// `-vrmode OpenXR`, and shipping a made-up flag would be the same mistake in a
// new costume. Omitting the override is the conservative option - the worst it
// can do is leave the game on the default it would have used anyway.
// Exported so electron/steam-launch-args.test.cjs can assert the one thing
// that broke: that Quest mode never names a loader the game does not have.
function vrArgsForMode(mode) {
  return mode === 'quest' ? [] : ['-vrmode', 'OpenVR'];
}

function launchGorillaTag(mode = 'steamvr', options = {}, gamePath = null) {
  const vrArgs = vrArgsForMode(mode);
  const exe = gamePath ? path.join(gamePath, GORILLA_TAG_EXE) : null;

  if (!exe || !fs.existsSync(exe)) {
    const err = new Error(
      gamePath
        ? `No Gorilla Tag install found in the selected folder:\n${gamePath}`
        : 'No Gorilla Tag folder is selected yet.'
    );
    err.code = 'NO_GAME_AT_PATH';
    throw err;
  }

  // Quest problems are almost never "the game did not start" - it starts, and
  // then does not reach the headset. Both causes are knowable BEFORE launching,
  // so collect them and hand them back for the UI to say out loud. Logging them
  // only into the app log is what left "Quest just does not work" unanswerable.
  let vrWarning = null;
  if (mode === 'quest') {
    const started = maybeStartOculus();
    vrWarning = questReadinessWarning(started);
  }

  const extraArgs = buildExtraArgs(options, nativeResolutionFor(options && options.monitor));
  const gameArgs = [...vrArgs, ...extraArgs];

  // Guarantee Steam context so GT's SteamAPI_Init() succeeds and it can log in.
  ensureSteamAppId(gamePath);

  const steamExe = steamExePath();
  let steamGamePath = null;
  try { steamGamePath = detectGorillaTagPath().gamePath; } catch { /* fall through to direct */ }
  const isSteamInstall = Boolean(
    steamExe && steamGamePath &&
    path.normalize(steamGamePath).toLowerCase() === path.normalize(gamePath).toLowerCase()
  );

  const { spawn } = require('child_process');
  if (isSteamInstall) {
    // Canonical Steam launch of this exact (modded) folder -> reliable auth.
    const child = spawn(
      steamExe,
      ['-applaunch', GORILLA_TAG_APP_ID, ...gameArgs],
      { detached: true, stdio: 'ignore', windowsHide: false }
    );
    child.unref();
    logInfo(`Launch via Steam -applaunch ${GORILLA_TAG_APP_ID} mode=${mode} extra=${extraArgs.join(' ')}`);
  } else {
    // Non-Steam folder: run it in place. steam_appid.txt (written above) gives
    // the Steam context. Detached so the game survives Electron exiting; cwd =
    // the game folder so BepInEx/doorstop resolves config + plugins for THIS install.
    const child = spawn(
      exe,
      gameArgs,
      { cwd: gamePath, detached: true, stdio: 'ignore', windowsHide: false }
    );
    child.unref();
    logInfo(`Launch direct (non-Steam folder) mode=${mode} exe=${exe} extra=${extraArgs.join(' ')}`);
  }

  // Null on every healthy launch, so callers can pass it straight through.
  return { vrWarning };
}

// Where the Oculus/Meta PC client actually lives. The old version checked two
// hardcoded Program Files paths and gave up - but the installer lets you choose
// the drive, and plenty of people put it on a second one specifically because
// the runtime is large. For those users Quest mode silently did nothing at all,
// which is half of "Quest launching does not work".
//
// The registry knows the real answer, so ask it first and keep the fixed paths
// as a fallback.
function oculusClientPath() {
  const fromRegistry = [
    ['HKLM\\SOFTWARE\\Oculus VR, LLC\\Oculus', 'InstallLocation'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Oculus VR, LLC\\Oculus', 'InstallLocation'],
    ['HKLM\\SOFTWARE\\Oculus VR, LLC\\Oculus\\Config', 'InitialAppLibrary'],
  ];
  for (const [key, value] of fromRegistry) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', value], { encoding: 'utf8' });
      const m = out.match(new RegExp(`${value}\\s+REG_[A-Z_]+\\s+(.+)`, 'i'));
      if (!m) continue;
      const base = path.normalize(m[1].trim());
      // The value is the install ROOT; the client sits under Support.
      const exe = path.join(base, 'Support', 'oculus-client', 'OculusClient.exe');
      if (fs.existsSync(exe)) return exe;
    } catch { /* key absent on a machine without the runtime - normal */ }
  }

  const fixed = [
    'C:\\Program Files\\Oculus\\Support\\oculus-client\\OculusClient.exe',
    'C:\\Program Files (x86)\\Oculus\\Support\\oculus-client\\OculusClient.exe',
  ];
  for (const p of fixed) if (fs.existsSync(p)) return p;
  return null;
}

// Is the Meta/Oculus PC client already up? Asked before warning that it is
// missing, because "we could not find it on disk" and "it is not running" are
// different questions and only the second one matters. Someone whose runtime
// lives somewhere our registry lookup does not cover, but who has it open,
// has a perfectly working setup and must not be told otherwise on every launch.
function isOculusClientRunning() {
  try {
    const out = execFileSync('tasklist', ['/NH', '/FO', 'CSV', '/FI', 'IMAGENAME eq OculusClient.exe'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /OculusClient\.exe/i.test(out);
  } catch {
    return false;
  }
}

// Returns true if the Meta/Oculus PC client was found and started, or was
// already running.
function maybeStartOculus() {
  const p = oculusClientPath();
  if (!p) {
    // Say what this means rather than "not found". Without the runtime there is
    // no Meta OpenXR runtime for the game to initialise against, so this is the
    // likely explanation for a Quest launch that opens a flat window.
    // Not on disk where we looked - but if it is already running, the setup is
    // fine and there is nothing to report.
    if (isOculusClientRunning()) {
      logInfo('Oculus/Meta PC client not found on disk, but it is already running.');
      return true;
    }
    logInfo('Oculus/Meta PC client not found in the registry or the usual folders, '
          + 'and no OculusClient.exe is running. Quest mode needs the Meta Quest Link '
          + 'app; launching anyway.');
    return false;
  }
  try {
    exec(`start "" "${p}"`, { windowsHide: true });
    logInfo(`Started Oculus runtime: ${p}`);
    return true;
  } catch (e) {
    logError('Failed to start Oculus client:', e);
    return false;
  }
}

// Which OpenXR runtime the system will hand the game. This is the single value
// that decides whether "Quest mode" reaches the headset through Link, and it is
// set by whichever app most recently claimed it (the Meta app and SteamVR both
// do, and SteamVR tends to win because it asks on every update).
//
// Observe-only: taking it would need admin and is the Meta app's job. Naming it
// in the log turns "Quest just does not work" into something answerable.
function activeOpenXrRuntime() {
  for (const key of ['HKLM\\SOFTWARE\\Khronos\\OpenXR\\1', 'HKCU\\SOFTWARE\\Khronos\\OpenXR\\1']) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'ActiveRuntime'], { encoding: 'utf8' });
      const m = out.match(/ActiveRuntime\s+REG_[A-Z_]+\s+(.+)/i);
      if (m) return path.normalize(m[1].trim());
    } catch { /* no OpenXR runtime registered */ }
  }
  return null;
}

// The one sentence worth putting in front of a Quest user, or null when there
// is nothing wrong. Two things decide whether Quest mode reaches the headset,
// and both are knowable before the game starts:
//
//   1. Is the Meta PC client there at all?
//   2. Which OpenXR runtime is active? Meta and SteamVR both claim it, and
//      SteamVR tends to win because it asks on every update. On the machine
//      this was written on, SteamVR held it.
//
// Observe-only: taking the runtime needs admin and is the Meta app's job. But
// naming it turns "Quest just does not work" into a thing the user can fix in
// about fifteen seconds.
function questReadinessWarning(oculusStarted) {
  const rt = activeOpenXrRuntime();
  logInfo(`Quest launch: meta client ${oculusStarted ? 'started' : 'NOT found'}, `
        + `active OpenXR runtime ${rt || '(none registered)'}`);

  if (!oculusStarted) {
    return 'Quest mode needs the Meta Quest Link app, and it was not found on this PC. '
         + 'Install it (or start it yourself if it lives somewhere unusual), connect your '
         + 'headset over Link or Air Link, then launch again.';
  }
  if (!rt) {
    return 'No active OpenXR runtime is registered on this PC, so Gorilla Tag has nothing '
         + 'to connect your headset through. Open the Meta Quest Link app once, then in '
         + 'Settings > General set Meta Quest Link as the active OpenXR runtime.';
  }
  const lower = rt.toLowerCase();
  if (!lower.includes('oculus') && !lower.includes('meta')) {
    return 'Gorilla Tag will start through a different OpenXR runtime instead of Meta, so your '
         + 'Quest may not get a picture. In the Meta Quest Link app: Settings > General > '
         + 'OpenXR Runtime, and set Meta Quest Link as active.';
  }
  return null;
}

// Try to quit Gorilla Tag gracefully first (WM_CLOSE → Application.Quit in
// Unity, letting SteamVR unwind cleanly), then force-kill if it's still
// running after a short grace period. Returns when the process is gone or
// we've hit the timeout and escalated.
async function quitGorillaTag() {
  if (!isGorillaTagRunning()) return { ok: true, forced: false };

  // Soft close - fire-and-forget, we poll to see if it worked.
  try {
    execFileSync('taskkill', ['/IM', 'Gorilla Tag.exe'], { stdio: 'ignore' });
  } catch {
    // Non-zero exit is common if the game already closed or couldn't
    // receive the message; keep going and fall back to /F.
  }

  // 6s of politeness. This was 2s until 2026-08-03, which was too tight: a VR
  // game shutting down has to unwind SteamVR with it, and force-killing it
  // mid-unwind is a known way to strand SteamVR's vrserver.exe holding port
  // 27062 - after which SteamVR refuses to start with "Port 27062 in use" and
  // the user has to kill it by hand. A tester hit exactly that.
  //
  // The cost of waiting is dead time in the wristband's restart button; the
  // cost of not waiting is somebody's VR being broken until they reboot. GT
  // holds no unsaved state, so the only thing the old 2s bought was a snappier
  // restart.
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isGorillaTagRunning()) {
      logInfo('[Quit] Gorilla Tag closed gracefully');
      return { ok: true, forced: false };
    }
  }

  // Still up - force it.
  //
  // LOGGED LOUDLY, and as an error, because this is the branch that can leave
  // SteamVR stranded. Before this existed the function returned `forced: true`
  // to a caller that threw it away, so there was NO record anywhere that
  // Excalibur had ever hard-killed the game - which made "did we cause this?"
  // unanswerable from a user's logs. Now it is answerable.
  logError('[Quit] Gorilla Tag ignored the close request for 6s - FORCE-KILLING it. '
         + 'If SteamVR next refuses to start with "Port 27062 in use", this is the likely cause.');
  try {
    execFileSync('taskkill', ['/IM', 'Gorilla Tag.exe', '/F'], { stdio: 'ignore' });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, forced: true };
}

// ── "Is Gorilla Tag running?" ────────────────────────────────────────────────
//
// THIS IS A CHILD PROCESS SPAWN, AND IT IS THE MOST EXPENSIVE RECURRING THING
// THE APP DOES. `tasklist` costs roughly 60-200ms on a healthy machine and
// considerably more with an antivirus filter driver in the loop, because the
// cost is process creation, not the filtering.
//
// It used to be `execFileSync` only, called from TWO independent pollers:
//
//   electron/main.js   presence poll        every 5s
//   src/App.jsx        crash/quit detector  every 4s, over `game:is-running`
//
// The main process is single-threaded and owns all ~112 IPC handlers, so each
// of those synchronous spawns froze EVERY renderer request behind it. About 27
// stalls a minute, forever, on an app that is idle. Nothing about that is
// visible in a profiler pointed at the renderer - the renderer just sees its
// own `invoke()` take an oddly long time now and then, which is exactly what a
// hitch feels like.
//
// So there are now two entry points, and which one you want is a question about
// SAFETY, not about style:
//
//   getGorillaTagRunning()  async, coalesced, cached. For POLLERS. Never blocks
//                           the main process, and concurrent callers share one
//                           spawn instead of each paying for their own.
//   isGorillaTagRunning()   synchronous and uncached, exactly as before. For
//                           GUARDS - the "you can't install mods while the game
//                           is running" checks, where acting on a stale answer
//                           writes to files the game has open.
//
// The sync path publishes its result into the same cache, so a guard firing
// also buys the next poll a free answer.
const PROC_TTL_MS = 2500;
let procCache    = { at: 0, running: false };
let procInFlight = null;

function probeGorillaTagRunning() {
  return new Promise((resolve) => {
    // /NH /FO CSV keeps the output to one line; the win here is small next to
    // the spawn itself, but it also makes the "no tasks" case unambiguous.
    execFile(
      'tasklist',
      ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${GORILLA_TAG_EXE}`],
      { encoding: 'utf8', windowsHide: true },
      (err, stdout) => resolve(!err && /Gorilla Tag\.exe/i.test(stdout || '')),
    );
  });
}

// `maxAgeMs: 0` forces a fresh probe. Anything else accepts a cached answer
// that young, which is what collapses the 4s and 5s pollers into one spawn.
async function getGorillaTagRunning({ maxAgeMs = PROC_TTL_MS } = {}) {
  if (procCache.at && Date.now() - procCache.at <= maxAgeMs) return procCache.running;
  // A probe is already out. Join it rather than starting a second one - two
  // pollers on co-prime periods land together often enough to matter.
  if (procInFlight) return procInFlight;
  procInFlight = probeGorillaTagRunning().then((running) => {
    procCache    = { at: Date.now(), running };
    procInFlight = null;
    return running;
  });
  return procInFlight;
}

function isGorillaTagRunning() {
  try {
    // tasklist is built in to Windows; /FI filters to just our process.
    const out = execFileSync('tasklist', ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${GORILLA_TAG_EXE}`], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const running = /Gorilla Tag\.exe/i.test(out);
    procCache = { at: Date.now(), running };
    return running;
  } catch {
    return false;
  }
}

module.exports = {
  GORILLA_TAG_APP_ID,
  detectGorillaTagPath,
  listGorillaTagFolders, // used to surface mods sitting in a non-game GT folder
  detectAllGorillaTagFolders, // on-demand "find my Gorilla Tag" scan across drives
  recommendedGorillaTagFolder, // best LAUNCHABLE folder - offered by the "no game here" modal
  launchGorillaTag,
  quitGorillaTag,
  isGorillaTagRunning,  // SYNC + uncached. Guards only - see the note above it.
  getGorillaTagRunning, // async + coalesced + cached. Everything that POLLS.
  parseLibraryFoldersVdf, // exported for potential testing
  buildExtraArgs,        // exported for electron/launch-args.test.cjs
  vrArgsForMode,         // exported for electron/vr-mode.test.cjs
  activeOpenXrRuntime,   // observe-only; names the runtime Quest mode will get
  questReadinessWarning, // the sentence the UI shows when Quest cannot work
  nativeResolutionFor,
};
