// Run: node electron/update-policy.test.cjs
//
// The update system has exactly one job it must never get wrong: put the right
// build in front of the right person. There is no error state for getting it
// wrong - a regular user handed a tester build just runs it, and a tester who
// never receives tester builds just sees nothing. Both failures are silent,
// which is why the decision is a pure function with a case per outcome rather
// than an expression inside an event handler.
//
// The other thing under test is the failure DIRECTION of normalizePolicy. A
// corrupted or unrecognised policy value must fall back to asking, never to
// installing unattended, because the cost of the two mistakes is not symmetric.

const {
  BETA_CHANNEL, STABLE_CHANNEL, POLICY_ASK, POLICY_AUTO,
  resolveChannel, normalizePolicy, shouldAutoInstall,
  classifySeverity, isNoFeedError,
} = require('./update-policy.cjs');

let pass = 0; const fails = [];
const eq = (name, got, want) => {
  if (got === want) pass++; else fails.push(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
};
const ok = (name, cond) => eq(name, !!cond, true);

console.log('\n── Who receives tester builds ──');
eq('a tester is on the beta channel',
   resolveChannel({ app_role: 'user', is_tester: true }), BETA_CHANNEL);
eq('a master tester is on the beta channel',
   resolveChannel({ app_role: 'user', is_master_tester: true }), BETA_CHANNEL);
eq('a developer is on the beta channel',
   resolveChannel({ app_role: 'developer' }), BETA_CHANNEL);
eq('a developer who is also a tester is on the beta channel',
   resolveChannel({ app_role: 'developer', is_tester: true }), BETA_CHANNEL);

console.log('── Who does NOT ──');
eq('a plain signed-in user is on stable',
   resolveChannel({ app_role: 'user', tier: 'pro_plus' }), STABLE_CHANNEL);
// The whole point of reading this off a verified JWT: paying for the top tier
// buys features, not untested builds.
eq('a Pro+ subscriber is on stable, not beta',
   resolveChannel({ app_role: 'user', tier: 'pro_plus', is_contributor: true }), STABLE_CHANNEL);
eq('a contributor badge alone does not grant tester builds',
   resolveChannel({ app_role: 'user', is_contributor: true }), STABLE_CHANNEL);
eq('signed out is on stable', resolveChannel(null), STABLE_CHANNEL);
eq('undefined user is on stable', resolveChannel(undefined), STABLE_CHANNEL);

console.log('── is_tester must be a real true, not merely truthy ──');
// api/auth.js signs a real boolean. A string "false" arriving from anywhere is a
// bug upstream, and it must not read as tester.
eq('is_tester:"false" is not a tester',
   resolveChannel({ is_tester: 'false' }), STABLE_CHANNEL);
eq('is_tester:1 is not a tester',
   resolveChannel({ is_tester: 1 }), STABLE_CHANNEL);
eq('is_tester:false is not a tester',
   resolveChannel({ is_tester: false }), STABLE_CHANNEL);
eq('app_role:"dev" is not app_role:"developer"',
   resolveChannel({ app_role: 'dev' }), STABLE_CHANNEL);

console.log('\n── A bad policy value must fall back to ASKING ──');
eq('ask stays ask', normalizePolicy('ask'), POLICY_ASK);
eq('auto stays auto', normalizePolicy('auto'), POLICY_AUTO);
eq('null falls back to ask', normalizePolicy(null), POLICY_ASK);
eq('undefined falls back to ask', normalizePolicy(undefined), POLICY_ASK);
eq('a removed value ("never") falls back to ask', normalizePolicy('never'), POLICY_ASK);
eq('garbage falls back to ask', normalizePolicy({ policy: 'auto' }), POLICY_ASK);
// The one that matters: a truthy non-'auto' string must not slip through as
// permission to install without asking.
eq('"automatic" is NOT auto', normalizePolicy('automatic'), POLICY_ASK);
eq('"AUTO" is NOT auto (no case coercion)', normalizePolicy('AUTO'), POLICY_ASK);
eq('true is NOT auto', normalizePolicy(true), POLICY_ASK);

console.log('── When Excalibur installs without asking ──');
ok('auto installs unattended', shouldAutoInstall({ policy: 'auto' }));
ok('ask does not', !shouldAutoInstall({ policy: 'ask' }));
ok('no policy at all does not', !shouldAutoInstall({}));
// A mandatory release overrides the setting. This is the JWT-rotation case: an
// older build literally cannot sign in, so deferring means staying broken.
ok('a mandatory release installs even on ask', shouldAutoInstall({ policy: 'ask', mandatory: true }));
ok('a mandatory release installs on auto too', shouldAutoInstall({ policy: 'auto', mandatory: true }));
ok('mandatory:false does not force it', !shouldAutoInstall({ policy: 'ask', mandatory: false }));
// Only a real boolean forces an install. A truthy string here would mean any
// stray value in the changelog silently removes the user's Later button.
ok('mandatory:"true" (string) does NOT force it', !shouldAutoInstall({ policy: 'ask', mandatory: 'true' }));
ok('mandatory:1 does NOT force it', !shouldAutoInstall({ policy: 'ask', mandatory: 1 }));

console.log('\n── Severity labelling ──');
eq('patch bump', classifySeverity('1.0.11', '1.0.12'), 'patch');
eq('minor bump', classifySeverity('1.0.11', '1.1.0'), 'minor');
eq('major bump', classifySeverity('1.9.9', '2.0.0'), 'major');
eq('multi-version patch jump is still patch', classifySeverity('1.0.11', '1.0.14'), 'patch');
// Not newer is the case worth having a value for: it means something offered a
// version it should not have.
eq('the same version is not an update', classifySeverity('1.0.11', '1.0.11'), null);
eq('an older version is not an update', classifySeverity('1.0.12', '1.0.11'), null);
eq('garbage does not throw', classifySeverity(undefined, undefined), null);

console.log('── "Nothing published yet" is not an error ──');
ok('404 status', isNoFeedError({ statusCode: 404 }));
ok('missing latest.yml', isNoFeedError(new Error('Cannot find latest.yml in the latest release')));
ok('missing beta.yml', isNoFeedError(new Error('Cannot find beta.yml in the latest release')));
// A tester whose newest release carries only latest.yml hits this, and
// electron-updater retries with the default channel by itself. Painting a red
// error for a condition that resolves itself is noise.
ok('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', isNoFeedError(new Error('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')));
ok('ERR_UPDATER_LATEST_VERSION_NOT_FOUND', isNoFeedError(new Error('ERR_UPDATER_LATEST_VERSION_NOT_FOUND')));
ok('no published versions', isNoFeedError(new Error('No published versions on GitHub')));
// A real failure must still be reported as one, or the app claims to be up to
// date while its updater is broken.
ok('a genuine network failure IS an error', !isNoFeedError(new Error('ECONNRESET socket hang up')));
ok('a bad signature IS an error', !isNoFeedError(new Error('sha512 checksum mismatch')));
ok('a 500 IS an error', !isNoFeedError({ statusCode: 500, message: 'Internal Server Error' }));

if (fails.length) {
  console.error(`\n✖ update-policy: ${fails.length} failed of ${pass + fails.length}`);
  for (const f of fails) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`\n✔ update-policy: ${pass}/${pass} passed`);
