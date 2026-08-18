// The diagnostics bundle has exactly two things that can hurt someone if they
// are wrong, and this covers both:
//
//   1. WHO may run it. It is a support tool for testers and developers, and a
//      regular user must never see or be served it.
//   2. WHAT leaves the machine. The output is designed to be pasted into a
//      chat by a person who will not read it first, so a credential surviving
//      redaction is a credential published.
//
// Run by prebuild:vite. Pure functions only - no Electron, no filesystem.
const assert = require('assert');
const { mayDiagnose, redact } = require('./diagnostics.cjs');

let pass = 0;
const ok = (label, fn) => {
  try { fn(); pass++; console.log('  ok  ' + label); }
  catch (e) { console.error('  FAIL ' + label + '\n        ' + e.message); process.exitCode = 1; }
};

console.log('\n── who may run diagnostics ──');

ok('a tester may', () => assert.strictEqual(mayDiagnose({ is_tester: true }), true));
ok('a master tester may', () => assert.strictEqual(mayDiagnose({ is_master_tester: true }), true));
ok('a developer may', () => assert.strictEqual(mayDiagnose({ app_role: 'developer' }), true));

ok('a plain user may NOT', () => assert.strictEqual(mayDiagnose({ app_role: 'user' }), false));
ok('an empty claim set may NOT', () => assert.strictEqual(mayDiagnose({}), false));
ok('null may NOT', () => assert.strictEqual(mayDiagnose(null), false));
ok('undefined may NOT', () => assert.strictEqual(mayDiagnose(undefined), false));
ok('a non-object may NOT', () => assert.strictEqual(mayDiagnose('developer'), false));

// Paying for the product does not make someone a tester. This is the line the
// gate exists to draw, so it is asserted rather than assumed.
ok('Pro+ alone may NOT', () => assert.strictEqual(mayDiagnose({ tier: 'pro_plus' }), false));
ok('Pro alone may NOT', () => assert.strictEqual(mayDiagnose({ tier: 'pro' }), false));
ok('a contributor alone may NOT', () => assert.strictEqual(mayDiagnose({ is_contributor: true }), false));

// Truthiness must not be enough: only a real boolean true, so a legacy token
// carrying a string cannot sneak through.
ok('is_tester: "false" (string) may NOT', () => assert.strictEqual(mayDiagnose({ is_tester: 'false' }), false));
ok('is_tester: 1 may NOT', () => assert.strictEqual(mayDiagnose({ is_tester: 1 }), false));
ok('app_role "Developer" (wrong case) may NOT', () => assert.strictEqual(mayDiagnose({ app_role: 'Developer' }), false));

console.log('\n── redaction: nothing sensitive may survive ──');

const JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9'
          + '.eyJzdWIiOiIxMjM0NTY3ODkwIiwiYXBwX3JvbGUiOiJkZXZlbG9wZXIifQ'
          + '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5cABCDEFGHIJKLMNOP';

ok('a JWT is removed', () => {
  const out = redact('Authorization: Bearer ' + JWT);
  assert.ok(!out.includes(JWT), 'jwt survived');
  assert.ok(out.includes('<JWT redacted>'), 'no marker');
});

ok('a JWT embedded mid-line is removed', () => {
  const out = redact('[INFO] sent token=' + JWT + ' to bridge');
  assert.ok(!out.includes(JWT));
});

ok('a 64-char bridge token is removed', () => {
  const tok = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f70819a2b3c4d5e6f7081';
  const out = redact('bridge.token ' + tok);
  assert.ok(!out.includes(tok), 'token survived');
});

ok('a 32-char hex run is removed', () => {
  const tok = '0123456789abcdef0123456789abcdef';
  assert.ok(!redact('x ' + tok).includes(tok));
});

ok('a long base64 blob is removed', () => {
  const b64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=';
  assert.ok(!redact('sig=' + b64).includes(b64));
});

// Things we deliberately KEEP. Over-redaction destroys the tool: a bundle with
// the sha256 prefixes stripped cannot answer "is this the build I shipped".
ok('a truncated sha256 prefix is KEPT', () => {
  assert.ok(redact('sha=5f1a4295f9563b73').includes('5f1a4295f9563b73'));
});
ok('ordinary log text is untouched', () => {
  const line = '[Info : Excalibur] Excalibur.Pro signature verified';
  assert.strictEqual(redact(line), line);
});
ok('a version number is untouched', () => {
  assert.ok(redact('core v0.9.2 loaded').includes('v0.9.2'));
});
ok('a file path is still readable after the username is masked', () => {
  const out = redact('C:\\Users\\somebody\\AppData\\Roaming\\gorilla-tag-mod-manager');
  assert.ok(out.includes('AppData'), 'path structure lost');
});

ok('redact handles null/undefined without throwing', () => {
  assert.strictEqual(redact(null), '');
  assert.strictEqual(redact(undefined), '');
});

console.log(`\ndiagnostics: ${pass} assertions passed`);
