// Manages the full Excalibur auth lifecycle:
//   1. Discord OAuth2 flow (localhost redirect capture)
//   2. JWT exchange with the Excalibur API
//   3. Secure JWT storage via Electron safeStorage (OS credential vault)
//   4. JWT validation on every boot so a stale token forces re-login

const { safeStorage, shell } = require('electron');
const http   = require('http');
const { URL } = require('url');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { getWritableBaseDir } = require('./logger.cjs');

// RS256 public key that pairs with JWT_PRIVATE_KEY on the Vercel backend.
// Used here to verify the signature of the main Excalibur JWT so a user
// can't forge a token locally with `app_role: 'developer'` to unlock the
// Developer Panel UI. Rotate this and JWT_PRIVATE_KEY together. The mod's
// AuthModule.cs uses the same key in XML form.
const JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkZEaaMMcuqxesDx6qD9L
VUeDzADUNjJUKDLDKRJuvGR+gteCsQfNqeV8ofSDb+g5vJ5WG95cTzQCx/Uglulu
OIwFMuE5ulUzoZHnF0Cs8Nq18GAFKUKvmHOznwTEdeynzbAYq5HGBhFFQclTD54l
eIlJQEDbqoqs57Aoz8qjDBkv2852CaV1M68twQDFxOLxBhCJO05YsxIQnEZe67c/
K3RQsKdxRXgt/K96YOvxJQB+xKZLi95EhO2DxhYhEpxMbS9X8F9veCvfVZ1dzg0N
sxYd11w5zs/H2z/nVAVwo5P2WuWURgVL49M7kUxzZ3pcJzPi/3xsLBT50tt5cqXs
9QIDAQAB
-----END PUBLIC KEY-----
`;

// Verify the RS256 signature of a JWT locally. Returns true only if the
// signature is valid for our JWT_PUBLIC_KEY, the issuer is 'excalibur',
// and the token hasn't expired. A forged token with a made-up `app_role`
// claim will fail here - that's how we keep the Developer Panel UI
// out of anyone's hands except a real developer-JWT holder.
function verifyJwtSignature(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, sigB64] = parts;

    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    if (header.alg !== 'RS256') return false;

    const sig = Buffer.from(sigB64, 'base64url');
    const ok = crypto
      .createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(JWT_PUBLIC_KEY, sig);
    if (!ok) return false;

    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (payload.iss !== 'excalibur') return false;
    if (payload.exp && payload.exp * 1000 < Date.now()) return false;

    return true;
  } catch {
    return false;
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const CALLBACK_PORT   = 52139;
const REDIRECT_URI    = `http://localhost:${CALLBACK_PORT}/callback`;

// The same Discord application used for rich presence.
// Make sure http://localhost:52139/callback is added in the Discord
// Developer Portal → OAuth2 → Redirects.
const DISCORD_CLIENT_ID = '1511900835939090574';

// Backend that validates licenses and signs JWTs. Production lives on
// Cloudflare Pages at excaliburgtag.com (migrated from Vercel). Override
// via the AUTH_API_URL environment variable for local backend dev.
const AUTH_API_URL = process.env.AUTH_API_URL || 'https://excaliburgtag.com/api/auth';

// ── Every network call on the startup path MUST be bounded ──────────────────
// Renew sits between the splash and the app, and login sits between the
// browser and the app. Neither had a timeout until 2026-08-15, when a slow API
// turned "one endpoint is degraded" into "nobody can open Excalibur at all" -
// including users whose stored token was valid for another six days.
//
// Renew is short because it is optional: it is a nice-to-have refresh, and
// boot continues without it. Login is longer because it is the only path to a
// session, but it is still finite - a Discord authorization code expires in
// about a minute, so an exchange that has not returned by then is already dead.
const RENEW_TIMEOUT_MS = 8000;
const LOGIN_TIMEOUT_MS = 30000;

// ── Token storage ─────────────────────────────────────────────────────────

function tokenPath() {
  return path.join(getWritableBaseDir(), 'auth.token');
}

function loadRawToken() {
  const p = tokenPath();
  if (!fs.existsSync(p)) return null;
  try {
    const encrypted = fs.readFileSync(p);
    // safeStorage is only available after app is ready.
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(encrypted);
  } catch { return null; }
}

function saveRawToken(token) {
  if (!safeStorage.isEncryptionAvailable()) return;
  const encrypted = safeStorage.encryptString(token);
  fs.writeFileSync(tokenPath(), encrypted);
}

function clearToken() {
  const p = tokenPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function supabaseTokenPath() {
  return path.join(getWritableBaseDir(), 'auth.supabase.token');
}

function loadRawSupabaseToken() {
  const p = supabaseTokenPath();
  if (!fs.existsSync(p)) return null;
  try {
    const encrypted = fs.readFileSync(p);
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(encrypted);
  } catch { return null; }
}

function saveSupabaseToken(token) {
  if (!safeStorage.isEncryptionAvailable()) return;
  const encrypted = safeStorage.encryptString(token);
  fs.writeFileSync(supabaseTokenPath(), encrypted);
}

function clearSupabaseToken() {
  const p = supabaseTokenPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// Discord friends list - cached at OAuth time so the Friends view can
// render the "From your Discord" section without re-hitting Discord's
// rate-limited /relationships endpoint. Empty array when the
// relationships.read scope wasn't granted (unverified app).
function discordFriendsPath() {
  return path.join(getWritableBaseDir(), 'auth.discord_friends.json');
}
function loadDiscordFriends() {
  const p = discordFriendsPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return []; }
}
function saveDiscordFriends(arr) {
  try { fs.writeFileSync(discordFriendsPath(), JSON.stringify(arr || [])); }
  catch { /* nbd - UI degrades gracefully on empty */ }
}
function clearDiscordFriends() {
  const p = discordFriendsPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ── JWT utilities ─────────────────────────────────────────────────────────

function parseJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch { return null; }
}

// Returns true if token exists, parses, the RSA signature is valid, the
// issuer matches, and it hasn't expired (with 5-min buffer). Checking the
// signature locally means an attacker can't seed a forged JWT into the
// safeStorage file to flip `app_role` to 'developer' and unlock the
// in-client Developer Panel - the real gates upstream (Vercel, mod) would
// still reject them, but this keeps them from even seeing the UI.
function isTokenFresh(token) {
  if (!token) return false;
  if (!verifyJwtSignature(token)) return false;
  const p = parseJwtPayload(token);
  if (!p || !p.exp) return false;
  return p.exp * 1000 > Date.now() + 5 * 60 * 1000;
}

// ── OAuth flow ────────────────────────────────────────────────────────────

// Opens a Discord OAuth URL in the user's browser and captures the
// authorization code via a temporary localhost HTTP server.
function waitForOAuthCode() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

      const code    = url.searchParams.get('code');
      const retState = url.searchParams.get('state');
      const error   = url.searchParams.get('error');

      // Send a clean "you can close this" page back to the browser.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html><head><title>Excalibur</title><style>
  body{background:#0d0d12;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}
  h2{margin:0;font-size:1.2rem;font-weight:600}
  p{margin:0;opacity:.5;font-size:.85rem}
</style></head><body>
  <h2>${error ? '✗ Authentication failed' : '✓ Authenticated!'}</h2>
  <p>${error ? error : 'You can close this tab and return to Excalibur.'}</p>
</body></html>`);

      server.close();

      if (error) { reject(new Error(`Discord error: ${error}`)); return; }
      if (!code || retState !== state) { reject(new Error('Invalid callback state')); return; }
      resolve(code);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${CALLBACK_PORT} is already in use. Close any other Excalibur instances and try again.`));
      } else {
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      const authUrl = new URL('https://discord.com/oauth2/authorize');
      authUrl.searchParams.set('client_id',     DISCORD_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
      authUrl.searchParams.set('response_type', 'code');
      // relationships.read is a privileged scope - Discord won't even
      // let unverified apps REQUEST it (the OAuth dialog returns
      // invalid_scope). Once the app is verified and Discord approves
      // the scope, add 'relationships.read' here and the existing
      // api/auth.js + FriendsView wiring picks it up automatically.
      authUrl.searchParams.set('scope',         'identify');
      authUrl.searchParams.set('state',         state);
      shell.openExternal(authUrl.toString());
    });

    // Give the user 5 minutes to complete the flow.
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out. Please try again.'));
    }, 5 * 60 * 1000);
  });
}

// Maps verified JWT claims onto the `authUser` object the renderer consumes.
//
// THIS MUST CARRY EVERY CLAIM THE UI GATES ON. It used to copy only id /
// username / avatar / app_role, silently dropping tier, is_tester,
// is_master_tester and is_contributor - all of which the server signs into the
// same token. login() returns the full object straight from the API response,
// so entitlements looked right for the rest of that session and were lost on
// the next launch, because startup reads auth:status (this path) instead.
//
// The loss was invisible rather than loud: resolveUserTier() in src/App.jsx
// ends with `authUser.tier || DEFAULT_TIER`, so a missing claim reads as a
// legitimate free user. Anyone granted a tier by the private bot's /tier
// command was shown FREE with Social and Community locked. Developers
// (app_role survived) and real testers (social_profiles.role rescues them
// separately) both had a second signal, which is why it went unnoticed.
//
// Everything here is read from a token whose RS256 signature was already
// verified by isTokenFresh(), so these claims are server-asserted, not
// client-controlled. Covered by electron/auth-claims.test.cjs.
// A TESTER IS NEVER A DEVELOPER, decided here as well as on the server.
//
// 2026-08-03: every tester's token carried `app_role: 'developer'` (a bad
// DEVELOPER_DISCORD_IDS secret), which opened the Settings developer tab, the
// community moderation panel and the Preview-Tier-As UI on their machines.
//
// The server now refuses to mint it and downgrades it on every API call - but
// the DESKTOP verifies the saved token locally and never asks the server, so a
// token issued before the fix would keep unlocking the dev UI here for its full
// seven days regardless of anything done server-side.
//
// It needs no network to fix: the token says `is_tester: true` AND
// `app_role: 'developer'` in the same breath, which is a contradiction, and the
// safe reading of a contradiction is the lesser one. Only ever WEAKENS the
// claim - nothing here can grant admin.
function resolveLocalAppRole(payload) {
  const raw = payload.app_role || payload.role;
  if (raw !== 'developer') return raw;
  if (payload.is_tester === true || payload.is_master_tester === true) return 'user';
  return 'developer';
}

function userFromClaims(payload) {
  if (!payload) return null;
  return {
    id:               payload.discord_id,
    username:         payload.username,
    // Their Discord display name. Undefined on tokens minted before this claim
    // existed, which is exactly why it is passed through as-is rather than
    // defaulted to the username here - the one caller that needs a fallback
    // does it explicitly, and a confident-looking wrong value would hide that.
    global_name:      payload.global_name,
    avatar:           payload.avatar,
    app_role:         resolveLocalAppRole(payload),
    // Entitlement claims. Passed through as-is: an absent claim on a legacy
    // token must stay undefined so the UI applies its own default, rather
    // than being coerced to a confident-looking `false` / 'free'.
    tier:             payload.tier,
    tier_expires_at:  payload.tier_expires_at,
    is_tester:        payload.is_tester,
    is_master_tester: payload.is_master_tester,
    is_contributor:   payload.is_contributor,
  };
}

// ── Public API ────────────────────────────────────────────────────────────

// Returns `{ authenticated, user }` synchronously from the cached token.
//
// Both JWTs (the Excalibur RS256 token and the Supabase HS256 token) are
// minted server-side at OAuth time and cached encrypted via safeStorage.
// They share the same 24h TTL, so freshness on the main token implies
// freshness on the Supabase token. If the Supabase secret rotates, every
// user simply re-OAuths next launch - there is no client-side signing
// path that could leak the secret.
function getStatus() {
  const token = loadRawToken();
  if (!isTokenFresh(token)) return { authenticated: false, user: null, supabaseToken: null };
  const payload = parseJwtPayload(token);
  const supabaseToken = loadRawSupabaseToken();
  return {
    authenticated: true,
    token:         token,
    supabaseToken,
    user:          userFromClaims(payload),
  };
}

// Returns the raw JWT string, or null if not authenticated / expired.
function getToken() {
  const token = loadRawToken();
  return isTokenFresh(token) ? token : null;
}

// Runs the full OAuth → API exchange → store flow.
// Resolves with `{ user }` on success or throws with a user-readable message.
async function login() {
  const code = await waitForOAuthCode();

  let res;
  try {
    res = await fetch(`${AUTH_API_URL}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, redirectUri: REDIRECT_URI }),
      // Unlike renew() this cannot fail soft - there is no existing session to
      // fall back on - but it must still END. Without a timeout a slow API
      // leaves the user on "Waiting for Discord" forever with no error and no
      // retry, which is what happened on 2026-08-15. A Discord code is
      // single-use and expires in ~60s anyway, so waiting longer can never
      // succeed; failing with a readable message lets them try again, which can.
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error('Signing in timed out. The server is busy - please try again.');
    }
    throw new Error('Could not reach Excalibur to finish signing in. Check your connection and try again.');
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.message || 'Authentication failed. Please try again.';
    throw Object.assign(new Error(msg), { code: data.error });
  }

  if (!data.supabaseToken) {
    throw new Error('auth response missing supabaseToken - backend may be out of date');
  }
  saveRawToken(data.token);
  saveSupabaseToken(data.supabaseToken);
  saveDiscordFriends(data.discord_friends || []);
  return { user: data.user, token: data.token, supabaseToken: data.supabaseToken };
}

// Trade the stored token for a fresh one carrying current standing.
//
// ── Why the app calls this on every launch ────────────────────────────────
// Two things used to be impossible without a full Discord re-login:
//
//   1. Seeing a tier you just bought. `tier` is baked into the token at
//      sign-in, so an existing free user who upgraded on the website kept
//      seeing a locked app for up to a week - while the in-game features
//      worked, because the mod payload endpoint reads the LIVE tier. Paid,
//      working in-game, locked in the app.
//   2. Not being signed out weekly. The token lasts 7 days; on day 8 this file
//      declared it stale and the user was dropped at the sign-in screen.
//
// Renewing at launch fixes both at once, because a fresh token is both current
// AND good for another 7 days from now. Anyone who opens Excalibur even once a
// week never meets an expired session again.
//
// ── Failure is a no-op, deliberately ─────────────────────────────────────
// Returns null on ANY failure - offline, server down, 401 - and the caller
// simply keeps the token it already had. That is the whole error strategy: a
// renewal that cannot happen must never be worse than not trying, because this
// runs on the startup path and the alternative is an app that will not open
// when the network is flaky. The one exception is an explicit 401/403, which
// means the token is genuinely finished; the caller is told so it can send the
// user to sign in rather than retry forever.
async function renew() {
  const current = loadRawToken();
  // No point asking with nothing, or with something already expired - the
  // server will refuse an expired token anyway (jwtVerify checks exp), so this
  // just saves a pointless round trip on a cold launch after a long absence.
  if (!isTokenFresh(current)) return null;

  let res;
  try {
    res = await fetch(`${AUTH_API_URL}?action=renew`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   `Bearer ${current}`,
      },
      body: '{}',
      // ── The timeout is the whole point of this function's error strategy ──
      // "Failure is a no-op" above only ever handled a fetch that REJECTS -
      // offline, DNS, connection refused. A fetch that HANGS never rejects, so
      // without this the catch below can never run and the caller waits
      // forever. On 2026-08-15 the API slowed under launch load and every user
      // sat on "Verifying access" indefinitely, holding a perfectly valid
      // 7-day token they could have booted with. A slow server must degrade to
      // "did not renew", never to "cannot start".
      signal: AbortSignal.timeout(RENEW_TIMEOUT_MS),
    });
  } catch {
    return null;                       // offline, or too slow. Keep what we have.
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  const outcome = renewOutcome(res.status, data);
  if (outcome.action !== 'store') return outcome.result;

  // Both tokens are replaced together or neither is. They share a 7-day life
  // and every Supabase-backed call would start 401ing against a stale HS256
  // token while the main one looked fine.
  saveRawToken(data.token);
  saveSupabaseToken(data.supabaseToken);
  return outcome.result;
}

/**
 * What to DO with a renew response. Split out from the network so the branching
 * can actually be tested (electron/auth-renew.test.cjs) - it is the part with
 * real consequences, and every branch here used to be an untested `if`.
 *
 * Returns `{ action, result }`:
 *   action 'store'  -> persist the new tokens, hand `result` back
 *   action 'keep'   -> change nothing; `result` is null, the caller keeps its
 *                      existing token and carries on as if it never asked
 *   action 'signout'-> the token is finished; `result` says so
 *
 * The governing rule: ONLY an explicit 401/403 may sign someone out. Every
 * other failure - a 500, a 503, a proxy returning HTML, a body missing half its
 * fields - is treated as "not now". Getting that backwards would mean a server
 * hiccup logs out every user of the app at once, on startup, which is a far
 * worse outage than a stale tier.
 */
function renewOutcome(status, data) {
  // Revoked, banned, or access withdrawn. The one case where the app must stop
  // pretending the user is signed in.
  if (status === 401 || status === 403) return { action: 'signout', result: { rejected: true } };

  if (status < 200 || status >= 300) return { action: 'keep', result: null };

  // A 200 that is missing either token is not a renewal. Storing half of a pair
  // would leave the RS256 and HS256 sessions out of step, which is worse than
  // not renewing at all.
  if (!data || typeof data.token !== 'string' || typeof data.supabaseToken !== 'string'
      || !data.token || !data.supabaseToken) {
    return { action: 'keep', result: null };
  }

  return {
    action: 'store',
    result: {
      user:          data.user || null,
      token:         data.token,
      supabaseToken: data.supabaseToken,
      tierChanged:   !!data.tier_changed,
    },
  };
}

function logout() {
  clearToken();
  clearSupabaseToken();
  clearDiscordFriends();
}

function getDiscordFriends() {
  return loadDiscordFriends();
}

module.exports = {
  getStatus, getToken, login, logout, renew, renewOutcome,
  parseJwtPayload, userFromClaims, getDiscordFriends,
};
