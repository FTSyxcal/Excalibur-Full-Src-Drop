'use strict';

// The public GitHub facts the Download page's mod detail needs: what the repo
// says about itself, its README, and its latest release.
//
// ── Why this lives in the main process ───────────────────────────────────────
// The renderer could fetch this itself, but then every mod modal refetches on
// every open, there is no shared cache between windows, and the requests carry a
// browser Origin with no User-Agent we control (GitHub rejects requests that
// send no User-Agent at all). Here we get one cache for the whole app, a real
// User-Agent, and a disk cache that survives a restart.
//
// ── Why the README does NOT come from the API ────────────────────────────────
// Unauthenticated api.github.com allows 60 requests per hour PER IP, and the
// Download page lists 16 mods. If each modal spent three API calls, a user who
// simply browsed the catalogue twice would exhaust the hour's budget and the
// page would start failing - for everything, including the update checker in
// main.js which shares the same 60.
//
// raw.githubusercontent.com is a CDN and is NOT part of that budget. So the
// README - the largest and least structured piece, and the one we want most -
// is fetched from there, and the API budget is spent only on the two things
// that genuinely need it: repo metadata and the latest release.
//
// ── Behaviour when GitHub says no ────────────────────────────────────────────
// Rate limits and outages are normal, not exceptional, so they are handled
// rather than thrown: a stale cache entry is served with `stale: true` when a
// refresh fails, and a hard failure returns `{ ok: false, limited }` which the
// modal renders as a quiet line rather than an error state. A mod detail that
// cannot reach GitHub still shows everything the local registry knows.

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const UA = 'Excalibur-Mod-Manager (+https://excaliburgtag.com)';

// Repo facts change slowly and a stars count being six hours old costs nothing.
// Long on purpose: this is what keeps a browse session inside the API budget.
const TTL_OK   = 6 * 60 * 60 * 1000;
// A failure is retried sooner, but not immediately - a rate-limited window lasts
// up to an hour and hammering it does not shorten it.
const TTL_FAIL = 10 * 60 * 1000;

// Filenames tried on the CDN, in order. Covers effectively every repo; the list
// is short because each miss is a real round trip.
const README_NAMES = ['README.md', 'readme.md', 'Readme.md'];

// gitPath -> { at, ok, data }
const memory = new Map();
let diskLoaded = false;
let writeTimer = null;

function cacheFile() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'github-repo-cache.json');
  } catch {
    return null;
  }
}

function loadDisk() {
  if (diskLoaded) return;
  diskLoaded = true;
  const file = cacheFile();
  if (!file) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, entry] of Object.entries(parsed || {})) {
      if (entry && typeof entry.at === 'number') memory.set(key, entry);
    }
  } catch { /* a missing or corrupt cache is not an error, it is a cold start */ }
}

// Debounced so opening six mods in a row writes once, not six times.
function saveDisk() {
  const file = cacheFile();
  if (!file) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      // Only successful entries are worth persisting. Writing failures to disk
      // would make a single offline session poison the next six hours.
      const out = {};
      for (const [key, entry] of memory) if (entry.ok) out[key] = entry;
      fs.writeFileSync(file, JSON.stringify(out));
    } catch { /* best effort */ }
  }, 2000);
  writeTimer.unref?.();
}

// One GET, resolved (never rejected) as { status, headers, body }. status 0
// means the request never completed - offline, DNS, timeout.
function get(url, headers = {}) {
  return new Promise((resolve) => {
    let req;
    const done = (status, res, body) => resolve({ status, headers: res?.headers || {}, body: body || '' });
    try {
      req = https.get(url, { headers: { 'User-Agent': UA, ...headers }, timeout: 8000 }, (res) => {
        // Follow the one redirect raw.githubusercontent can issue.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(res.headers.location, headers).then(resolve);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
          // A README is text; anything past a quarter megabyte is not something
          // we are going to summarise, and reading it all costs memory.
          if (data.length > 256 * 1024) { data = data.slice(0, 256 * 1024); res.destroy(); }
        });
        res.on('end',   () => done(res.statusCode, res, data));
        res.on('close', () => done(res.statusCode, res, data));
      });
    } catch {
      resolve({ status: 0, headers: {}, body: '' });
      return;
    }
    req.on('error',   () => resolve({ status: 0, headers: {}, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
  });
}

async function getJson(url) {
  const res = await get(url, { Accept: 'application/vnd.github+json' });
  if (res.status !== 200) return { ...res, json: null };
  try { return { ...res, json: JSON.parse(res.body) }; } catch { return { ...res, json: null }; }
}

// GitHub reports a spent budget as 403 with the remaining header at zero (429 on
// the secondary limiter). Distinguishing this from a 404 matters: one is "come
// back later", the other is "this repo does not exist".
const isLimited = (res) =>
  res.status === 429 || (res.status === 403 && String(res.headers['x-ratelimit-remaining'] || '') === '0');

// "owner/repo" only. Anything else (a URL, a path traversal, a Gitea repo) is
// rejected rather than pasted into a URL.
function parseGitPath(gitPath) {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})$/.exec(String(gitPath || '').trim());
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/i, '') } : null;
}

async function fetchReadme(owner, repo) {
  for (const name of README_NAMES) {
    const res = await get(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${name}`);
    if (res.status === 200 && res.body.trim()) return res.body;
    // A 404 means "not this filename"; anything else means the CDN is unhappy
    // and trying two more names will not help.
    if (res.status !== 404) break;
  }
  return '';
}

function shapeRepo(json) {
  if (!json) return null;
  return {
    fullName:    json.full_name || '',
    htmlUrl:     json.html_url || '',
    description: json.description || '',
    stars:       Number(json.stargazers_count) || 0,
    forks:       Number(json.forks_count) || 0,
    license:     json.license?.spdx_id && json.license.spdx_id !== 'NOASSERTION' ? json.license.spdx_id : '',
    pushedAt:    json.pushed_at || json.updated_at || '',
    topics:      Array.isArray(json.topics) ? json.topics.slice(0, 6) : [],
    archived:    !!json.archived,
    ownerAvatar: json.owner?.avatar_url || '',
    ownerLogin:  json.owner?.login || '',
  };
}

function shapeRelease(json) {
  if (!json || json.draft) return null;
  const assets = Array.isArray(json.assets) ? json.assets : [];
  return {
    tag:         json.tag_name || '',
    name:        json.name || '',
    publishedAt: json.published_at || '',
    // Release bodies are occasionally enormous; the modal only shows an excerpt.
    body:        String(json.body || '').slice(0, 8000),
    htmlUrl:     json.html_url || '',
    // Every asset, so the caller can find the one it is actually going to
    // download. A release routinely ships several - a DLL, a zip, a debug
    // symbols file - and reporting the largest one as "the size" told a person
    // about to fetch a 14 KB DLL that it was 12 MB.
    assets: assets.slice(0, 20).map((a) => ({
      name:      a.name || '',
      size:      Number(a.size) || 0,
      downloads: Number(a.download_count) || 0,
    })),
    downloads:   assets.reduce((n, a) => n + (Number(a.download_count) || 0), 0),
    prerelease:  !!json.prerelease,
  };
}

// The one entry point. Never throws.
async function fetchRepoInfo(gitPath, { force = false } = {}) {
  loadDisk();
  const parsed = parseGitPath(gitPath);
  if (!parsed) return { ok: false, error: 'not_a_github_repo' };
  const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();

  const cached = memory.get(key);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (!force && cached && age < (cached.ok ? TTL_OK : TTL_FAIL)) return cached.data;

  const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
  const [repoRes, relRes, readme] = await Promise.all([
    getJson(base),
    getJson(`${base}/releases/latest`),
    fetchReadme(parsed.owner, parsed.repo),
  ]);

  const limited = isLimited(repoRes) || isLimited(relRes);

  // Nothing usable came back. Serve whatever we have rather than blanking a
  // panel the user was already reading, and say that it is old.
  if (!repoRes.json && !readme) {
    if (cached?.ok) {
      const stale = { ...cached.data, stale: true, limited };
      memory.set(key, { at: Date.now(), ok: true, data: stale });
      return stale;
    }
    const data = {
      ok: false,
      limited,
      error: limited ? 'rate_limited' : (repoRes.status === 404 ? 'not_found' : 'unavailable'),
    };
    memory.set(key, { at: Date.now(), ok: false, data });
    return data;
  }

  const data = {
    ok: true,
    stale: false,
    limited,
    fetchedAt: Date.now(),
    repo: shapeRepo(repoRes.json),
    release: shapeRelease(relRes.json),
    readme,
  };
  memory.set(key, { at: Date.now(), ok: true, data });
  saveDisk();
  return data;
}

module.exports = { fetchRepoInfo, parseGitPath };
