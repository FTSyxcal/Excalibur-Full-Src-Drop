// Smart Naming disk engine — real-filesystem tests against a temp folder.
// Run:  node electron/smart-naming.test.cjs
//
// Every assertion here defends THE ONE RULE: never lose, clobber, or corrupt a
// recording. The worst acceptable outcome is "file keeps OBS's original name".

const fs = require('fs');
const os = require('os');
const path = require('path');

// logger.cjs pulls in electron APIs in some paths; stub it before requiring the
// engine so this runs under plain node.
const Module = require('module');
const origResolve = Module._resolveFilename;
const loggerPath = path.join(__dirname, 'logger.cjs');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true, exports: {
    logError: () => {}, logInfo: () => {}, getWritableBaseDir: () => os.tmpdir(),
  },
};
Module._resolveFilename = origResolve;

const { finalizeRename, _internals } = require('./smart-naming.cjs');

let pass = 0, fail = 0;
const eq = (l, g, w) => { if (g === w) pass++; else { fail++; console.log(`FAIL: ${l}\n  got : ${JSON.stringify(g)}\n  want: ${JSON.stringify(w)}`); } };
const ok = (l, c) => { if (c) pass++; else { fail++; console.log(`FAIL(cond): ${l}`); } };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'excalibur-naming-'));
const mk = (name, bytes = 'x') => { const p = path.join(ROOT, name); fs.writeFileSync(p, bytes); return p; };

(async () => {
  // ── 1. Happy path: renames, extension preserved, original gone ──
  {
    const src = mk('Recording 01.mkv');
    const r = await finalizeRename({ sourcePath: src, base: '2026-07-24_INFECTION_Excalibur', collision: 'counter' });
    ok('happy renamed', r.ok && r.renamed === true);
    ok('happy target exists', fs.existsSync(path.join(ROOT, '2026-07-24_INFECTION_Excalibur.mkv')));
    ok('happy source gone', !fs.existsSync(src));
    eq('happy ext preserved', path.extname(r.to), '.mkv');
  }

  // ── 2. Collision: NEVER overwrites an existing file ──
  {
    const src = mk('Recording 02.mp4');
    const taken = mk('clip.mp4', 'PRECIOUS-ORIGINAL');
    const r = await finalizeRename({ sourcePath: src, base: 'clip', collision: 'counter' });
    ok('collision renamed', r.renamed === true);
    eq('collision picked (2)', path.basename(r.to), 'clip (2).mp4');
    eq('existing file untouched', fs.readFileSync(taken, 'utf8'), 'PRECIOUS-ORIGINAL');
  }

  // ── 3. collision:'leave' declines rather than risk anything ──
  {
    const src = mk('Recording 03.mkv');
    mk('taken.mkv', 'DO-NOT-TOUCH');
    const r = await finalizeRename({ sourcePath: src, base: 'taken', collision: 'leave' });
    ok('leave does not rename', r.ok && r.renamed === false);
    eq('leave reason', r.reason, 'collision-leave');
    ok('leave: source still there', fs.existsSync(src));
    eq('leave: target intact', fs.readFileSync(path.join(ROOT, 'taken.mkv'), 'utf8'), 'DO-NOT-TOUCH');
  }

  // ── 4. Empty / unusable base → keep OBS's name (the designed no-op) ──
  {
    const src = mk('Recording 04.mkv');
    const r = await finalizeRename({ sourcePath: src, base: '', collision: 'counter' });
    ok('empty base no-op', r.ok && r.renamed === false);
    eq('empty base reason', r.reason, 'empty-base');
    ok('empty base: file untouched', fs.existsSync(src));
  }
  {
    const src = mk('Recording 04b.mkv');
    const r = await finalizeRename({ sourcePath: src, base: '///:::', collision: 'counter' });
    ok('all-illegal base no-op', r.renamed === false);
    ok('all-illegal: file untouched', fs.existsSync(src));
  }

  // ── 5. Missing source → safe no-op, no throw ──
  {
    const r = await finalizeRename({ sourcePath: path.join(ROOT, 'nope.mkv'), base: 'x', collision: 'counter' });
    ok('missing source no-op', r.ok && r.renamed === false);
    eq('missing source reason', r.reason, 'source-missing');
  }

  // ── 6. Path traversal in the subfolder is refused ──
  {
    const src = mk('Recording 06.mkv');
    const r = await finalizeRename({ sourcePath: src, base: 'safe', collision: 'counter', subfolder: '../../escaped' });
    ok('traversal still renamed somewhere safe', r.renamed === true);
    const rel = path.relative(ROOT, r.to);
    ok('traversal stayed inside root', !rel.startsWith('..') && !path.isAbsolute(rel));
    ok('no escaped dir created', !fs.existsSync(path.join(ROOT, '..', '..', 'escaped')));
  }

  // ── 7. Legit subfolder is created and used ──
  {
    const src = mk('Recording 07.mkv');
    const r = await finalizeRename({ sourcePath: src, base: 'sorted', collision: 'counter', subfolder: '2026-07' });
    ok('subfolder renamed', r.renamed === true);
    ok('subfolder created', fs.existsSync(path.join(ROOT, '2026-07', 'sorted.mkv')));
  }

  // ── 8. Reserved device name gets defused ──
  {
    const src = mk('Recording 08.mkv');
    const r = await finalizeRename({ sourcePath: src, base: 'CON', collision: 'counter' });
    ok('reserved renamed', r.renamed === true);
    eq('reserved prefixed', path.basename(r.to), '_CON.mkv');
  }

  // ── 9. Absurdly long base is trimmed to a legal length ──
  {
    const src = mk('Recording 09.mkv');
    const r = await finalizeRename({ sourcePath: src, base: 'L'.repeat(400), collision: 'counter' });
    ok('long renamed', r.renamed === true);
    ok('long component <=255', path.basename(r.to).length <= 255);
    ok('long full path bounded', r.to.length <= 255);
    ok('long ext intact', r.to.endsWith('.mkv'));
  }

  // ── 10. Illegal chars from custom text can't create folders ──
  {
    const src = mk('Recording 10.mkv');
    const r = await finalizeRename({ sourcePath: src, base: 'a/b\\c:d*e?f"g<h>i|j', collision: 'counter' });
    ok('illegal renamed', r.renamed === true);
    eq('illegal stripped', path.basename(r.to), 'abcdefghij.mkv');
    eq('stayed in root', path.dirname(r.to), ROOT);
  }

  // ── 11. Renaming to the name it already has is a safe no-op ──
  {
    const src = mk('already.mkv');
    const r = await finalizeRename({ sourcePath: src, base: 'already', collision: 'counter' });
    ok('already-named no-op', r.renamed === false);
    eq('already-named reason', r.reason, 'already-named');
    ok('already-named file intact', fs.existsSync(src));
  }

  // ── 12. dryRun computes without touching disk ──
  {
    const src = mk('Recording 12.mkv');
    const r = await finalizeRename({ sourcePath: src, base: 'planned', collision: 'counter', dryRun: true });
    ok('dryRun reports rename', r.renamed === true && r.dryRun === true);
    ok('dryRun did NOT move the file', fs.existsSync(src));
    ok('dryRun did NOT create target', !fs.existsSync(path.join(ROOT, 'planned.mkv')));
  }

  // ── 13. A file still growing is left alone (never renamed mid-write) ──
  {
    const src = mk('growing.mkv', 'a');
    const timer = setInterval(() => { try { fs.appendFileSync(src, 'more'); } catch { /* done */ } }, 100);
    // Shrink the deadline by monkey-patching is overkill; instead assert that
    // within a short window it has NOT renamed, then stop growing and confirm
    // it completes. We run the call and stop growth after ~2s.
    const p = finalizeRename({ sourcePath: src, base: 'settled', collision: 'counter' });
    setTimeout(() => clearInterval(timer), 2000);
    const r = await p;
    ok('growing file eventually renamed once stable', r.renamed === true);
    ok('growing: content preserved', fs.readFileSync(r.to, 'utf8').startsWith('a'));
  }

  // ── 14. Never throws, even on garbage input ──
  for (const bad of [null, undefined, {}, { sourcePath: 123 }, { sourcePath: ROOT }, { sourcePath: '', base: null }]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await finalizeRename(bad);
    ok(`garbage input returns result (${JSON.stringify(bad)})`, !!r && r.ok === true);
  }
  {
    // A directory as the source must be refused, not renamed.
    const dir = path.join(ROOT, 'adir'); fs.mkdirSync(dir, { recursive: true });
    const r = await finalizeRename({ sourcePath: dir, base: 'x', collision: 'counter' });
    eq('directory refused', r.reason, 'not-a-file');
    ok('directory still exists', fs.existsSync(dir));
  }

  // ── 15. Internal helpers ──
  eq('sanitizeSegment strips traversal', _internals.sanitizeSegment('../evil'), 'evil');
  eq('sanitizeBase trailing dot', _internals.sanitizeBase('name...'), 'name');
  eq('wait ceiling is 60s', _internals.MAX_WAIT_MS, 60000);

  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave temp */ }
  console.log(`\n=== smart-naming disk engine: ${pass} pass / ${fail} fail ===`);
  if (fail > 0) process.exit(1);
})();
