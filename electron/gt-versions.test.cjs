// Run: node electron/gt-versions.test.cjs
//
// The version system's promise is one sentence: the build you picked is the
// build that installs, and the build that installs is the build that launches.
// It did not keep that promise. Steam's `download_depot` writes every version
// into ONE folder with nothing naming the manifest, and this module used to
// read "a Gorilla Tag.exe is present" as "the version you asked for finished
// downloading". So the second version you downloaded silently received the
// first one's files, and every version after that too - the tester reports
// "it's on the wrong version" and "it only ever opens the old one".
//
// These tests drive the REAL module against a fake Steam directory. They are
// the reason to believe the fix, so they check the failure direction (does it
// refuse the wrong files?) at least as hard as the success direction.

const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const Module = require('node:module');

// ── Stub Electron before requiring the module under test ─────────────────
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'gtv-test-'));
const USER = path.join(TMP, 'userData');
const STEAM = path.join(TMP, 'steam');
fs.mkdirSync(USER, { recursive: true });
fs.mkdirSync(STEAM, { recursive: true });
process.env.EXCALIBUR_STEAM_PATH_OVERRIDE = STEAM;

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => USER },
      clipboard: { writeText() {} },
      shell: { openExternal: () => Promise.resolve() },
      BrowserWindow: class {},
    };
  }
  return origLoad.call(this, request, ...rest);
};

const gtv = require('./gt-versions.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? `\n          ${extra}` : ''}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);

const MANIFEST_A = '6335800595095137011';   // Update #109
const MANIFEST_B = '3043321800655748912';   // Update #108
const ID_A = `m_${MANIFEST_A}`;
const ID_B = `m_${MANIFEST_B}`;

const depotDir = path.join(STEAM, 'steamapps', 'content', 'app_1533390', 'depot_1533391');
const pendingPath = path.join(USER, 'gt-versions', '_pending-download.json');

function putFakeBuild(marker, mtime = Date.now()) {
  fs.mkdirSync(depotDir, { recursive: true });
  const exe = path.join(depotDir, 'Gorilla Tag.exe');
  fs.writeFileSync(exe, `fake build: ${marker}`);
  fs.writeFileSync(path.join(depotDir, 'build.txt'), marker);
  fs.utimesSync(exe, new Date(mtime), new Date(mtime));
  return exe;
}
function writeReceipt(manifestId, startedAt = Date.now()) {
  fs.mkdirSync(path.join(USER, 'gt-versions'), { recursive: true });
  fs.writeFileSync(pendingPath, JSON.stringify({ versionId: `m_${manifestId}`, manifestId, startedAt }));
}
function reset() {
  fs.rmSync(path.join(USER, 'gt-versions'), { recursive: true, force: true });
  fs.rmSync(depotDir, { recursive: true, force: true });
}

(async () => {
  console.log('\n-- Version ids state their own manifest -----------------------');
  eq('m_<id> parses', gtv.manifestForVersionId(ID_A), MANIFEST_A);
  eq('current has none', gtv.manifestForVersionId('current'), null);
  eq('junk has none', gtv.manifestForVersionId('m_notanumber'), null);
  eq('null-safe', gtv.manifestForVersionId(null), null);

  console.log('\n-- Steam\'s folder is never trusted on its own -----------------');
  reset();
  putFakeBuild('BUILD-A');
  let r = await gtv.checkSteamFolder({ manifestId: MANIFEST_A });
  ok('files with NO receipt are refused', r.found === false && r.reason === 'no-receipt', JSON.stringify(r));

  // THE BUG, reproduced: user downloaded A earlier, now asks for B. A's files
  // are still sitting in Steam's folder. Old code answered "found" and copied
  // A into B's folder.
  reset();
  writeReceipt(MANIFEST_A, Date.now() - 60_000);
  putFakeBuild('BUILD-A');
  r = await gtv.checkSteamFolder({ manifestId: MANIFEST_B });
  ok('leftover build is NOT adopted by a different version',
    r.found === false && r.reason === 'different-manifest', JSON.stringify(r));
  eq('and it names the build it actually found', r.receiptManifest, MANIFEST_A);

  // Same manifest, but the files predate the request -> stale leftovers of an
  // earlier download of the SAME version, which we also cannot vouch for.
  reset();
  writeReceipt(MANIFEST_A, Date.now());
  putFakeBuild('BUILD-A', Date.now() - 10 * 60_000);
  r = await gtv.checkSteamFolder({ manifestId: MANIFEST_A });
  ok('files older than the request are refused',
    r.found === false && r.reason === 'older-than-request', JSON.stringify(r));

  // The one case that should succeed.
  reset();
  writeReceipt(MANIFEST_A, Date.now() - 5_000);
  putFakeBuild('BUILD-A');
  r = await gtv.checkSteamFolder({ manifestId: MANIFEST_A });
  ok('a receipted, fresh download IS accepted', r.found === true, JSON.stringify(r));

  console.log('\n-- Finalize refuses to mislabel a folder ----------------------');
  reset();
  writeReceipt(MANIFEST_A, Date.now() - 5_000);
  putFakeBuild('BUILD-A');
  let threw = null;
  try { await gtv.finalizeDownload({ versionId: ID_B, manifestId: MANIFEST_B, sourcePath: depotDir }); }
  catch (e) { threw = e.message; }
  ok('installing A\'s files as version B throws', !!threw, String(threw));
  ok('and B is not left half-created', !gtv.isInstalled(ID_B));

  console.log('\n-- A good install is recorded and verifiable ------------------');
  reset();
  writeReceipt(MANIFEST_A, Date.now() - 5_000);
  putFakeBuild('BUILD-A');
  const fin = await gtv.finalizeDownload({ versionId: ID_A, manifestId: MANIFEST_A, sourcePath: depotDir });
  ok('finalize reports the manifest it installed', fin.manifestId === MANIFEST_A);
  ok('the version is installed', gtv.isInstalled(ID_A));
  const info = await gtv.installedInfo(ID_A);
  ok('and it verifies', info.verified === true, JSON.stringify(info));
  ok('Steam\'s folder is emptied afterwards', !fs.existsSync(path.join(depotDir, 'Gorilla Tag.exe')));
  ok('the in-flight receipt is cleared', !fs.existsSync(pendingPath));

  console.log('\n-- Installing over an old build does not blend the two --------');
  // A larger previous build leaves files a smaller one would not overwrite.
  const stray = path.join(gtv.installPath(ID_A), 'LEFTOVER-FROM-OLD-BUILD.dll');
  fs.writeFileSync(stray, 'x');
  writeReceipt(MANIFEST_A, Date.now() - 5_000);
  putFakeBuild('BUILD-A-v2');
  await gtv.finalizeDownload({ versionId: ID_A, manifestId: MANIFEST_A, sourcePath: depotDir });
  ok('previous build\'s stray files are gone', !fs.existsSync(stray));
  eq('and the new payload is what landed',
    fs.readFileSync(path.join(gtv.installPath(ID_A), 'build.txt'), 'utf8'), 'BUILD-A-v2');

  console.log('\n-- Steam\'s console log is read correctly ----------------------');
  // Real lines captured from Steam 1785187029 on Windows.
  const LOG = [
    '[2026-07-28 21:14:48] ExecCommandLine: ""C:\\Program Files (x86)\\Steam\\steam.exe" -console +download_depot 1533390 1533391 2218992975128065135"',
    '[2026-07-28 21:14:48] Downloading depot 1533391 (188 files, 61 MB) ... ',
    '[2026-07-28 21:14:55] Depot download complete : "c:\\program files (x86)\\steam\\steamapps\\content\\app_1533390\\depot_1533391" (manifest 2218992975128065135) ',
  ].join('\n');
  const parsed = gtv.parseDepotLog(LOG);
  eq('reads the file count', parsed.started?.files, 188);
  ok('reads the size', parsed.started?.bytes === 61 * 1024 * 1024, JSON.stringify(parsed.started));
  eq('reads the completed manifest', parsed.complete?.manifestId, '2218992975128065135');
  ok('reads the source path', /depot_1533391$/.test(parsed.complete?.sourcePath || ''), parsed.complete?.sourcePath);
  const failed = gtv.parseDepotLog('[t] Depot download failed : Failed downloading 1 manifests (No connection)');
  eq('reads a failure reason', failed.failed, 'Failed downloading 1 manifests (No connection)');

  console.log('\n-- Steam\'s verdict overrules our own request ------------------');
  // THE LIVE INCIDENT: a download of a DIFFERENT manifest completed while our
  // request for MANIFEST_A was outstanding. Our own receipt still says A - it
  // only ever recorded what we ASKED for - so receipt-only attribution passes
  // and the wrong build gets installed under A's name. Steam's log is the only
  // thing that knows better.
  reset();
  writeReceipt(MANIFEST_A, Date.now() - 5_000);
  putFakeBuild('BUILD-B-SNUCK-IN');
  threw = null;
  try {
    await gtv.finalizeDownload({
      versionId: ID_A, manifestId: MANIFEST_A, sourcePath: depotDir,
      confirmedManifestId: MANIFEST_B,      // what Steam actually finished
    });
  } catch (e) { threw = e.message; }
  ok('finalize refuses when Steam names a different manifest', !!threw, String(threw));
  ok('and names the build Steam actually delivered', /different build/i.test(String(threw)), String(threw));
  ok('nothing was installed', !gtv.isInstalled(ID_A));

  console.log('\n-- Folders that cannot prove themselves are flagged -----------');
  reset();
  writeReceipt(MANIFEST_A, Date.now() - 5_000);
  putFakeBuild('BUILD-A');
  await gtv.finalizeDownload({ versionId: ID_A, manifestId: MANIFEST_A, sourcePath: depotDir, confirmedManifestId: MANIFEST_A });
  // Simulates every install made before receipts existed - the ones that may
  // genuinely be the wrong build on a tester's machine right now.
  fs.rmSync(path.join(gtv.installPath(ID_A), '.excalibur-version.json'), { force: true });
  const legacy = await gtv.installedInfo(ID_A);
  ok('legacy install reads as unverified', legacy.installed === true && legacy.verified === false);
  eq('with a reason the UI can act on', legacy.reason, 'no-receipt');

  // A folder whose receipt names a different build than its own name.
  fs.writeFileSync(path.join(gtv.installPath(ID_A), '.excalibur-version.json'),
    JSON.stringify({ versionId: ID_A, manifestId: MANIFEST_B }));
  const mism = await gtv.installedInfo(ID_A);
  ok('mismatched receipt is caught', mism.verified === false && mism.reason === 'manifest-mismatch',
    JSON.stringify(mism));


  // -- Installing a build while Steam still holds a file --------------------
  // The reported failure was an install that died outright:
  //
  //   EBUSY: resource busy or locked, copyfile
  //   '...depot_1533391\Gorilla Tag_Data\level0.resS' -> '...'
  //
  // The source is Steam's OWN download folder, and Steam routinely keeps a
  // handle open for a second or two after the download "finishes". The copy was
  // a single recursive fs.cp, which is all-or-nothing, so one held file cost the
  // whole install. This takes a REAL exclusive lock rather than mocking the
  // error, because what is being fixed is behaviour against Windows.
  console.log('\n-- A file Steam still has open ------------------------------');
  {
    const src = path.join(TMP, 'lock-src');
    const dst = path.join(TMP, 'lock-dst');
    fs.mkdirSync(path.join(src, 'Gorilla Tag_Data'), { recursive: true });
    fs.writeFileSync(path.join(src, 'Gorilla Tag.exe'), 'exe');
    const locked = path.join(src, 'Gorilla Tag_Data', 'level0.resS');
    fs.writeFileSync(locked, 'x'.repeat(4096));

    let fd = null;
    try { fd = fs.openSync(locked, fs.constants.O_RDONLY | 0x10000000); } catch { /* non-Windows */ }
    let released = false;
    if (fd !== null) setTimeout(() => { try { fs.closeSync(fd); released = true; } catch {} }, 700);

    const t0 = Date.now();
    let err = null;
    try { await gtv.copyTreeWithRetry(src, dst); } catch (e) { err = e; }
    const took = Date.now() - t0;

    ok('a transiently locked file does not fail the install', !err, err && err.message);
    ok('every file still arrives',
      fs.existsSync(path.join(dst, 'Gorilla Tag_Data', 'level0.resS'))
      && fs.existsSync(path.join(dst, 'Gorilla Tag.exe')));
    if (fd !== null) ok('it waited for the lock instead of racing it', released && took >= 200,
      'released=' + released + ' took=' + took + 'ms');
  }


  // -- Replacing a version the game is still holding ------------------------
  // The install wipes the destination before copying, so a lock on the OLD
  // copy fails the install before the copy is even reached. Same class of bug,
  // different verb, and equally invisible until you take a real lock.
  console.log('\n-- Replacing a build that is still open ---------------------');
  {
    const dir = path.join(TMP, 'rm-lock');
    fs.mkdirSync(path.join(dir, 'Gorilla Tag_Data'), { recursive: true });
    const held = path.join(dir, 'Gorilla Tag_Data', 'held.dll');
    fs.writeFileSync(held, 'dll');
    fs.writeFileSync(path.join(dir, 'Gorilla Tag.exe'), 'exe');

    let fd = null;
    try { fd = fs.openSync(held, fs.constants.O_RDONLY | 0x10000000); } catch {}
    if (fd !== null) setTimeout(() => { try { fs.closeSync(fd); } catch {} }, 700);

    let err = null;
    try { await gtv.rmTreeWithRetry(dir); } catch (e) { err = e; }
    ok('a locked old build does not fail the wipe', !err, err && err.message);
    ok('the old build is actually gone', !fs.existsSync(dir));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} - ${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('test harness crashed:', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
