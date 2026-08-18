'use strict';

// Integrity tests for the curated download path.
//
// Curated mods had NO integrity check of any kind, while the community install
// path already refused to write on a hash mismatch. The catalogue presented to
// users as the safe one was the less verified of the two, and `runAutoUpdates`
// re-fetches these URLs unattended at boot, overwriting the live file in place.
// So the failure mode was: a proxy or captive portal answers 200 with HTML, that
// HTML lands on top of a working mod, and nothing anywhere notices - the file
// hashes fine and describeDll falls back to the filename, so it renders as a
// perfectly ordinary installed mod that simply never loads.
//
// Every case below writes to a REAL temporary game folder and then asserts what
// is on disk afterwards, because "it threw" is not the same claim as "the user's
// working mod survived".
//
// Run: node electron/mod-downloader.test.cjs
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// The logger pulls in electron; stub it before requiring the unit under test.
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './logger.cjs') return { logInfo() {}, logError() {} };
  return realRequire.apply(this, arguments);
};

const downloader = require('./mod-downloader.cjs');

let passed = 0;
const ok = (label, cond) => { assert.ok(cond, label); passed++; console.log(`  ok  ${label}`); };

const MZ = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 7)]);          // a plausible managed assembly
const PK = Buffer.concat([Buffer.from('PK'), Buffer.alloc(64)]);  // a plausible zip
const HTML = Buffer.from('<!doctype html><html>Sign in to continue</html>');
const shaOf = (b) => crypto.createHash('sha256').update(b).digest('hex');

const ORIGINAL = 'ORIGINAL-WORKING-MOD';

function freshGame() {
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'excalibur-dl-'));
  fs.mkdirSync(path.join(game, 'BepInEx', 'plugins'), { recursive: true });
  const target = path.join(game, 'BepInEx', 'plugins', 'Demo.dll');
  fs.writeFileSync(target, Buffer.from(ORIGINAL));
  return { game, target };
}

const serve = (body) => {
  globalThis.fetch = async () => new Response(body, {
    status: 200,
    headers: { 'content-length': String(body.length) },
  });
};

async function attemptUpdate({ game, target }, body, expectedSha256, url) {
  serve(body);
  try {
    await downloader.updateMod(game, {
      name: 'Demo',
      baseName: 'Demo.dll',
      currentPath: target,
      downloadUrl: url || 'https://github.com/owner/repo/releases/latest/download/Demo.dll',
      expectedSha256,
    });
    return { wrote: true };
  } catch (e) {
    return { wrote: false, message: e.message };
  }
}

(async () => {
  console.log('mod-downloader integrity');

  // 1. The happy path still works, or the check is worthless.
  {
    const g = freshGame();
    const r = await attemptUpdate(g, MZ, shaOf(MZ));
    ok('a download matching its expected hash is written', r.wrote);
    ok('and the bytes on disk are the new ones', fs.readFileSync(g.target).slice(0, 2).toString() === 'MZ');
    fs.rmSync(g.game, { recursive: true, force: true });
  }

  // 2. A hash mismatch must not reach disk AT ALL.
  {
    const g = freshGame();
    const r = await attemptUpdate(g, MZ, 'f'.repeat(64));
    ok('a hash mismatch is refused', !r.wrote);
    ok('the message says nothing was written', /nothing was written/i.test(r.message));
    ok('the user\'s working mod is untouched', fs.readFileSync(g.target).toString() === ORIGINAL);
    fs.rmSync(g.game, { recursive: true, force: true });
  }

  // 3. The captive-portal case: HTTP 200, wrong content, no hash to compare.
  {
    const g = freshGame();
    const r = await attemptUpdate(g, HTML, null);
    ok('an HTML page served with HTTP 200 is refused even with no expected hash', !r.wrote);
    ok('and says so in language a player can act on', /sign-in page|did not download correctly/i.test(r.message));
    ok('the working mod survives', fs.readFileSync(g.target).toString() === ORIGINAL);
    fs.rmSync(g.game, { recursive: true, force: true });
  }

  // 4. Unknown hash must DEGRADE, not block. Null means "we cannot know", and
  //    treating it as a failure would break every mod the poller has not hashed.
  {
    const g = freshGame();
    const r = await attemptUpdate(g, MZ, null);
    ok('a download with no expected hash still installs', r.wrote);
    fs.rmSync(g.game, { recursive: true, force: true });
  }

  // 5. A zip URL must expect zip bytes, and a signed URL with a query string is
  //    still a zip. Getting this wrong would reject every community archive.
  {
    const g = freshGame();
    const zipUrl = 'https://github.com/owner/repo/releases/latest/download/Demo.zip?token=abc123';
    const r = await attemptUpdate(g, MZ, null, zipUrl);
    ok('a .zip?token=... URL that returns DLL bytes is refused', !r.wrote);
    fs.rmSync(g.game, { recursive: true, force: true });
  }
  {
    const g = freshGame();
    const zipUrl = 'https://github.com/owner/repo/releases/latest/download/Demo.zip?token=abc123';
    const r = await attemptUpdate(g, PK, null, zipUrl);
    // adm-zip will reject these 68 bytes as a malformed archive, which is fine:
    // what matters is that it got PAST the magic-byte gate rather than being
    // rejected for "not a mod file".
    ok('a .zip?token=... URL returning zip bytes passes the content gate',
      r.wrote || !/not a mod file|not a zip archive/i.test(r.message || ''));
    fs.rmSync(g.game, { recursive: true, force: true });
  }

  console.log(`\nmod-downloader integrity: ${passed} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
