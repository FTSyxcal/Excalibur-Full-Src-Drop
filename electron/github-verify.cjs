// GitHub creator-verification OAuth. Mirrors auth.cjs's Discord flow: opens the
// GitHub authorize page in the user's browser, captures the code on a temporary
// localhost server, then hands { code, mod_id } to the API which exchanges it
// server-side (the client secret never touches the desktop) and confirms the
// signed-in GitHub user owns the mod's linked repo.
//
// Deliberately requests NO OAuth scopes: a no-scope token can still read the
// user's public profile (GET /user) and public repo ownership, which is all we
// need. GitHub's consent screen therefore shows "public data only" — nothing
// about private repos or write access — so creators aren't spooked.

const { shell } = require('electron');
const http   = require('http');
const { URL } = require('url');
const crypto = require('crypto');

const CALLBACK_PORT = 52140; // distinct from Discord's 52139
const REDIRECT_URI  = `http://localhost:${CALLBACK_PORT}/callback`;

// Public OAuth client id (safe to ship; it appears in the authorize URL anyway).
// The matching secret lives ONLY as a Cloudflare secret used by the API.
const GITHUB_CLIENT_ID = 'Ov23liE3lc7rTQ0ql5vh';

const VERIFY_API_URL = process.env.GITHUB_VERIFY_API_URL
  || (process.env.AUTH_API_URL ? process.env.AUTH_API_URL.replace(/\/api\/auth.*$/, '/api/mods/github-verify') : 'https://excaliburgtag.com/api/mods/github-verify');

// How long a started verification stays answerable. Five minutes was too short in
// practice: GitHub can interrupt the flow with a 2FA enforcement notice, a login, or
// a device check, and the user is reading those screens on our clock. When the window
// closed early the browser came back to a dead port and showed a raw
// ERR_CONNECTION_REFUSED, which tells the user nothing and loses a valid code.
//
// GitHub's own authorization codes expire around 10 minutes, so past that the
// exchange fails regardless - but it now fails with our explanation rather than a
// browser error page. Overridable so the behaviour is testable without waiting.
const WINDOW_MS = Number(process.env.EXCALIBUR_GH_WINDOW_MS) || 15 * 60 * 1000;

// Same shell for every browser-facing page, so a late arrival looks as deliberate as
// a successful one.
function page(heading, sub) {
  return `<!DOCTYPE html>
<html><head><title>Excalibur</title><style>
  body{background:#0d0d12;color:#fff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}
  h2{margin:0;font-size:1.2rem;font-weight:600}
  p{margin:0;opacity:.5;font-size:.85rem}
</style></head><body>
  <h2>${heading}</h2>
  <p>${sub}</p>
</body></html>`;
}

// The single in-flight attempt, if any: { server, timer, cancel, expired }.
//
// Without this, abandoning a verification wedged the feature for five minutes. The
// callback server binds a FIXED port and the only thing that ever freed it was the
// timeout, so a user who walked away from the GitHub tab and came back to try again
// hit their own still-listening server: "Port 52140 is already in use. Close any
// other Excalibur instances and try again." Which named the wrong culprit, since
// there was no other instance.
let pending = null;

// close() is asynchronous. Rebinding immediately after calling it races the OS
// releasing the port and can still throw EADDRINUSE, so callers must await this.
function closeServer(server) {
  return new Promise((done) => (server.listening ? server.close(() => done()) : done()));
}

// Clicking verify again means the user wants a fresh attempt, so retire the old one
// rather than letting it hold the port. Deliberately supersede instead of refusing
// with "already in progress": the previous attempt's browser tab is usually already
// gone, and telling someone to wait five minutes for an invisible timer is worse
// than just starting over.
async function cancelPending(reason) {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  await closeServer(p.server);
  p.cancel(new Error(reason));
}

function waitForGithubCode() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    let settled = false;
    // `server` is genuinely declared below, and these two closures genuinely read
    // it. That is safe here and only here: both are invoked from the server's own
    // request/timeout callbacks, which cannot fire until createServer() has
    // returned and the binding exists. Declaring `server` first is not an option -
    // its request handler calls finish(), so one of the two has to come second.
    // Silenced narrowly rather than by relaxing the rule, because the rule is what
    // catches the version of this that IS a crash.
    /* eslint-disable no-use-before-define */
    // One exit point for every outcome, so the port and the timer are always
    // released exactly once no matter how the attempt ends.
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (pending && pending.server === server) { clearTimeout(pending.timer); pending = null; }
      closeServer(server).then(() => fn(arg));
    };

    // Give up on the WAITING without unbinding the port. A browser that comes back
    // late has to find something that can explain itself; an unbound port produces
    // ERR_CONNECTION_REFUSED, which reads like the app is broken. The listener is
    // released when the next attempt supersedes it, or when the app exits.
    const expire = () => {
      if (settled) return;
      settled = true;
      if (pending && pending.server === server) pending.expired = true;
      reject(new Error('That verification window closed. Start it again in Excalibur.'));
    };
    /* eslint-enable no-use-before-define */

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

      // Already finished or expired. Answer honestly rather than pretending this
      // did something, and never leave the tab on a browser error.
      if (settled) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('This verification link has expired', 'Head back to Excalibur and start it again. Nothing was submitted.'));
        return;
      }

      const code     = url.searchParams.get('code');
      const retState = url.searchParams.get('state');
      const error    = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(error
        ? page('✗ GitHub sign-in failed', error)
        : page('✓ Connected!', 'You can close this tab and return to Excalibur.'));

      if (error) { finish(reject, new Error(`GitHub error: ${error}`)); return; }
      if (!code || retState !== state) { finish(reject, new Error('Invalid callback state')); return; }
      finish(resolve, code);
    });

    server.on('error', (err) => {
      // Now that we retire our own in-flight attempt first, EADDRINUSE genuinely
      // does mean something else holds the port, so the message is finally true.
      if (err.code === 'EADDRINUSE') finish(reject, new Error(`Port ${CALLBACK_PORT} is already in use. Close any other Excalibur instances and try again.`));
      else finish(reject, err);
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      const authUrl = new URL('https://github.com/login/oauth/authorize');
      authUrl.searchParams.set('client_id',    GITHUB_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      // No scope on purpose — public read only.
      authUrl.searchParams.set('state',        state);
      authUrl.searchParams.set('allow_signup', 'false');
      shell.openExternal(authUrl.toString());
    });

    // Registered before listen resolves so a superseding call can always find it.
    pending = {
      server,
      timer: setTimeout(expire, WINDOW_MS),
      cancel: (err) => finish(reject, err),
      expired: false,
    };
  });
}

// Runs the OAuth dance, then asks the API to confirm the signed-in GitHub account
// controls the repo the claimant NAMES and file a claim carrying that proof.
// `appToken` is the user's Excalibur JWT (so the API knows who is claiming), `repo`
// is the repository they are pointing at, and `note` is optional context. Nothing is granted here: the API
// always returns a filed-for-review result, { ok, filed, github_login, hash_state }.
async function verifyGithub(modId, appToken, note, repo) {
  // Retire any attempt the user walked away from, and WAIT for the port before
  // binding a new listener.
  await cancelPending('superseded by a new verification attempt');
  const code = await waitForGithubCode();
  const res = await fetch(VERIFY_API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${appToken}` },
    body:    JSON.stringify({ code, redirectUri: REDIRECT_URI, mod_id: modId, note: note || '', repo: repo || '' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || 'Verification failed'), { code: data.error });
  return data;
}

module.exports = { verifyGithub };
