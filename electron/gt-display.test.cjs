'use strict';

// Run: node electron/gt-display.test.cjs
// Verifies the pure parse/compute logic against a real `reg query` sample of a
// machine in the BROKEN state (Fullscreen mode = 2/MaximizedWindow, native off,
// forced 1920x1017) - the exact state this fix addresses.

const assert = require('assert');
const { parseRegQuery, computeRestoreWrites } = require('./gt-display.cjs');

// Real sample captured from HKCU\Software\Another Axiom\Gorilla Tag.
const SAMPLE = [
  'HKEY_CURRENT_USER\\Software\\Another Axiom\\Gorilla Tag',
  '    UnitySelectMonitor_h17969598    REG_DWORD    0x0',
  '    Screenmanager Window Position X_h4088080503    REG_DWORD    0x0',
  '    Screenmanager Resolution Width_h182942802    REG_DWORD    0x780',   // 1920
  '    Screenmanager Resolution Height_h2627697771    REG_DWORD    0x3f9', // 1017
  '    Screenmanager Resolution Use Native_h1405027254    REG_DWORD    0x0',
  '    Screenmanager Fullscreen mode_h3630240806    REG_DWORD    0x2',     // MaximizedWindow
  '    Screenmanager Resolution Width Default_h680557497    REG_DWORD    0x400',  // 1024
  '    Screenmanager Resolution Height Default_h1380706816    REG_DWORD    0x300', // 768
  '    Screenmanager Resolution Use Native Default_h1405981789    REG_DWORD    0x1',
  '    Screenmanager Fullscreen mode Default_h401710285    REG_DWORD    0x1',      // FullScreenWindow
].join('\r\n');

// --- parse ---
const values = parseRegQuery(SAMPLE);
assert.strictEqual(values.length, 10, `expected 10 parsed values, got ${values.length}`);
assert.ok(values.every((v) => v.name && v.type && v.data !== undefined), 'every value has name/type/data');
// Names with spaces must survive intact.
assert.ok(values.some((v) => v.name === 'Screenmanager Fullscreen mode_h3630240806'), 'preserved spaced name');

// --- compute restore ---
const writes = computeRestoreWrites(values);
const byPrefix = Object.fromEntries(writes.map((w) => [w.name.replace(/_h\d+$/, ''), w.value]));

assert.strictEqual(byPrefix['Screenmanager Fullscreen mode'], 1, 'fullscreen mode -> 1 (FullScreenWindow)');
assert.strictEqual(byPrefix['Screenmanager Resolution Use Native'], 1, 'use native -> 1');
assert.strictEqual(byPrefix['Screenmanager Resolution Width'], 1024, 'width -> default 1024');
assert.strictEqual(byPrefix['Screenmanager Resolution Height'], 768, 'height -> default 768');
assert.ok(!('UnitySelectMonitor' in byPrefix), 'monitor already 0 -> no write');
assert.strictEqual(writes.length, 4, `expected exactly 4 writes, got ${writes.length}`);

// --- idempotency: applying the writes then recomputing yields nothing ---
const restored = values.map((v) => {
  const w = writes.find((x) => x.name === v.name);
  return w ? { ...v, data: '0x' + w.value.toString(16) } : v;
});
assert.strictEqual(computeRestoreWrites(restored).length, 0, 'idempotent: no writes once already at defaults');

// --- already-clean machine: live == default everywhere -> no writes ---
const CLEAN = [
  'HKEY_CURRENT_USER\\Software\\Another Axiom\\Gorilla Tag',
  '    Screenmanager Fullscreen mode_h3630240806    REG_DWORD    0x1',
  '    Screenmanager Fullscreen mode Default_h401710285    REG_DWORD    0x1',
  '    Screenmanager Resolution Use Native_h1405027254    REG_DWORD    0x1',
  '    Screenmanager Resolution Use Native Default_h1405981789    REG_DWORD    0x1',
  '    UnitySelectMonitor_h17969598    REG_DWORD    0x0',
].join('\r\n');
assert.strictEqual(computeRestoreWrites(parseRegQuery(CLEAN)).length, 0, 'clean machine -> no writes');

// --- monitor override gets reset ---
const MON = [
  'HKEY_CURRENT_USER\\Software\\Another Axiom\\Gorilla Tag',
  '    UnitySelectMonitor_h17969598    REG_DWORD    0x1',
].join('\r\n');
const monWrites = computeRestoreWrites(parseRegQuery(MON));
assert.strictEqual(monWrites.length, 1, 'monitor override -> 1 write');
assert.strictEqual(monWrites[0].value, 0, 'monitor reset to 0');

console.log('PASS: gt-display parse + restore logic (broken sample -> 4 writes, idempotent, clean -> 0, monitor reset)');
