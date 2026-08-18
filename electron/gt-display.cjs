'use strict';

// Gorilla Tag stores its desktop window mode + resolution in Unity PlayerPrefs
// under HKCU\Software\Another Axiom\Gorilla Tag. When Excalibur launches the
// game with -screen-* / -popupwindow / -monitor args, Unity PERSISTS those
// values, so a later *plain* Steam launch inherits a windowed/decorated mode
// (the title bar bug) or a forced, non-native resolution.
//
// After an Excalibur-launched session ends, we copy each live "Screenmanager"
// value back to its "<name> Default" counterpart - the value Unity itself
// writes from the game's Player Settings (a fresh install's state). That puts
// plain Steam launches back to Gorilla Tag's normal borderless-fullscreen /
// native resolution. The user's chosen launch options stay saved in
// Excalibur's own config, so the next Excalibur launch re-applies them.
//
// Keys are matched by NAME PREFIX, not by the hashed full name (e.g.
// "Screenmanager Fullscreen mode_h3630240806"), so this survives Unity builds
// where the _h<hash> suffix differs.

const { execFileSync } = require('child_process');
const { logInfo, logError } = require('./logger.cjs');

const GT_KEY = 'HKCU\\Software\\Another Axiom\\Gorilla Tag';

// Live Screenmanager keys to reset; each is restored to "<prefix> Default".
const RESTORE_PREFIXES = [
  'Screenmanager Fullscreen mode',
  'Screenmanager Resolution Width',
  'Screenmanager Resolution Height',
  'Screenmanager Resolution Use Native',
];

// Parse `reg query <key>` stdout into [{ name, type, data }]. Value lines are
// indented and separated by runs of 2+ spaces:
//     "    Screenmanager Fullscreen mode_h3630240806    REG_DWORD    0x2"
// (value names contain single spaces, so we split on 2+ spaces only.)
function parseRegQuery(text) {
  const values = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/);
    if (m) values.push({ name: m[1], type: m[2], data: m[3].trim() });
  }
  return values;
}

function toInt(data) {
  if (data == null) return NaN;
  const s = String(data).trim();
  return s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pure: given parsed registry values, compute the DWORD writes needed to
// restore GT's display defaults. Returns [{ name, value }] for keys whose live
// value differs from its default (so a no-op state produces no writes).
function computeRestoreWrites(values) {
  const writes = [];
  const find = (re) => values.find((v) => re.test(v.name));
  for (const prefix of RESTORE_PREFIXES) {
    const live = find(new RegExp(`^${escapeRe(prefix)}_h\\d+$`));
    const def  = find(new RegExp(`^${escapeRe(prefix)} Default_h\\d+$`));
    if (!live || !def) continue;
    const liveVal = toInt(live.data);
    const defVal  = toInt(def.data);
    if (Number.isNaN(defVal)) continue;
    if (liveVal !== defVal) writes.push({ name: live.name, value: defVal });
  }
  // Reset monitor selection to the primary (0). There is no Default counterpart
  // for UnitySelectMonitor, so target 0 explicitly.
  const mon = find(/^UnitySelectMonitor_h\d+$/);
  if (mon && toInt(mon.data) !== 0) writes.push({ name: mon.name, value: 0 });
  return writes;
}

function readValues() {
  // reg query exits non-zero (throws) if the key doesn't exist yet - i.e. the
  // game has never been launched. Callers treat that as "nothing to restore".
  const out = execFileSync('reg', ['query', GT_KEY], { encoding: 'utf8' });
  return parseRegQuery(out);
}

// Restore GT's display PlayerPrefs to its own defaults. Call this ONLY when the
// game is not running - Unity rewrites these keys on game exit, so a mid-game
// restore would simply be overwritten. Never throws.
function restoreGorillaTagDisplayDefaults() {
  try {
    const values = readValues();
    if (!values.length) return { ok: false, reason: 'no-values' };
    const writes = computeRestoreWrites(values);
    for (const w of writes) {
      execFileSync(
        'reg',
        ['add', GT_KEY, '/v', w.name, '/t', 'REG_DWORD', '/d', String(w.value), '/f'],
        { stdio: 'ignore' }
      );
    }
    if (writes.length) {
      logInfo(`[gt-display] restored ${writes.length} display key(s) to GT defaults: ` +
        writes.map((w) => w.name.replace(/_h\d+$/, '')).join(', '));
    }
    return { ok: true, changed: writes.length };
  } catch (e) {
    // Most commonly: the GT registry key doesn't exist (game never launched).
    logError('[gt-display] restore skipped/failed:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

module.exports = {
  GT_KEY,
  parseRegQuery,
  computeRestoreWrites,
  restoreGorillaTagDisplayDefaults,
};
