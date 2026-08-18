'use strict';

// Run: node electron/auth-claims.test.cjs
//
// Covers userFromClaims - the JWT-claims -> authUser mapping that the renderer
// receives from `auth:status` on every app launch.
//
// The bug this locks down: getStatus() rebuilt the user object from the cached
// token with only FOUR fields (id, username, avatar, app_role) even though the
// server signs tier / is_tester / is_master_tester / is_contributor /
// tier_expires_at into that same token. login() returned the full object from
// the API response, so entitlements were correct for the rest of that session
// and then SILENTLY LOST on the next launch, because startup goes through
// getStatus() instead.
//
// Downstream, resolveUserTier() in src/App.jsx ends with:
//     return authUser.tier || DEFAULT_TIER;      // DEFAULT_TIER === 'free'
// so a dropped `tier` claim does not fail loudly - it reads as a legitimate
// free user. A Pro subscriber, or anyone granted a tier by the private bot's
// /tier command, was shown FREE and had Social/Community locked behind a
// TierGate after any restart.
//
// It hid for so long because the two groups who actually used the app both had
// a second, independent signal that happened to rescue them:
//   - developers      -> app_role WAS carried, so they resolved to 'dev'
//   - real testers    -> social_profiles.role='tester' is passed into
//                        resolveUserTier separately and short-circuits it
// Someone made a tester ONLY by a manual override has neither: their profile
// role stays 'user', so the JWT claim was the single carrier of the grant.

const assert = require('assert');
const { userFromClaims } = require('./auth.cjs');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL: ${label}`); } };
const eq = (label, got, want) => {
  if (got === want) pass++;
  else { fail++; console.log(`FAIL: ${label}\n  got : ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`); }
};

// Exactly the claim set api/auth.js signs (see the SignJWT call there). If that
// list grows, this fixture and CARRIED below should grow with it.
const CLAIMS = {
  sub:              '652452087145431061',
  discord_id:       '652452087145431061',
  username:         'zkriptgt',
  avatar:           'a_1234567890abcdef',
  app_role:         'user',
  is_tester:        true,
  is_master_tester: false,
  is_contributor:   false,
  tier:             'pro_plus',
  tier_expires_at:  null,
  iss:              'excalibur',
  exp:              4102444800,
};

// ---------------------------------------------------------------------------
// The regression itself
// ---------------------------------------------------------------------------

// Every claim the renderer gates on must survive the trip. Named individually
// rather than deep-equalling the object, so the failure message says WHICH
// entitlement went missing.
const CARRIED = ['tier', 'is_tester', 'is_master_tester', 'is_contributor', 'tier_expires_at', 'app_role'];
{
  const u = userFromClaims(CLAIMS);
  for (const key of CARRIED) {
    eq(`claim "${key}" survives a relaunch`, u[key], CLAIMS[key]);
  }
  eq('id comes from discord_id', u.id, CLAIMS.discord_id);
  eq('username carried', u.username, CLAIMS.username);
  eq('avatar carried', u.avatar, CLAIMS.avatar);
}

// The end-to-end consequence, expressed the way src/App.jsx expresses it.
// Mirrors resolveUserTier's final fallback for a plain (non-dev) user whose
// social_profiles.role is 'user' - i.e. a tester by manual override only.
{
  const u = userFromClaims(CLAIMS);
  const socialRole = 'user';                       // no real tester role
  const isTester = socialRole === 'tester' || u.is_tester === true;
  ok('an override-only tester is NOT downgraded to free after a relaunch', isTester);
  eq('...and their entitlement tier is intact', u.tier || 'free', 'pro_plus');
}

// A paying subscriber has no role signal at all - the JWT tier claim is the
// ONLY thing standing between them and a free-tier UI.
{
  const u = userFromClaims({ ...CLAIMS, is_tester: false, tier: 'pro', tier_expires_at: '2027-01-01T00:00:00Z' });
  eq('a Pro subscriber still reads as pro after a relaunch', u.tier || 'free', 'pro');
  eq('their expiry is carried too', u.tier_expires_at, '2027-01-01T00:00:00Z');
}

// ---------------------------------------------------------------------------
// Shape / safety
// ---------------------------------------------------------------------------

// Legacy tokens minted before a claim existed must not become `false`/'free'
// by accident anywhere - absent stays absent, and the UI applies its own
// default. Guards against "fixing" this with `?? false` later.
{
  const u = userFromClaims({ discord_id: '1', username: 'old', app_role: 'user' });
  eq('a missing tier claim stays undefined, not coerced', u.tier, undefined);
  eq('a missing is_tester stays undefined, not coerced', u.is_tester, undefined);
}

// app_role has always fallen back to the older `role` claim - keep that.
eq('app_role falls back to the legacy role claim',
  userFromClaims({ discord_id: '1', role: 'developer' }).app_role, 'developer');

// Never hand the renderer a null it has to guard.
ok('a null payload yields null, not a throw', userFromClaims(null) === null);

// The token also carries iss/exp/sub. Those are verification metadata, not
// user identity, and leaking them into the renderer's user object invites
// someone trusting `user.exp`. Verification is auth.cjs's job.
{
  const u = userFromClaims(CLAIMS);
  ok('JWT metadata is not smuggled into the user object',
    u.iss === undefined && u.exp === undefined && u.sub === undefined);
}

// ── A TESTER IS NEVER A DEVELOPER, on this machine either ──────────────────
//
// 2026-08-03: a bad DEVELOPER_DISCORD_IDS secret minted every tester a token
// carrying `app_role: 'developer'`, which opened the Settings developer tab and
// the community moderation panel on their PCs. The server side is fixed, but
// the DESKTOP verifies the saved token locally and never asks the server, so a
// token issued before the fix would keep unlocking the dev UI for seven days.
//
// The token contradicts itself - is_tester true AND app_role developer - and
// the safe reading of a contradiction is the lesser one.
{
  const u = userFromClaims({ ...CLAIMS, app_role: 'developer', is_tester: true });
  ok('a tester token does NOT yield developer', u.app_role === 'user');
  ok('the tester claim itself is preserved', u.is_tester === true);
}
{
  const u = userFromClaims({ ...CLAIMS, app_role: 'developer', is_master_tester: true });
  ok('a master-tester token does NOT yield developer', u.app_role === 'user');
}
{
  const u = userFromClaims({ ...CLAIMS, app_role: 'developer', is_tester: false, is_master_tester: false });
  ok('a REAL developer still gets developer', u.app_role === 'developer');
}
{
  // NOTE the base fixture is a real tester (is_tester: true), so the tester
  // claims have to be cleared explicitly to describe a genuine developer.
  const { is_tester, is_master_tester, ...noGrade } = CLAIMS;   // eslint-disable-line no-unused-vars
  const u = userFromClaims({ ...noGrade, app_role: 'developer' });
  ok('a developer with no tester claims at all is unaffected', u.app_role === 'developer');
}
{
  // Truthiness must not be enough in either direction.
  const u = userFromClaims({ ...CLAIMS, app_role: 'developer', is_tester: 'true' });
  ok('a string "true" tester claim does not demote a developer', u.app_role === 'developer');
}
{
  const u = userFromClaims({ ...CLAIMS, app_role: 'user', is_tester: true });
  ok('a plain tester is still a plain user', u.app_role === 'user');
}

console.log(`auth-claims: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
