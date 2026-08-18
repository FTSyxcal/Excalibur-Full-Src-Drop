'use strict';

// Run: node electron/auth-renew.test.cjs
//
// Covers renewOutcome - what the desktop app DOES with a reply from
// `POST /api/auth?action=renew`.
//
// Why this is worth pinning down. The renewal runs on the startup path, on
// every launch, for every user. That makes its failure behaviour far more
// consequential than its success behaviour:
//
//   - Treat a transient 500 as "signed out" and one bad deploy logs out the
//     entire user base simultaneously, at boot, with no way for them to tell
//     the difference between that and a ban.
//   - Store half a token pair and the RS256 session and the Supabase session
//     drift apart: the app looks signed in while every database read 401s.
//
// So the rule is asymmetric on purpose, and these tests are what hold it:
// ONLY an explicit 401/403 may sign someone out. Everything else keeps the
// token the app already has, which is always safe because that token is still
// valid - renewal is an improvement, never a prerequisite.

const assert = require('assert');
const { renewOutcome } = require('./auth.cjs');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const good = {
  token: 'new.rs256.token',
  supabaseToken: 'new.hs256.token',
  user: { id: '1', tier: 'pro' },
  tier_changed: true,
};

// ── The happy path ─────────────────────────────────────────────────────────

check('a good 200 stores both tokens and reports the upgrade', () => {
  const o = renewOutcome(200, good);
  assert.equal(o.action, 'store');
  assert.equal(o.result.token, 'new.rs256.token');
  assert.equal(o.result.supabaseToken, 'new.hs256.token');
  assert.equal(o.result.tierChanged, true);
  assert.equal(o.result.user.tier, 'pro');
});

check('tier_changed false is carried through as false, not dropped', () => {
  const o = renewOutcome(200, { ...good, tier_changed: false });
  assert.equal(o.result.tierChanged, false);
});

// ── The only two statuses allowed to sign someone out ──────────────────────

check('401 signs the user out - the token is genuinely finished', () => {
  const o = renewOutcome(401, { error: 'invalid_token' });
  assert.equal(o.action, 'signout');
  assert.equal(o.result.rejected, true);
});

check('403 signs the user out - access was withdrawn', () => {
  const o = renewOutcome(403, { error: 'no_access' });
  assert.equal(o.action, 'signout');
  assert.equal(o.result.rejected, true);
});

// ── Everything else must be harmless ───────────────────────────────────────

check('A 500 MUST NOT sign anyone out', () => {
  // The failure that would take the whole user base down at once.
  const o = renewOutcome(500, { error: 'server_error' });
  assert.equal(o.action, 'keep');
  assert.equal(o.result, null);
});

check('a 503 invite-check blip keeps the existing token', () => {
  const o = renewOutcome(503, { error: 'invite_check_failed' });
  assert.equal(o.action, 'keep');
});

check('a 404 (endpoint not deployed yet) keeps the existing token', () => {
  // The realistic case while the client ships ahead of the API: an app build
  // carrying renew() talking to a deploy that has not got the endpoint. It must
  // degrade to exactly the old behaviour.
  const o = renewOutcome(404, null);
  assert.equal(o.action, 'keep');
});

check('a 429 keeps the existing token', () => {
  assert.equal(renewOutcome(429, {}).action, 'keep');
});

// ── Malformed successes ────────────────────────────────────────────────────

check('a 200 with no body changes nothing', () => {
  assert.equal(renewOutcome(200, null).action, 'keep');
});

check('a 200 missing the Supabase token stores NEITHER', () => {
  // Half a pair is worse than none: the app would look signed in while every
  // Supabase read failed.
  const o = renewOutcome(200, { token: 'only.rs256' });
  assert.equal(o.action, 'keep');
});

check('a 200 missing the main token stores NEITHER', () => {
  const o = renewOutcome(200, { supabaseToken: 'only.hs256' });
  assert.equal(o.action, 'keep');
});

check('empty-string tokens are refused, not stored', () => {
  assert.equal(renewOutcome(200, { token: '', supabaseToken: '' }).action, 'keep');
});

check('non-string tokens are refused (an HTML proxy page, a JSON object)', () => {
  assert.equal(renewOutcome(200, { token: { a: 1 }, supabaseToken: 'x' }).action, 'keep');
  assert.equal(renewOutcome(200, { token: 'x', supabaseToken: 123 }).action, 'keep');
});

check('a 200 with a user but no tokens is still refused', () => {
  assert.equal(renewOutcome(200, { user: { id: '1', tier: 'pro_plus' } }).action, 'keep');
});

// ── The invariant, stated directly ─────────────────────────────────────────

check('across every status, ONLY 401 and 403 ever sign out', () => {
  const statuses = [200, 201, 204, 301, 302, 400, 404, 405, 409, 418, 429, 500, 502, 503, 504];
  for (const s of statuses) {
    const o = renewOutcome(s, good);
    assert.notEqual(o.action, 'signout', `status ${s} must never sign a user out`);
  }
  assert.equal(renewOutcome(401, good).action, 'signout');
  assert.equal(renewOutcome(403, good).action, 'signout');
});

console.log(`\nauth-renew: ${passed} checks passed`);
