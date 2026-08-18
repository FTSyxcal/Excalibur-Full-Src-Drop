'use strict';

// Run: node electron/vr-mode.test.cjs
//
// Covers which VR arguments each launch mode passes.
//
// THE BUG: users reported that launching with Meta Quest PCVR "just does NOT
// work", while SteamVR was fine. Quest mode passed `-vrmode Oculus`, and that
// names an XR loader Gorilla Tag does not contain. Read off a real install:
//
//   Gorilla Tag_Data/UnitySubsystems/  ->  UnityOpenXR, XRSDKOpenVR
//   Gorilla Tag_Data/Managed/          ->  Unity.XR.OpenXR.dll,
//                                          Unity.XR.OpenXR.Features.MetaQuestSupport.dll,
//                                          Unity.XR.OpenVR.dll
//                                          ...and NO Unity.XR.Oculus.dll
//   Gorilla Tag_Data/boot.config       ->  xrsdk-pre-init-library=XRSDKOpenVR
//
// The game's runtimes are OpenVR (SteamVR) and OpenXR. `-vrmode` drives Unity's
// LEGACY VRDevice path, which has no OpenXR device at all - so `OpenVR` lines up
// with a loader that exists (SteamVR works) and `Oculus` lines up with nothing.
// Meta's Link runtime is reached through OpenXR, so the right thing to pass for
// Quest is nothing, and let the game's own XR init find the active runtime.
//
// So the assertion that matters is NEGATIVE: Quest mode must never name a
// loader. A future "improvement" that puts a guessed value back - `Oculus`, or
// an invented `-vrmode OpenXR` - fails here.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { vrArgsForMode, activeOpenXrRuntime, questReadinessWarning } = require('./steam.cjs');

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`FAIL: ${label}${extra ? `\n      ${extra}` : ''}`); }
};

// -- SteamVR keeps working exactly as it does today -------------------------
{
  const args = vrArgsForMode('steamvr');
  ok('steamvr passes -vrmode OpenVR', JSON.stringify(args) === JSON.stringify(['-vrmode', 'OpenVR']),
    JSON.stringify(args));
  ok('an unknown/absent mode falls back to OpenVR, not to nothing',
    JSON.stringify(vrArgsForMode()) === JSON.stringify(['-vrmode', 'OpenVR']));
}

// -- Quest names no loader at all -------------------------------------------
{
  const args = vrArgsForMode('quest');
  ok('quest passes no -vrmode', !args.includes('-vrmode'), JSON.stringify(args));
  ok('quest never names the Oculus loader',
    !args.some((a) => /oculus/i.test(String(a))), JSON.stringify(args));
  // Guarding the invented flag too: there is no evidence UnityPlayer accepts
  // `-vrmode OpenXR`, and shipping a guess is the same mistake in a new costume.
  ok('quest does not invent an OpenXR vrmode either',
    !args.some((a) => /openxr/i.test(String(a))), JSON.stringify(args));
  ok('quest passes nothing at all', args.length === 0, JSON.stringify(args));
}

// -- And nowhere in the launcher may that string come back ------------------
{
  const src = fs.readFileSync(path.join(__dirname, 'steam.cjs'), 'utf8');
  // Strip comments: the file EXPLAINS the old flag at length, and a guard that
  // matches its own explanation is a guard that fails forever.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok('no code path pairs -vrmode with Oculus',
    !/-vrmode['"\s,\]]+.{0,20}Oculus/i.test(code));
}

// -- The diagnostic must never throw ----------------------------------------
// It reads the registry, which may hold nothing on a machine with no VR at all.
{
  let threw = null;
  let rt;
  try { rt = activeOpenXrRuntime(); } catch (e) { threw = e; }
  ok('activeOpenXrRuntime never throws', !threw, threw && threw.message);
  ok('it returns a path or null', rt === null || typeof rt === 'string', String(rt));
  if (typeof rt === 'string') {
    console.log(`      (this machine's active OpenXR runtime: ${rt})`);
  }
}

// -- The user has to be TOLD, not just the log file ------------------------
// A Quest launch can start the game perfectly and still never reach the
// headset. Both causes are knowable before launch, so the launcher hands back
// a sentence for the UI. This is the branch that does not depend on the
// machine: no Meta client means Quest mode cannot work, full stop.
{
  const w = questReadinessWarning(false);
  ok('a missing Meta client produces a warning', typeof w === 'string' && w.length > 0);
  ok('the warning names the app the user needs', /Meta Quest Link/i.test(String(w)), String(w));
  // Whatever this machine's runtime is, the function must return either a
  // usable sentence or null - never an object, never undefined.
  const w2 = questReadinessWarning(true);
  ok('a started client returns a sentence or null', w2 === null || typeof w2 === 'string', String(w2));
  if (typeof w2 === 'string') {
    ok('and that sentence says where to change it', /OpenXR|Meta Quest Link/i.test(w2), w2);
  }
}

console.log(`\n=== vr mode: ${pass} pass / ${fail} fail ===`);
assert.strictEqual(fail, 0, `${fail} vr-mode assertion(s) failed`);
