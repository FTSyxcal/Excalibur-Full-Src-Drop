// Overlay-window renderer script. Loaded from index.html as an external
// <script src="./overlay.js"> so it doesn't trip the page's CSP
// `default-src 'self'` (which blocks inline scripts).
//
// The preload bridge exposes window.api.onShow(cb) + window.api.notifyDone().
// Each onShow call animates the pill, or - when tier === '__debug__' -
// shows a solid red rectangle for 4s to prove the window is rendering.

const TIER_LABELS = { free: 'FREE', pro: 'PRO', pro_plus: 'PRO+', dev: 'DEV' };
const pill  = document.getElementById('pill');
const label = document.getElementById('label');
const debug = document.getElementById('debug');

// Sanity log forwarded to the main process via `console-message` so we
// can verify the script actually executed (which previously failed
// silently under CSP).
console.log('[overlay-page] script booted; api=' + (typeof window.api));

// Track the in-flight debug timer so rapid clicks don't leave it on
// screen, and so a Test click after a Debug click can immediately
// clear the big red rectangle (otherwise it sits on top of the pill
// for the remainder of its 4-second timer and the pill looks broken).
let debugTimer = null;

function hideDebug() {
  if (debugTimer) { clearTimeout(debugTimer); debugTimer = null; }
  debug.style.display = 'none';
}

window.api.onShow((tier) => {
  console.log('[overlay-page] onShow tier=' + tier);

  if (tier === '__debug__') {
    // Solid bright red 200×80 rectangle for 4 seconds. Proves the
    // window is created, positioned correctly, and rendering its
    // contents - independent of the pill / CSS animation path.
    hideDebug();   // clear any in-flight one first
    debug.style.display = 'flex';
    debugTimer = setTimeout(() => {
      hideDebug();
      window.api.notifyDone();
    }, 4000);
    return;
  }

  // Always clear the debug rectangle when a real pill shows - otherwise
  // a Debug→Test click sequence leaves the big red box covering the
  // small pill for up to 4 seconds.
  hideDebug();

  const t = TIER_LABELS[tier] ? tier : 'free';
  pill.dataset.tier = t;
  label.textContent = TIER_LABELS[t];
  // Force restart the animation: remove class, force reflow, re-add.
  pill.classList.remove('show');
  void pill.offsetWidth;
  pill.classList.add('show');
});

// When the CSS animation finishes, notify main so the window can be
// hidden until the next show().
pill.addEventListener('animationend', () => {
  console.log('[overlay-page] animationend');
  pill.classList.remove('show');
  window.api.notifyDone();
});
