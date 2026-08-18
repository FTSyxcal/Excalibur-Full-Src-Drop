// Minimal preload for the tier-badge overlay window.
// Exposes a tiny, single-purpose surface - only the overlay HTML can talk
// to the main process, and only via these two channels.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Called by the overlay when the main process pushes a tier to display.
  onShow: (cb) => ipcRenderer.on('tier-overlay:show', (_e, tier) => cb(tier)),
  // Called when the CSS pop animation completes so main can hide the window.
  notifyDone: () => ipcRenderer.send('tier-overlay:done'),
});
