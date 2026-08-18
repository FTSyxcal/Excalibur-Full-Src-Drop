// The update system's DECISIONS, with no Electron in them.
//
// electron/updater.cjs requires('electron') at module load, so it cannot be
// loaded by plain Node and nothing in it can be unit tested. The three
// judgements that actually matter all live here instead:
//
//   resolveChannel(user)      who gets tester builds
//   normalizePolicy(v)        what a stored/incoming policy value means
//   shouldAutoInstall(...)    whether to act without asking
//
// plus two classifiers (severity, and "is this error really just an empty
// feed"). Covered by electron/update-policy.test.cjs, which runs in
// prebuild:vite.
//
// Getting resolveChannel wrong in either direction is a real failure:
//   * too permissive, and a regular user silently receives untested builds
//   * too strict, and a tester never receives the thing they were made a tester
//     to receive, with no error anywhere to explain it
// So it is a pure function with a test per case rather than an inline
// expression in an event handler.

// The two channel ids. These are electron-updater's own names, not ours:
// `latest` is its default channel on Windows (Provider.getDefaultChannelName
// returns getCustomChannelName('latest'), and getChannelFilePrefix() is '' on
// win32), and `beta` is the name it derives for a prerelease channel. Renaming
// either means clients ask for a file that is never published and every one of
// them silently stops updating. scripts/check-update-channels.mjs asserts these
// still match scripts/release-config.mjs.
const BETA_CHANNEL = 'beta';
const STABLE_CHANNEL = 'latest';

const POLICY_ASK = 'ask';
const POLICY_AUTO = 'auto';

// Which release channel this person is on.
//
// `user` is the object from auth.getStatus().user: claims off an RS256 JWT that
// electron/auth.cjs has already signature-verified. Testers and developers get
// tester builds; everyone else, including anyone signed out, gets stable.
//
// Developers are included because a developer running a PACKAGED build wants to
// see what testers see. The genuinely annoying part of being a developer here
// (the changelog popping on every version bump) is handled separately in
// WhatsNewToast, which excludes them from the auto-popup.
//
// Signed out resolves to stable rather than to "unknown": a signed-out app is
// not a tester by definition, so there is nothing to wait for.
function resolveChannel(user) {
  const isTester = user?.is_tester === true || user?.is_master_tester === true;
  const isDeveloper = user?.app_role === 'developer';
  return (isTester || isDeveloper) ? BETA_CHANNEL : STABLE_CHANNEL;
}

// Coerce anything into a policy. Unknown values, null, undefined and garbage all
// become 'ask', because the safe failure for "may I install software without
// asking" is to ask. A corrupted config must not silently opt someone into
// unattended installs.
function normalizePolicy(value) {
  return value === POLICY_AUTO ? POLICY_AUTO : POLICY_ASK;
}

// Whether this update proceeds with no user interaction.
//
// `mandatory` overrides the policy on purpose: a release flagged mandatory in
// src/lib/whats-new.js is one older builds cannot work without, so "Later" on it
// would mean "stay broken". The prompt still appears and still states the
// reason; it just has no Later button.
function shouldAutoInstall({ policy, mandatory } = {}) {
  return normalizePolicy(policy) === POLICY_AUTO || mandatory === true;
}

// Label the size of the jump so the prompt can word itself.
//   major -> 1.x.x -> 2.0.0
//   minor -> 1.0.x -> 1.1.0
//   patch -> 1.0.0 -> 1.0.1
// Returns null when `next` is not actually newer, which is the case worth having
// a value for: it means something upstream offered a version it should not have.
function classifySeverity(current, next) {
  try {
    const [cMaj, cMin, cPatch] = String(current).split('.').map((n) => parseInt(n, 10) || 0);
    const [nMaj, nMin, nPatch] = String(next).split('.').map((n) => parseInt(n, 10) || 0);
    if (nMaj > cMaj) return 'major';
    if (nMaj === cMaj && nMin > cMin) return 'minor';
    if (nMaj === cMaj && nMin === cMin && nPatch > cPatch) return 'patch';
    return null;
  } catch { return null; }
}

// Distinguish "there is nothing published on this channel yet" from "the update
// system is broken". The first is normal pre-launch state and must not paint a
// red error; the second must.
//
// ERR_UPDATER_CHANNEL_FILE_NOT_FOUND is deliberately treated as no-feed: a
// tester whose newest release carries only latest.yml hits it, and
// electron-updater already retries with the default channel, so surfacing it
// would be noise about a condition that resolves itself.
function isNoFeedError(err) {
  const message = err?.message || String(err) || '';
  const status = err?.statusCode;
  return (
    status === 404 ||
    /HttpError:\s*404/i.test(message) ||
    /Not Found/i.test(message) ||
    /Cannot find latest\.yml/i.test(message) ||
    /Cannot find beta\.yml/i.test(message) ||
    /Cannot find channel/i.test(message) ||
    /ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(message) ||
    /ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(message) ||
    /No published versions/i.test(message)
  );
}

module.exports = {
  BETA_CHANNEL, STABLE_CHANNEL, POLICY_ASK, POLICY_AUTO,
  resolveChannel, normalizePolicy, shouldAutoInstall,
  classifySeverity, isNoFeedError,
};
