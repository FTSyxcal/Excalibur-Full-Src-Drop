'use strict';

// Run: node electron/launch-args.test.cjs
//
// Covers buildExtraArgs - the Unity command-line the launch options compile to.
//
// The bug this locks down: "borderless" (and "fullscreen") emitted
// `-screen-fullscreen 0 -popupwindow` with NO -screen-width/-screen-height
// whenever the resolution was left on "default". Unity then falls back to its
// PERSISTED window size, which on a fresh profile is its stock 1024x768 - so a
// "borderless fullscreen" launch opened a small 4:3 box on a 1920x1080 display
// instead of covering it. Real registry state from that machine:
//   Screenmanager Resolution Width  = 1024   (Width Default  = 1024)
//   Screenmanager Resolution Height = 768    (Height Default = 768)
// Note the DEFAULTS are 1024x768 too, so the display-restore path cannot fix
// this - the size has to be passed explicitly at launch.

const assert = require('assert');
const { buildExtraArgs } = require('./steam.cjs');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL: ${label}`); } };
const eqArr = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};
// Read the value that follows a flag, so assertions don't depend on arg order.
const valAfter = (args, flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };

const NATIVE = [1920, 1080];

// ── The regression: borderless + default resolution must be sized ───────────
{
  const args = buildExtraArgs({ displayMode: 'borderless', resolution: 'default' }, NATIVE);
  ok('borderless/default: passes -screen-width', args.includes('-screen-width'));
  ok('borderless/default: passes -screen-height', args.includes('-screen-height'));
  ok('borderless/default: width is the display native, not 1024', valAfter(args, '-screen-width') === '1920');
  ok('borderless/default: height is the display native, not 768', valAfter(args, '-screen-height') === '1080');
  ok('borderless/default: still borderless', args.includes('-popupwindow') && valAfter(args, '-screen-fullscreen') === '0');
}

// Exclusive fullscreen has the same fallback problem - a stretched 1024x768.
{
  const args = buildExtraArgs({ displayMode: 'fullscreen', resolution: 'default' }, NATIVE);
  ok('fullscreen/default: width is native', valAfter(args, '-screen-width') === '1920');
  ok('fullscreen/default: height is native', valAfter(args, '-screen-height') === '1080');
  ok('fullscreen/default: still exclusive fullscreen', valAfter(args, '-screen-fullscreen') === '1');
}

// ── An explicit resolution always wins over the native fallback ─────────────
{
  const args = buildExtraArgs({ displayMode: 'borderless', resolution: '720' }, NATIVE);
  ok('explicit 720 beats native: width', valAfter(args, '-screen-width') === '1280');
  ok('explicit 720 beats native: height', valAfter(args, '-screen-height') === '720');
  ok('explicit 720: -screen-width appears exactly once',
    args.filter((a) => a === '-screen-width').length === 1);
}

// ── Windowed keeps Unity's own window size ─────────────────────────────────
// "Windowed" means a window; forcing it to the full display would make it
// indistinguishable from fullscreen-with-a-titlebar. Only the two modes that
// are SUPPOSED to cover the screen get the native fallback.
{
  const args = buildExtraArgs({ displayMode: 'windowed', resolution: 'default' }, NATIVE);
  ok('windowed/default: no forced size', !args.includes('-screen-width'));
  ok('windowed/default: is windowed', valAfter(args, '-screen-fullscreen') === '0');
  ok('windowed/default: not borderless', !args.includes('-popupwindow'));
}

// ── No native resolution available: degrade to the old behaviour ────────────
// nativeResolutionFor() returns null outside Electron / if the screen API
// throws. Launch must still work rather than emitting "-screen-width null".
{
  const args = buildExtraArgs({ displayMode: 'borderless', resolution: 'default' }, null);
  ok('no native info: omits -screen-width entirely', !args.includes('-screen-width'));
  ok('no native info: never emits a null/undefined value',
    !args.some((a) => a === 'null' || a === 'undefined' || a == null));
  ok('no native info: still borderless', args.includes('-popupwindow'));
}

// ── Everything off = no args at all ────────────────────────────────────────
{
  eqArr('all defaults: empty arg list',
    buildExtraArgs({ displayMode: 'default', resolution: 'default', monitor: 'default', frameRate: 'default' }, NATIVE),
    []);
  eqArr('empty options object: empty arg list', buildExtraArgs({}, NATIVE), []);
  eqArr('no options at all: empty arg list', buildExtraArgs(undefined, NATIVE), []);
}

// ── The untouched passthroughs still work ──────────────────────────────────
{
  const args = buildExtraArgs(
    { displayMode: 'default', resolution: 'default', monitor: '2', frameRate: '120', customArgs: '  -foo   -bar  ' },
    NATIVE
  );
  ok('monitor passthrough', valAfter(args, '-monitor') === '2');
  ok('frameRate passthrough', valAfter(args, '-max-frame-rate') === '120');
  ok('customArgs split on whitespace', args.includes('-foo') && args.includes('-bar'));
  ok('customArgs does not leave empty strings', !args.some((a) => a === ''));
  ok('monitor=default is not passed', !buildExtraArgs({ monitor: 'default' }, NATIVE).includes('-monitor'));
}

// ── Frame rate: presets, typed customs, unlimited, junk ────────────────────
{
  const fpsOf = (frameRate) => valAfter(buildExtraArgs({ frameRate }, NATIVE), '-max-frame-rate');

  ok('preset passes through',            fpsOf('144') === '144');
  ok('custom typed value passes through', fpsOf('75') === '75');
  ok('unlimited becomes Unity -1',        fpsOf('unlimited') === '-1');
  ok('unlimited is case-insensitive',     fpsOf('Unlimited') === '-1');
  ok('default passes no flag',            fpsOf('default') === null);
  ok('missing passes no flag',            fpsOf(undefined) === null);

  // A hand-edited config reaches this function without passing through the UI,
  // and these values land on a spawn line.
  ok('junk is dropped, not forwarded',    fpsOf('nonsense') === null);
  ok('injected args are dropped',         fpsOf('120 -popupwindow') === null);
  ok('zero is dropped',                   fpsOf('0') === null);
  ok('negative is dropped',               fpsOf('-5') === null);
  ok('absurd value is clamped to the max', fpsOf('999999') === '10000');
  ok('at the max, unclamped',             fpsOf('10000') === '10000');
}

console.log(`\n=== launch args: ${pass} pass / ${fail} fail ===`);
assert.strictEqual(fail, 0, `${fail} launch-arg assertion(s) failed`);
