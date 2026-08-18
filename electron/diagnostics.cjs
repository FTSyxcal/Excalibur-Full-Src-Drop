// The "Copy diagnostics" bundle: everything needed to work out why the in-game
// mod did not load, in one paste.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// v0.9.0 shipped and a tester's mod did not load. Working out why took a round
// trip per fact - is BepInEx installed, did the patcher land, what does the
// BepInEx log say - and each round trip is a day. Every one of those facts is
// readable from this process in milliseconds. The bundle answers them all at
// once so the first reply can be a diagnosis instead of a question.
//
// ── The state is worth more than the logs ───────────────────────────────────
// Raw logs alone are the WRONG thing to collect. "BepInEx/patchers is empty"
// is not a line in any log; it is the ABSENCE of everything, which is exactly
// the shape a silent failure takes. So the bundle leads with a state snapshot
// (does BepInEx exist, what is in patchers, is mod-runtime populated, does the
// payload exist in this build) and only then quotes the logs.
//
// ── REDACTION IS NOT OPTIONAL ───────────────────────────────────────────────
// This text is designed to be pasted into a chat by a person who will not read
// it first. The bridge token is a live credential, the JWT is a bearer token
// for the whole account, and the Windows username is personal information that
// appears in every single path. All three are stripped here rather than in the
// UI, because this is the only place that can guarantee it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getLogPath, getWritableBaseDir } = require('./logger.cjs');

// ── In-game diagnostics the MOD pushes over the bridge ──────────────────────
//
// The rest of this file reads DESKTOP-side state. But the questions that matter
// most - did the paid assemblies actually load, did activation pass, is the
// watermark intact, did Luma ever see a VR camera - are only knowable INSIDE the
// game. The mod sends them over the bridge (mod_diagnostics / luma_diagnostics);
// main.js hands them here; we persist the LAST of each so the Copy Diagnostics
// report shows what happened in-game even after the game has closed, which is the
// normal moment a tester grabs the report.
//
// Persisted to one small JSON file, overwritten each launch. Best-effort - a
// diagnostic that cannot write its own cache is not worth an error.
function modDiagPath() { return path.join(getWritableBaseDir(), 'last-mod-diagnostics.json'); }

function loadModDiagStore() {
  try { return JSON.parse(fs.readFileSync(modDiagPath(), 'utf8')); }
  catch { return {}; }
}
function saveModDiagStore(store) {
  try { fs.writeFileSync(modDiagPath(), JSON.stringify(store), { encoding: 'utf8', mode: 0o600 }); }
  catch { /* best effort */ }
}

// The bridge already parsed the JSON, so `msg` is a plain object. We keep the
// fields we know and a receivedAt stamp. NOT the raw msg - it also carries
// `type`, and a future field we do not expect should not silently ride along
// into a report a tester pastes in public.
function recordModDiagnostics(msg) {
  const store = loadModDiagStore();
  store.mod = {
    at: Date.now(),
    tier: msg.tier, authenticated: msg.authenticated,
    pro: msg.pro, proPlus: msg.proPlus,
    activation: msg.activation, watermark: msg.watermark, paidGateOpen: msg.paidGateOpen,
    tamper: msg.tamper, build: msg.build,
    assemblies: Array.isArray(msg.assemblies) ? msg.assemblies : [],
    enabled: Array.isArray(msg.enabled) ? msg.enabled : [],
  };
  saveModDiagStore(store);
}
function recordLumaDiagnostics(msg) {
  const store = loadModDiagStore();
  store.luma = {
    at: Date.now(),
    shaders: msg.shaders, sawStereoCamera: msg.sawStereoCamera, engineEnabled: msg.engineEnabled,
  };
  saveModDiagStore(store);
}
// ONE definition of "is this a data folder", imported rather than re-implemented:
// a second copy here would drift from the guard that actually protects the
// folders. mods.cjs does not require this file, so there is no cycle.
const { isDataFolder } = require('./mods.cjs');

// Tail N lines without reading a huge file into memory twice.
function tailLines(file, n) {
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: 'file does not exist', lines: [] };
    const raw = fs.readFileSync(file, 'utf8');
    const all = raw.split(/\r?\n/).filter((l) => l.length);
    return { ok: true, total: all.length, lines: all.slice(-n) };
  } catch (e) {
    return { ok: false, reason: e.message, lines: [] };
  }
}

// Strip anything that is a credential or personal. Applied to the WHOLE bundle
// as the last step, so a line added later cannot bypass it by forgetting to.
function redact(text) {
  let s = String(text ?? '');
  // JWTs: three base64url segments. Bearer token for the entire account.
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<JWT redacted>');
  // The per-launch bridge token and any other long hex/base64 run. 32 bytes is
  // 64 hex chars; 24+ is well clear of ordinary words and short hashes we WANT
  // to keep (sha256 prefixes are printed truncated to 16 below).
  s = s.replace(/\b[A-Fa-f0-9]{32,}\b/g, (m) => `<${m.length}-char hex redacted>`);
  s = s.replace(/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, '<long base64 redacted>');
  // The Windows account name, which is in literally every path.
  const user = os.userInfo().username;
  if (user && user.length > 1) {
    s = s.split(user).join('<user>');
  }
  return s;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return null;   // null = could not read (missing dir), [] = empty dir
  }
}

// Read BepInEx's own logging settings out of BepInEx.cfg.
//
// This answers the one question the rest of section 2 could not: when the mod
// is demonstrably working and LogOutput.log is not there, is that a broken
// install or just a switched-off sink? It is nearly always the sink.
//
// BepInEx.cfg is a flat INI. Parsed by hand rather than with a dependency -
// we need exactly two keys out of one section, and a diagnostics report must
// never be the thing that throws.
//
//   [Logging.Disk]
//   Enabled = true          <- creates and writes BepInEx/LogOutput.log
//   WriteUnityLog = false   <- whether Unity's own output joins it
function reportDiskLogging(say, cfgPath, logPresent) {
  let raw;
  try { raw = fs.readFileSync(cfgPath, 'utf8'); }
  catch {
    // Absent is normal before BepInEx's first run; it writes this itself.
    say('BepInEx.cfg', logPresent ? 'not found (logging is working anyway)'
      : 'NOT FOUND  <-- BepInEx has not generated its config here');
    return;
  }

  // Walk sections so a key of the same name in another section cannot match.
  let section = '';
  let enabled = null;
  let unityLog = null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const sec = t.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim().toLowerCase(); continue; }
    if (section !== 'logging.disk') continue;
    const kv = t.match(/^([^=]+)=(.*)$/);
    if (!kv) continue;
    const k = kv[1].trim().toLowerCase();
    const v = kv[2].trim().toLowerCase();
    if (k === 'enabled')       enabled  = v === 'true';
    if (k === 'writeunitylog') unityLog = v === 'true';
  }

  if (enabled === null) {
    say('disk logging', 'not set in BepInEx.cfg (BepInEx default is ON)');
  } else if (enabled) {
    say('disk logging', logPresent
      ? 'ON'
      : 'ON, but no file was written  <-- BepInEx cannot write into this folder (permissions?)');
  } else {
    say('disk logging', 'OFF  <-- THIS is why there are no logs. '
      + 'Set [Logging.Disk] Enabled = true in BepInEx/config/BepInEx.cfg');
  }
  if (unityLog !== null) say('  WriteUnityLog', unityLog ? 'true' : 'false');
}

/**
 * @param {object} o
 * @param {string|null} o.gamePath    config.gamePath
 * @param {string}      o.appVersion  app.getVersion()
 * @param {object|null} o.who         { username, tier, role } if known
 * @param {string}      o.payloadDir  modPayload.payloadDir()
 * @param {string}      o.runtimeDir  modPayload.runtimeDir()
 */
function buildDiagnosticBundle(o = {}) {
  const {
    gamePath = null, appVersion = '?', who = null,
    payloadDir = null, runtimeDir = null,
  } = o;

  const L = [];
  const say = (k, v) => L.push(`  ${String(k).padEnd(26)} ${v}`);

  L.push('===== EXCALIBUR DIAGNOSTICS =====');
  say('generated', new Date().toISOString());
  say('app version', appVersion);
  say('platform', `${os.platform()} ${os.release()}`);
  if (who) {
    say('signed in as', who.username || '(unknown)');
    say('role / tier', `${who.role || '?'} / ${who.tier || '?'}`);
  } else {
    say('signed in', 'NO - not signed in');
  }

  // ── 1. Does this BUILD carry the mod at all? ──────────────────────────────
  L.push('');
  L.push('--- 1. the payload inside this app ---');
  if (!payloadDir) {
    say('payload dir', 'UNKNOWN');
  } else {
    const core = path.join(payloadDir, 'excalibur-core.pae');
    const manifest = path.join(payloadDir, 'excalibur-core.manifest.json');
    const stage = path.join(payloadDir, 'mod-stage');
    let coreSize = null;
    try { coreSize = fs.statSync(core).size; } catch { /* absent */ }
    say('core .pae', coreSize == null ? 'MISSING' : `${coreSize} bytes`);
    const stageFiles = listDir(stage);
    say('mod-stage', stageFiles == null ? 'MISSING' : `${stageFiles.length} files`);
    say('patcher in stage', stageFiles && stageFiles.some((f) => /^Excalibur\.Patcher\./i.test(f)) ? 'yes' : 'NO');
    say('luma bundle staged', stageFiles && stageFiles.includes('lumalooks.bundle') ? 'yes' : 'no');
    try {
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      say('built at', m.builtAt || '?');
      for (const a of m.assemblies || []) {
        say(`  ${a.name}`, `${a.tier} ${a.size}B sha=${String(a.sha256 || '').slice(0, 16)} signed=${!!a.signature}`);
      }
    } catch (e) {
      say('core manifest', 'UNREADABLE: ' + e.message);
    }
  }

  // ── 2. The game folder: BepInEx and the patcher ───────────────────────────
  // The most common cause by a distance, and the one that leaves no log line.
  L.push('');
  L.push('--- 2. the game folder (this is usually where it goes wrong) ---');
  if (!gamePath) {
    say('game path', 'NOT SET - Excalibur has no game folder configured');
  } else {
    say('game path', gamePath);
    say('folder exists', fs.existsSync(gamePath) ? 'yes' : 'NO');
    const bep = path.join(gamePath, 'BepInEx');
    const bepExists = fs.existsSync(bep);
    say('BepInEx installed', bepExists ? 'yes' : 'NO  <-- the mod CANNOT load without this');
    say('winhttp.dll', fs.existsSync(path.join(gamePath, 'winhttp.dll')) ? 'yes' : 'NO  <-- BepInEx not wired in');
    if (bepExists) {
      const patchers = listDir(path.join(bep, 'patchers'));
      say('BepInEx/patchers', patchers == null ? 'MISSING FOLDER'
        : patchers.length ? patchers.join(', ') : 'EMPTY  <-- patcher not deployed');
      const plugins = listDir(path.join(bep, 'plugins'));
      say('BepInEx/plugins', plugins == null ? 'missing' : `${plugins.length} file(s)`);

      // ── LogOutput.log, and NOT concluding too much from its absence ───────
      //
      // This line used to read "ABSENT  <-- BepInEx never ran", and that
      // conclusion is wrong often enough to be harmful. A tester hit exactly
      // this on 2026-08-08: no LogOutput.log, while section 4 of this very
      // report showed the patcher deployed, three assemblies streamed, "mod
      // hello" over the bridge and the tier overlay drawn. BepInEx had plainly
      // run. The report sent two people looking at a healthy install because
      // it stated a cause instead of a fact.
      //
      // The file is written by BepInEx's DISK log sink, which is a setting -
      // so its absence means "that sink is off, or it could not write here",
      // and only means "BepInEx never ran" when nothing else ran either. The
      // patcher landing is the evidence that separates those, and it is
      // already on the line above.
      const logPresent = fs.existsSync(path.join(bep, 'LogOutput.log'));
      const patcherLanded = Array.isArray(patchers) && patchers.some((f) => /Excalibur/i.test(f));
      say('LogOutput.log', logPresent ? 'present'
        : patcherLanded
          ? 'absent  (BepInEx DID run - the patcher is deployed. See disk logging below)'
          : 'ABSENT  <-- BepInEx may never have run here');

      // The setting that actually decides whether that file exists. Never read
      // before, which is why "no logs on a working install" had no answer in
      // this report - the one fact that resolves it was one file away.
      reportDiskLogging(say, path.join(bep, 'config', 'BepInEx.cfg'), logPresent);
    }
  }

  // ── 3. The app's runtime dir (where the patcher's deps live) ──────────────
  L.push('');
  L.push('--- 3. the app runtime dir (patcher dependencies) ---');
  say('data dir', getWritableBaseDir());
  say('bridge.token', fs.existsSync(path.join(getWritableBaseDir(), 'bridge.token')) ? 'present' : 'ABSENT');
  if (runtimeDir) {
    const rt = listDir(runtimeDir);
    say('mod-runtime', rt == null ? 'MISSING  <-- deps never deployed' : `${rt.length} files`);
    if (rt) {
      for (const need of ['Newtonsoft.Json.dll', 'DiscordRPC.dll', 'lumalooks.bundle']) {
        say(`  ${need}`, rt.includes(need) ? 'present' : 'MISSING');
      }
    }
  }

  // ── 3b. Which Specials are actually switched on, and per profile ─────────
  // Added 2026-08-03, and it is the section that would have answered "the
  // Specials did not load" in one round trip instead of four.
  //
  // The mod enables a feature when config.features[id] is true. But the launch
  // reconcile REWRITES config.features from the active profile's
  // builtinFeatures every time Play is pressed, so the two disagreeing is the
  // whole bug class - and neither of them appears in any log. Print both, side
  // by side, and the disagreement is visible at a glance.
  L.push('');
  L.push('--- 3b. features: what the app will ask the mod to load ---');
  try {
    const cfgPath = path.join(getWritableBaseDir(), 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const feats = cfg.features || {};
    const on = Object.keys(feats).filter((k) => feats[k] === true).sort();
    const off = Object.keys(feats).filter((k) => feats[k] !== true).sort();
    say('activeProfileId', cfg.activeProfileId || 'NONE');
    say('homeLaunchProfileId', cfg.homeLaunchProfileId || 'none');
    say('features ON', on.length ? on.join(', ') : 'NONE');
    say('features OFF', off.length ? off.join(', ') : 'none');

    const profPath = path.join(getWritableBaseDir(), 'profiles.json');
    const profs = JSON.parse(fs.readFileSync(profPath, 'utf8'));
    const list = Array.isArray(profs) ? profs : (profs.profiles || []);
    L.push('  profiles (builtinFeatures is what the launch reconcile applies):');
    for (const p of list) {
      const bf = Array.isArray(p.builtinFeatures) ? p.builtinFeatures : null;
      L.push(`    ${String(p.id).padEnd(14)} ${p.id === cfg.activeProfileId ? '[ACTIVE] ' : '         '}`
           + `builtinFeatures=${bf === null ? 'MISSING' : (bf.length ? bf.join(',') : 'EMPTY  <-- strips every visible Special on launch')}`);
    }
  } catch (e) {
    L.push('  (could not read config/profiles: ' + e.message + ')');
  }

  // ── 4. Excalibur's own log, the lines that matter first ───────────────────
  L.push('');
  L.push('--- 4. Excalibur app log: mod/payload/bridge lines ---');
  const appLog = tailLines(getLogPath(), 4000);
  if (!appLog.ok) {
    L.push('  (could not read: ' + appLog.reason + ')');
  } else {
    const keyed = appLog.lines.filter((l) =>
      /ModPayload|patcher|BepInEx|bridge|Bridge|deploy|tier|Tier|core received|auth|Auth/.test(l));
    L.push(`  (${appLog.total} lines total; ${keyed.length} relevant, newest 80 shown)`);
    for (const l of keyed.slice(-80)) L.push('  ' + l);
  }


  // ── 5. THE TWO FIXES + did the core arrive ────────────────────────────────
  //
  // This section replaced two verbatim log tails (2026-08-07, owner). Dumping
  // the last N lines of everything reliably produced a paste that was mostly
  // other mods, and the four lines that answered the question were never in
  // the window. The mod now TAGS what matters (`[XDIAG ...]`, see
  // mod/Features/FixDiag.cs) and this reads only those, plus the handful of
  // lines that prove the core loaded at all - because "no fix lines" and "the
  // mod never ran" must not look the same.
  L.push('');
  L.push('--- 5. BepInEx LogOutput.log ---');
  if (!gamePath) {
    L.push('  (no game path, cannot read)');
  } else {
    const bepLog = tailLines(path.join(gamePath, 'BepInEx', 'LogOutput.log'), 4000);
    if (!bepLog.ok) {
      L.push('  (could not read: ' + bepLog.reason + ')');
      // Deliberately NOT "BepInEx has never run" - see the note on the
      // LogOutput.log line in section 2. This file is written by a sink that
      // can be switched off, so its absence is not evidence on its own.
      L.push('  This file is written by BepInEx\'s disk log sink, which can be OFF.');
      L.push('  Check "disk logging" in section 2, and whether the patcher landed -');
      L.push('  a deployed patcher means BepInEx ran whatever this section says.');
    } else {
      const ex = bepLog.lines.filter((l) => /Excalibur|Patcher|core received|Preloader|patcher/i.test(l));
      L.push(`  (${bepLog.total} lines total)`);
      L.push('  -- Excalibur/patcher lines --');
      if (!ex.length) {
        L.push('  NONE. BepInEx ran but never saw an Excalibur patcher.');
      } else {
        for (const l of ex.slice(-60)) L.push('  ' + l);
      }

      // ── REMOVED 2026-08-15 (owner call): the per-investigation blocks ──
      //
      // Two curated report sections used to sit here and they had both outlived
      // the bugs they were cut for:
      //
      //   FIX DIAGNOSTICS (mic ownership + camera prop)  added 2026-08-07
      //     ~50 lines: an [XDIAG] census, the newest mic state line, the last 60
      //     mic and camera events, plus hardcoded HOW TO READ IT and WHAT GOOD
      //     LOOKS LIKE keys naming those two specific bugs.
      //
      //   CAMERA UI FLASHING (panel draw faults)
      //     the [CamGuiDiag] tail plus a splice of Documents\Excalibur\
      //     diagnostics\camera-gui.log.
      //
      // A bundle is read by a person scanning for the ONE fact that explains
      // this report. Investigation scaffolding for closed bugs pushes that fact
      // down the page, and its "what good looks like" guidance answers a
      // question nobody is asking any more.
      //
      // NOTHING IS ACTUALLY LOST, which is why this is a deletion rather than a
      // flag: both emitters are still live in the mod (FixDiag and CamGuiDiag
      // were deliberately kept - owner call, same day), and every [XDIAG] line
      // is written as "[Info : Excalibur] [XDIAG ...]", so it still comes
      // through the Excalibur/patcher tail above, which matches on /Excalibur/i.
      // The camera-gui.log file is also still written; it is simply not spliced
      // in here.
      //
      // If a mic-ownership or panel-draw investigation reopens, restore from
      // git rather than re-deriving: the guidance text above was hard-won.
    }
  }

  // ── 5b. Data folders: the GorillaShirts wipe ──────────────────────────────
  //
  // A folder under plugins/ with no .dll anywhere inside belongs to a mod, it is
  // not a mod. GorillaShirts puts every installed shirt pack beside its own DLL,
  // so each pack is a top-level folder in plugins/ - and Excalibur used to list
  // them as toggleable mods and move them into plugins_disabled/ on a disable or
  // a profile switch. GorillaShirts then made a fresh empty folder and the packs
  // looked deleted. toggleMod now refuses to move them.
  //
  // Both halves are reported: what is PROTECTED now, and what is STRANDED from
  // before the fix - because those packs are recoverable and the tester will
  // want them back.
  L.push('');
  L.push('--- 5b. Data folders (GorillaShirts packs, wallpapers, custom maps) ---');
  if (!gamePath) {
    L.push('  (no game path, cannot check)');
  } else {
    const scanData = (dir) => {
      const out = [];
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const full = path.join(dir, e.name);
        try { if (isDataFolder(full)) out.push(e.name); } catch { /* skip */ }
      }
      return out;
    };
    const live = scanData(path.join(gamePath, 'BepInEx', 'plugins'));
    const parked = scanData(path.join(gamePath, 'BepInEx', 'plugins_disabled'));

    L.push('  in plugins/ (PROTECTED - toggleMod refuses to move these):');
    if (live == null) L.push('    (plugins/ unreadable)');
    else if (!live.length) L.push('    (none)');
    else for (const n of live.slice(0, 40)) L.push('    ' + n);

    L.push('  in plugins_disabled/ (STRANDED - moved before the fix, still recoverable):');
    if (parked == null) L.push('    (plugins_disabled/ does not exist - nothing was ever moved)');
    else if (!parked.length) L.push('    (none)');
    else {
      for (const n of parked.slice(0, 40)) L.push('    ' + n);
      L.push('    ^ these are NOT lost. Move them back into BepInEx/plugins/ and the');
      L.push('      owning mod will find its content again.');
    }
  }

  // ── 6. SteamVR: whose fault was the port ────────────────────────────────
  // Added 2026-08-03 after a tester hit SteamVR's "Unable to launch SteamVR.
  // Port 27062 in use." That port is SteamVR's own (vrserver.exe) and Excalibur
  // never touches it - but Excalibur CAN force-kill Gorilla Tag, and killing a
  // VR game mid-shutdown is a known way to strand vrserver holding the port.
  //
  // So the question "was it us?" has a real answer, and it is answerable from
  // two lines that were previously in neither log: whether Excalibur escalated
  // to a force-kill (now logged in section 4, look for "FORCE-KILLING"), and
  // what SteamVR itself said at the time. Read them together:
  //
  //   force-kill in OUR log, THEN the port error in SteamVR's   -> likely us
  //   port error with no force-kill anywhere near it            -> not us
  //   vrserver still running from a session we never launched   -> not us
  L.push('');
  L.push('--- 6. SteamVR (port 27062 / stranded vrserver) ---');
  {
    // SteamVR logs live beside Steam, not beside the game. Walk up from the
    // game path: <steam>/steamapps/common/Gorilla Tag -> <steam>/logs.
    const candidates = [];
    if (gamePath) {
      candidates.push(path.resolve(gamePath, '..', '..', '..', 'logs'));
    }
    candidates.push('C:\\Program Files (x86)\\Steam\\logs');

    const dir = candidates.find((d) => { try { return fs.existsSync(d); } catch { return false; } });
    if (!dir) {
      L.push('  (no Steam logs folder found - tried: ' + candidates.join(' | ') + ')');
    } else {
      say('steam logs dir', dir);
      for (const name of ['vrserver.txt', 'vrmonitor.txt']) {
        const f = path.join(dir, name);
        const t = tailLines(f, 4000);
        L.push(`  -- ${name} --`);
        if (!t.ok) { L.push('    (' + t.reason + ')'); continue; }
        // The lines that decide the question: the port complaint itself, and
        // any shutdown/startup boundary around it.
        //
        // "New Connect message" is excluded and every line is clipped: SteamVR
        // logs each vrwebhelper launch with its FULL command line, which is
        // ~1.5 KB of Chromium flags per line and would be most of the bundle.
        const noisy = /New Connect message|vrwebhelper|--field-trial-handle/;
        const clip = (l) => (l.length > 240 ? l.slice(0, 240) + ' …[clipped]' : l);
        const keyed = t.lines.filter((l) =>
          /27062|port .*in use|already running|shutdown|exiting|failed to start|crash/i.test(l)
          && !noisy.test(l));
        L.push(`    (${t.total} lines total; ${keyed.length} relevant)`);
        for (const l of keyed.slice(-25)) L.push('    ' + clip(l));
        L.push('    -- last 12 verbatim --');
        for (const l of t.lines.slice(-12)) L.push('    ' + clip(l));
      }
    }
  }

  // ── In-game launch summary, pushed by the mod over the bridge ─────────────
  // The single most useful section for "the mod ran but a paid feature is
  // missing": it is the in-game truth, which nothing else here can see.
  L.push('');
  // 7, not 6. This and the SteamVR block above were both numbered 6, so the
  // bundle counted 1,2,3,3b,4,5,5b,6,6 - and "look at section 6" was ambiguous
  // in the one document whose whole job is to be quoted back at someone.
  L.push('--- 7. in-game launch summary (reported by the mod) ---');
  const store = loadModDiagStore();
  const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago` : '?');
  if (!store.mod) {
    L.push('  (none received this session)');
    L.push('  Either the mod never booted/connected - sections 1-5 explain why -');
    L.push('  or this is an older mod build that does not report diagnostics.');
  } else {
    const m = store.mod;
    L.push(`  reported     : ${ago(m.at)}   build=${m.build || '?'}`);
    L.push(`  account      : authenticated=${m.authenticated}  tier=${m.tier}`);
    L.push(`  assemblies   : ${(m.assemblies || []).join(', ') || '(none)'}`);
    L.push(`  anti-dump    : activation=${m.activation ? 'OK' : 'FAIL'}  watermark=${m.watermark ? 'intact' : 'BROKEN'}  tamper=${m.tamper || 'none'}`);
    L.push(`  paid gate    : ${m.paidGateOpen ? 'OPEN' : 'CLOSED'}  | Pro=${m.pro ? 'arrived' : 'NOT sent'}  Pro+=${m.proPlus ? 'arrived' : 'NOT sent'}`);
    L.push(`  enabled now  : ${(m.enabled || []).join(', ') || '(none)'}`);
    if (!m.paidGateOpen || (!m.pro && !m.proPlus)) {
      L.push('  >> paid features are MISSING. Why:');
      if (!m.pro && !m.proPlus) L.push('     no paid assembly arrived -> server withheld it (tier too low, offline, OR a debugger/dump tool was open at launch)');
      if (!m.activation)        L.push('     activation=FAIL -> loader handshake did not run (sideloaded/dumped copy, or older patcher)');
      if (!m.watermark)         L.push('     watermark=BROKEN -> trace mark stripped; paid half withheld on purpose');
    }
  }
  if (store.luma) {
    const lu = store.luma;
    L.push(`  luma (VR)    : ${ago(lu.at)}  shaders=${lu.shaders}  sawStereoCamera=${lu.sawStereoCamera}  engineEnabled=${lu.engineEnabled}`);
    if (lu.engineEnabled && (lu.shaders === 0 || lu.sawStereoCamera === false)) {
      L.push('     >> Luma is ON but NOT rendering in VR (shaders=0 or no stereo camera seen)');
    }
  } else if (store.mod && (store.mod.enabled || []).includes('luma-looks')) {
    L.push('  luma (VR)    : enabled but no readiness reported yet (give it ~15s after turning it on)');
  } else {
    L.push('  luma (VR)    : not enabled this session (toggle Luma Looks on to test VR rendering)');
  }

  L.push('');
  L.push('===== END DIAGNOSTICS =====');

  return redact(L.join('\n'));
}

// ── Who may run this ────────────────────────────────────────────────────────
// A pure predicate over VERIFIED token claims, kept here (not inline in
// main.js) so it can be tested exhaustively - which matters, because it is the
// whole of the permission.
//
// `user` comes from auth.getStatus(), i.e. claims off a token whose RS256
// signature was checked against the public key embedded in this binary. That
// is what makes this a gate rather than a suggestion: a user can edit
// config.json, the saved token file, or anything else on disk and still not
// produce a passing claim set.
//
// Testers, master testers and developers. Nobody else - explicitly NOT
// contributors, and NOT anyone on a paid tier. Pro+ is something you can buy;
// being a tester is something we grant. Only the second one implies "this
// person is expected to report broken builds to us".
function mayDiagnose(user) {
  if (!user || typeof user !== 'object') return false;
  return user.is_tester === true
      || user.is_master_tester === true
      || user.app_role === 'developer';
}

module.exports = {
  buildDiagnosticBundle, redact, tailLines, mayDiagnose,
  recordModDiagnostics, recordLumaDiagnostics,
};
