// Crash / "why didn't my mods load" diagnoser.
//
// Reads the logs the game and the loader actually leave behind, runs a rule
// set over them, and returns FINDINGS: what broke, in plain English, plus the
// specific thing to do about it. The renderer renders them; every judgement
// call lives here.
//
// ── Sources, and why each one matters ──────────────────────────────────────
//   BepInEx/LogOutput.log   the loader. Which plugins loaded, which were
//                           skipped and why, and every unhandled exception a
//                           mod threw on the way up. This is where a broken
//                           mod names itself.
//   Player.log              Unity's own log for the CURRENT/last session:
//                           headset init, asset failures, hard crashes.
//   Player-prev.log         the session BEFORE that. This is the important
//                           one after a real crash: the user relaunches to
//                           click Diagnose, which overwrites Player.log, so
//                           the crash evidence only survives here.
//
// ── Design rules ───────────────────────────────────────────────────────────
//   * Never guess a mod name. A finding that blames the wrong mod is worse
//     than no finding, because the user disables something that worked.
//   * Every finding carries `fix` steps a human can follow, and where the app
//     can do it, an `action` the UI can wire to a real button.
//   * Noise is filtered explicitly (see NOISE). Unity logs thousands of
//     harmless lines; surfacing them as "errors" makes the feature useless.
//   * Findings are ranked: a mod that crashed the game outranks a cosmetic
//     warning, and the summary states the single most likely cause.

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Line parsing ───────────────────────────────────────────────────────────
// BepInEx: "[Level  :Source] message"
const BEPIN_LINE = /^\[(\w+)\s*:\s*([^\]]+)\]\s?(.*)$/;

function parseBepInEx(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(BEPIN_LINE);
    if (m) out.push({ level: m[1], source: m[2].trim(), msg: m[3], raw });
    else if (raw.trim()) out.push({ level: '', source: '', msg: raw, raw });   // stack-trace continuation
  }
  return out;
}

// Unity noise that is ALWAYS present and never actionable. Without this the
// texture-decompress spam alone buries every real finding.
const NOISE = [
  /Failed to decompress .* texture with format/i,
  /Unloading \d+ unused Assets/i,
  /Total: \d+\.\d+ ms/i,
  /^\s*$/,
];
const isNoise = (line) => NOISE.some((re) => re.test(line));

// A .dll basename from a path or assembly reference, without the extension.
function baseName(s) {
  if (!s) return '';
  return String(s).split(/[\\/]/).pop().replace(/\.dll$/i, '').trim();
}

// ── Rules ──────────────────────────────────────────────────────────────────
// Each returns zero or more findings. Kept as small named functions rather
// than a table so each can carry its own reasoning.

const SEV = { critical: 3, high: 2, medium: 1, low: 0 };

function finding(f) {
  return {
    severity: 'medium',
    fix: [],
    ...f,
  };
}

// 1. The loader itself never ran. Nothing else matters if this is true.
function ruleLoaderMissing(bep) {
  if (!bep.length) {
    return [finding({
      id: 'loader-no-log',
      severity: 'critical',
      title: 'The mod loader never ran',
      detail: 'There is no BepInEx log at all, which means BepInEx did not start with the game. Nothing modded can work until it does.',
      fix: [
        'Launch the game through Excalibur rather than from Steam directly.',
        'If it still does not appear, BepInEx may not be installed in this Gorilla Tag folder.',
      ],
    })];
  }
  return [];
}

// 2. BepInEx ran but loaded fewer plugins than the user has enabled. This is
//    the "my mods just are not there" case, and the count comes from the
//    loader itself so it cannot be argued with.
function rulePluginCount(bep, ctx) {
  const line = bep.find((l) => /^(\d+) plugins to load$/.test(l.msg));
  if (!line) return [];
  const loaded = parseInt(line.msg, 10);
  const expected = ctx.enabledModCount;
  if (loaded > 0 || expected === 0) return [];
  return [finding({
    id: 'no-plugins-loaded',
    severity: expected > 0 ? 'critical' : 'medium',
    title: expected > 0
      ? `The loader started but found 0 mods (you have ${expected} enabled)`
      : 'The loader started with no mods',
    detail: expected > 0
      ? `BepInEx reported "0 plugins to load" while Excalibur shows ${expected} mod(s) switched on. The files are not in the folder the game reads, which almost always means the profile that was applied at launch does not contain them.`
      : 'BepInEx reported "0 plugins to load". Nothing is enabled, so this is expected.',
    fix: expected > 0 ? [
      'Check which profile is active on the Mods page - an empty or test profile disables everything at launch.',
      'Switch to the profile that holds your mods, then launch again.',
    ] : [],
    action: expected > 0 ? { kind: 'route', route: 'mods', label: 'Open Mods' } : null,
  })];
}

// 3. A mod compiled against an older Gorilla Tag. THE most common real
//    breakage, and the one users most often misdiagnose as "the mod is
//    broken" when it just needs updating.
function ruleStaleAgainstGame(bep) {
  const out = [];
  const seen = new Set();
  const re = /(MissingMethodException|MissingFieldException|TypeLoadException|MissingMemberException)/;
  for (let i = 0; i < bep.length; i++) {
    const l = bep[i];
    if (!re.test(l.msg)) continue;
    // The SOURCE field is the plugin's own logger name - the loader's own
    // attribution, not our guess.
    const mod = l.source && !/^BepInEx$/i.test(l.source) ? l.source : null;
    const key = mod || l.msg.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const member = (l.msg.match(/'([^']+)'/) || [])[1] || '';
    out.push(finding({
      id: `stale-mod:${key}`,
      severity: 'high',
      title: mod ? `${mod} was built for an older Gorilla Tag` : 'A mod was built for an older Gorilla Tag',
      detail:
        `The game no longer has ${member ? `\`${member}\`` : 'a member this mod calls'}, so the mod fails the moment it touches it. ` +
        'Gorilla Tag updates rename and remove things; a mod has to be rebuilt against the new version. This is not something you can configure around.',
      mod,
      fix: [
        mod ? `Update ${mod} to its newest release.` : 'Update the mod named in the log.',
        'If no update exists yet, disable it until the author ships one - it cannot work on this game build.',
      ],
      action: mod ? { kind: 'mod', mod, label: `Find ${mod} on the Mods page` } : null,
    }));
  }
  return out;
}

// 4. Missing dependency. BepInEx says exactly which assembly it wanted.
function ruleMissingDependency(bep) {
  const out = [];
  const seen = new Set();
  for (const l of bep) {
    const m = l.msg.match(/Could not load file or assembly '([^',]+)/i)
           || l.msg.match(/FileNotFoundException:.*'([^',]+)/i)
           || l.msg.match(/because it (?:has missing dependencies|requires) ([^\s,]+)/i);
    if (!m) continue;
    const dep = baseName(m[1]);
    if (!dep || seen.has(dep)) continue;
    seen.add(dep);
    const mod = l.source && !/^BepInEx$/i.test(l.source) ? l.source : null;
    out.push(finding({
      id: `missing-dep:${dep}`,
      severity: 'high',
      title: `A required library is missing: ${dep}`,
      detail:
        `${mod ? `${mod} needs` : 'A mod needs'} ${dep}, and it is not in your plugins folder. ` +
        'Library mods (HoneyLib, BepInEx utilities and similar) are separate downloads that other mods depend on.',
      mod,
      fix: [
        `Install ${dep} and make sure it is enabled.`,
        'Check the mod page for the exact version it expects - a mismatched major version fails the same way.',
      ],
      action: { kind: 'search', query: dep, label: `Search for ${dep}` },
    }));
  }
  return out;
}

// 5. Skipped for a stated reason (duplicate GUID, wrong BepInEx, bad target).
function ruleSkipped(bep) {
  const out = [];
  for (const l of bep) {
    const m = l.msg.match(/Skipping \[?([^\]\s]+)[^\]]*\]?\s*because\s*(.+)$/i);
    if (!m) continue;
    out.push(finding({
      id: `skipped:${m[1]}`,
      severity: 'high',
      title: `${m[1]} was skipped by the loader`,
      detail: `BepInEx refused to load it: ${m[2]}`,
      mod: m[1],
      fix: /same guid|already loaded/i.test(m[2])
        ? ['You have two copies of this mod installed. Delete the older one.']
        : ['Check the mod supports this BepInEx version, then reinstall it.'],
    }));
  }
  return out;
}

// 6. A mod threw while starting up. It is installed and loaded but dead, and
//    it may have taken the game down with it.
function ruleStartupException(bep) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < bep.length; i++) {
    const l = bep[i];
    if (!/^(Error|Fatal)$/i.test(l.level)) continue;
    if (!/exception|error occurred|failed to/i.test(l.msg)) continue;
    // Already covered, and with a far better explanation, by rules 3 and 4.
    if (/MissingMethod|MissingField|TypeLoad|Could not load file or assembly/i.test(l.msg)) continue;
    const mod = l.source && !/^BepInEx$/i.test(l.source) ? l.source : null;
    if (!mod || seen.has(mod)) continue;
    seen.add(mod);
    // Carry the first stack line - it is what an author needs in a report.
    const trace = (bep[i + 1] && !bep[i + 1].level ? bep[i + 1].msg : '').trim();
    out.push(finding({
      id: `threw:${mod}`,
      severity: 'high',
      title: `${mod} crashed while starting`,
      detail: `${mod} threw an error as it loaded, so it is not doing anything this session${trace ? `. First line of the error: ${trace.slice(0, 160)}` : '.'}`,
      mod,
      fix: [
        `Update ${mod} if an update exists.`,
        `Disable ${mod} and relaunch to confirm it is the cause.`,
        'If it persists on the newest version, send the author this log line.',
      ],
      action: { kind: 'mod', mod, label: `Find ${mod}` },
    }));
  }
  return out;
}

// 7. Excalibur's own core. These are OUR failures and we can be precise.
function ruleExcaliburCore(bep) {
  const out = [];
  const has = (re) => bep.some((l) => re.test(l.msg));
  if (has(/desktop sent no JWT|JWT invalid or missing/i)) {
    out.push(finding({
      id: 'excalibur-signed-out',
      severity: 'high',
      title: 'Excalibur features were locked - you were signed out',
      detail:
        'The game asked the desktop app for your sign-in and got nothing back, so every Excalibur feature stayed off: no wristband, no camera, no nametags. ' +
        'This is the mod behaving correctly - it will not unlock paid features without a verified account.',
      fix: [
        'Sign in to Excalibur on the desktop, then launch again.',
        'If you were signed in, your session expired or the signing keys changed - signing in again fixes both.',
      ],
    }));
  }
  if (has(/Excalibur bootstrap online/i) && !has(/core received/i)) {
    out.push(finding({
      id: 'excalibur-core-not-streamed',
      severity: 'critical',
      title: 'Excalibur never sent its core to the game',
      detail: 'The in-game bootstrap started and asked the desktop app for the mod core, but nothing arrived. The app was closed, still starting, or something blocked the local connection.',
      fix: [
        'Keep Excalibur open while launching, and launch from Excalibur.',
        'If it keeps happening, a firewall or security tool is blocking the local connection on port 52137.',
      ],
    }));
  }
  return out;
}

// 8. Environment: no headset. Explains "it launched in a window" without the
//    user thinking their mods broke.
function ruleNoHeadset(unity) {
  if (!/VRInitError_Init_HmdNotFound|Could not initialize OpenVR/i.test(unity)) return [];
  return [finding({
    id: 'no-headset',
    severity: 'low',
    title: 'The game ran without a headset',
    detail: 'SteamVR reported no headset connected, so Gorilla Tag started in flat/desktop mode. That is a normal fallback, not a mod problem - but VR-only features have nothing to attach to.',
    fix: ['Connect and wake the headset before launching if you meant to play in VR.'],
  })];
}

// 9. Did the last session actually crash, or exit cleanly? Unity shuts down
//    through a recognisable sequence; a log that just stops did not.
function ruleCrashSignature(unityPrev, label) {
  if (!unityPrev) return [];
  if (/Crash!!!|Unity Player \[version.*\] \(.*\) crash|Stack overflow|Access violation/i.test(unityPrev)) {
    const mod = (unityPrev.match(/at ([A-Za-z0-9_.]+)\s*\(/) || [])[1] || '';
    return [finding({
      id: 'hard-crash',
      severity: 'critical',
      title: `The ${label} session crashed`,
      detail: `Gorilla Tag terminated abnormally${mod ? `, with \`${mod}\` on the stack` : ''}. The mod-loader findings above are the place to look for the cause.`,
      fix: [
        'Work through any high-severity findings above first.',
        'If none apply, disable half your mods and relaunch to bisect which one is responsible.',
      ],
    })];
  }
  const clean = /Input System module state changed to: Shutdown|Cleanup current backend/i.test(unityPrev);
  if (!clean) {
    return [finding({
      id: 'ended-abruptly',
      severity: 'medium',
      title: `The ${label} session ended without shutting down`,
      detail: 'The log stops mid-session with none of Unity\'s usual shutdown lines. That is what a hard crash, a force-quit or a power loss looks like.',
      fix: ['If you did not close it yourself, treat any high-severity finding above as the likely cause.'],
    })];
  }
  return [];
}

// ── Cross-reference: enabled on disk vs actually loaded ────────────────────
// The loader prints one line per plugin it loads. Anything enabled in the
// folder that never appears there failed silently, which is the single most
// confusing failure mode there is.
function ruleSilentlyMissing(bep, ctx) {
  if (!ctx.enabledMods?.length) return [];
  const logText = bep.map((l) => l.raw).join('\n').toLowerCase();
  const missing = ctx.enabledMods.filter((m) => {
    const n = baseName(m).toLowerCase();
    return n && !logText.includes(n);
  });
  // If NOTHING loaded, rule 2 already says so far better than a 12-item list.
  if (!missing.length || missing.length === ctx.enabledMods.length) return [];
  return [finding({
    id: 'silently-missing',
    severity: 'high',
    title: `${missing.length} enabled mod(s) never appeared in the loader`,
    detail:
      `These are switched on in Excalibur but the loader never mentioned them: ${missing.slice(0, 8).join(', ')}` +
      `${missing.length > 8 ? `, and ${missing.length - 8} more` : ''}. ` +
      'A mod that loads prints its name; one that does not is either not really in the plugins folder, or is not a BepInEx plugin at all.',
    fix: [
      'Open the plugins folder and confirm the files are actually there.',
      'A .dll that is a library rather than a plugin will never print a line - that is normal for dependencies.',
    ],
    action: { kind: 'open-plugins', label: 'Open plugins folder' },
  })];
}

// ── Entry point ────────────────────────────────────────────────────────────

function readIf(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
}

/**
 * @param {object} opts
 *   gamePath       - the Gorilla Tag folder
 *   enabledMods    - base names of mods currently enabled (for cross-reference)
 * @returns {{ok:boolean, data?:object, error?:string}}
 */
function diagnose(opts = {}) {
  const gamePath = opts.gamePath || '';
  const enabledMods = Array.isArray(opts.enabledMods) ? opts.enabledMods : [];

  const bepPath = gamePath ? path.join(gamePath, 'BepInEx', 'LogOutput.log') : '';
  const lowBase = path.join(os.homedir(), 'AppData', 'LocalLow', 'Another Axiom', 'Gorilla Tag');
  const playerPath = path.join(lowBase, 'Player.log');
  const prevPath = path.join(lowBase, 'Player-prev.log');

  const bepText = bepPath ? readIf(bepPath) : null;
  const playerText = readIf(playerPath);
  const prevText = readIf(prevPath);

  const sources = [
    { name: 'Mod loader (BepInEx)', path: bepPath, found: !!bepText, lines: bepText ? bepText.split(/\r?\n/).length : 0 },
    { name: 'Game (this session)', path: playerPath, found: !!playerText, lines: playerText ? playerText.split(/\r?\n/).length : 0 },
    { name: 'Game (previous session)', path: prevPath, found: !!prevText, lines: prevText ? prevText.split(/\r?\n/).length : 0 },
  ];

  const bep = parseBepInEx(bepText || '');
  const ctx = { enabledMods, enabledModCount: enabledMods.length };

  let findings = [
    ...ruleLoaderMissing(bep),
    ...rulePluginCount(bep, ctx),
    ...ruleStaleAgainstGame(bep),
    ...ruleMissingDependency(bep),
    ...ruleSkipped(bep),
    ...ruleStartupException(bep),
    ...ruleExcaliburCore(bep),
    ...ruleSilentlyMissing(bep, ctx),
    ...ruleNoHeadset([playerText, prevText].filter(Boolean).join('\n')),
    ...ruleCrashSignature(playerText, 'last'),
    ...ruleCrashSignature(prevText, 'previous'),
  ];

  // De-dupe by id, keep the highest severity, then rank.
  const byId = new Map();
  for (const f of findings) {
    const prev = byId.get(f.id);
    if (!prev || SEV[f.severity] > SEV[prev.severity]) byId.set(f.id, f);
  }
  findings = [...byId.values()].sort((a, b) => SEV[b.severity] - SEV[a.severity]);

  const worst = findings[0] || null;
  const summary = !bepText
    ? 'No mod-loader log found, so the loader never ran with this game folder.'
    : findings.length === 0
      ? 'Nothing looks wrong. The loader started, no mod reported an error, and the last session shut down cleanly.'
      : worst.title;

  // Raw error lines, for the "show me the log" drawer and for pasting into a
  // report. Noise-filtered, capped.
  const rawErrors = bep
    .filter((l) => /^(Error|Fatal|Warning)$/i.test(l.level) && !isNoise(l.raw))
    .slice(-40)
    .map((l) => l.raw);

  return {
    ok: true,
    data: {
      scannedAt: new Date().toISOString(),
      sources,
      summary,
      findings,
      rawErrors,
      counts: {
        critical: findings.filter((f) => f.severity === 'critical').length,
        high: findings.filter((f) => f.severity === 'high').length,
        medium: findings.filter((f) => f.severity === 'medium').length,
        low: findings.filter((f) => f.severity === 'low').length,
      },
    },
  };
}

module.exports = { diagnose, parseBepInEx, baseName };
