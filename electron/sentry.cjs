// Sentry crash reporting for the Electron main process.
// Loaded as the very first import in main.js so it can capture early
// boot crashes too. Sentry DSNs are public client identifiers - they're
// designed to be embedded in shipping clients and don't grant any
// authoring access to the project.

'use strict';

const DSN = 'https://60bc4b278f10529372853ec25e1ceb57@o4511355915403264.ingest.us.sentry.io/4511356023341056';

let _initialized = false;

function init() {
  if (_initialized) return;
  _initialized = true;
  try {
    const Sentry = require('@sentry/electron/main');
    Sentry.init({
      dsn: DSN,
      // Capture both main and renderer crashes through this single SDK init.
      // Renderer-side @sentry/electron/renderer plugs into the same project.
      tracesSampleRate: 0.0,         // start with errors only; turn on perf later
      autoSessionTracking: true,
      // Don't send events while developing locally - we don't want our own
      // dev iterations polluting the production project.
      beforeSend(event) {
        if (process.env.NODE_ENV === 'development' || process.defaultApp) return null;
        return event;
      },
    });
  } catch (e) {
    // Never let Sentry init crash the app. If it can't initialize, we
    // simply lose crash reporting - that's recoverable, the alternative
    // is fatal.
    console.error('[Sentry] init failed:', e && e.message);
  }
}

module.exports = { init };
