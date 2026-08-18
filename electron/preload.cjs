// Preload bridge. Exposes a narrow, typed-ish API surface to the renderer via
// `window.gtmm`. Nothing else (fs, child_process, path) should ever be reachable
// from the React side.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

// Subscribe helper that hands back an unsubscribe closure, so renderer effects
// can tear their listener down. `ipcRenderer.on` returns the emitter itself,
// which is useless as an effect cleanup value (React would throw on it).
const on = (channel, handler) => {
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('gtmm', {
  window: {
    minimize: () => invoke('window:minimize'),
    close: () => invoke('window:close'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    forceQuit: () => invoke('window:force-quit'),
    setBackgroundMaterial: (material) => invoke('window:set-background-material', material),
    setOverlayTheme: (cfg) => invoke('window:set-overlay-theme', cfg),
    onWillClose: (cb) => ipcRenderer.once('app:will-close', () => cb()),
    onFocusChanged: (cb) => {
      const handler = (_e, focused) => cb(!!focused);
      ipcRenderer.on('window:focus-changed', handler);
      return () => ipcRenderer.removeListener('window:focus-changed', handler);
    },
    // The window came back from the tray (or from a second launch while
    // hidden). With closeToTray on, this is what "opening the app" means for
    // someone who has not restarted it in days, so it is the cue to re-read
    // anything the renderer would otherwise only load once at boot.
    onRevealed: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('app:revealed', handler);
      return () => ipcRenderer.removeListener('app:revealed', handler);
    },
  },
  config: {
    get: () => invoke('config:get'),
    set: (patch) => invoke('config:set', patch),
  },
  sync: {
    // Cloud Sync — main-process helpers (identity + Pro+ vault file ops).
    deviceInfo:   () => invoke('sync:device-info'),
    hashMods:     (baseNames) => invoke('sync:hash-mods', baseNames),
    readModFile:  (baseName) => invoke('sync:read-mod-file', baseName),
    writeModFile: (payload) => invoke('sync:write-mod-file', payload),
  },
  steam: {
    detect: () => invoke('steam:detect'),
    listGorillaTagFolders: () => invoke('steam:list-gt-folders'),
  },
  dialog: {
    pickFolder: () => invoke('dialog:pick-folder'),
    pickModFiles: () => invoke('dialog:pick-mod-files'),
  },
  mods: {
    scan: (gamePath) => invoke('mods:scan', gamePath),
    // Multi-file mod archives. archiveIndex enumerates a picked .zip without
    // decompressing it (so the size checks run before anything inflates),
    // archiveEntry drains one file at a time, archiveRelease frees the handle.
    archiveIndex:   (bytes, maxUnpacked) => invoke('mods:archive-index', { bytes, maxUnpacked }),
    archiveEntry:   (handle, entryPath) => invoke('mods:archive-entry', { handle, entryPath }),
    archiveRelease: (handle) => invoke('mods:archive-release', { handle }),
    toggle: (modPath, enable) => invoke('mods:toggle', { modPath, enable }),
    // baseNames (optional): limit the bulk toggle to just those mods. Omit to
    // act on every mod in the folder.
    setAll: (gamePath, enable, baseNames = null) => invoke('mods:set-all', { gamePath, enable, baseNames }),
    install: (gamePath, targetPath, sourcePaths) =>
      invoke('mods:install', { gamePath, targetPath, sourcePaths }),
    checkUpdates: (mods) => invoke('mods:check-updates', mods),
    update: (gamePath, mod) => invoke('mods:update', { gamePath, mod }),
    setInstalledVersion: (baseName, version) => invoke('mods:set-installed-version', { baseName, version }),
    rename: (modPath, newName) => invoke('mods:rename', { modPath, newName }),
    move: (modPath, destDir) => invoke('mods:move', { modPath, destDir }),
    createFolder: (gamePath, parentDir, folderName) =>
      invoke('mods:create-folder', { gamePath, parentDir, folderName }),
    delete: (modPath) => invoke('mods:delete', { modPath }),
    reveal: (modPath) => invoke('mods:reveal', { modPath }),
    openPlugins: (gamePath) => invoke('mods:open-plugins', gamePath),
    installUrl: (gamePath, url) => invoke('mods:install-url', { gamePath, url }),
    // sha256 is the hash the SERVER recorded for this mod. Passing it lets main
    // refuse bytes that are not the bytes that were scanned - the archive
    // installer has always done this; the single-file one had no check at all.
    installCommunity: (gamePath, url, name, sha256) => invoke('mods:install-community', { gamePath, url, name, sha256 }),
    // Multi-file community mod: `files` is the server-computed install list from
    // /api/mods/archive-files. installCommunity writes ONE bare .dll and would
    // silently install a broken mod if handed a multi-file one.
    installArchive: (gamePath, files, name, id, primarySha) => invoke('mods:install-archive', { gamePath, files, name, id, primarySha }),
    suggestRegistryMatch: (typedName) =>
      invoke('mods:suggest-registry-match', { typedName }),
    // Mods stranded in OTHER Gorilla Tag folders, + pulling them into this one.
    externalList: () => invoke('mods:external-list'),
    transfer: (items, mode) => invoke('mods:transfer', { items, mode }),
  },
  diagnose: {
    run: () => invoke('diagnose:run'),
  },
  game: {
    isRunning: () => invoke('game:is-running'),
    launch: (mode, launchOptions) => invoke('game:launch', { mode, launchOptions }),
    quit: () => invoke('game:quit'),
    resetDisplay: () => invoke('game:reset-display'),
  },
  gtVersions: {
    fetchManifests:  (opt) => invoke('gtv:fetch-manifests', opt || {}),
    detectSteam:     ()    => invoke('gtv:detect-steam'),
    listInstalled:   ()    => invoke('gtv:list-installed'),
    // Same list plus a per-version `verified` flag - whether the folder can
    // prove it holds the build its name claims.
    listInstalledDetailed: () => invoke('gtv:list-installed-detailed'),
    isInstalled:     (id)  => invoke('gtv:is-installed', id),
    // Pass the manifest you are asking about; without it the answer is
    // meaningless, since Steam reuses one folder for every version.
    checkSteamFolder: (a)  => invoke('gtv:check-steam-folder', a),
    remove:          (id)  => invoke('gtv:remove', id),
    prepareDownload: (a)   => invoke('gtv:prepare-download', a),
    startPoll:       (a)   => invoke('gtv:start-poll', a),
    cancelDownload:  (id)  => invoke('gtv:cancel-download', id),
    finalize:        (a)   => invoke('gtv:finalize', a),
    onEvent:         (cb)  => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('gtv:event', handler);
      return () => ipcRenderer.removeListener('gtv:event', handler);
    },
    onScrapeProgress: (cb)  => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('gtv:scrape-progress', handler);
      return () => ipcRenderer.removeListener('gtv:scrape-progress', handler);
    },
  },
  packs: {
    export: (modPaths, metadata) => invoke('packs:export', { modPaths, metadata }),
    pick: () => invoke('packs:pick'),
    saveAsProfile: (filePath) => invoke('packs:save-as-profile', { filePath }),
  },
  profiles: {
    list: () => invoke('profiles:list'),
    ensureStandard: (gamePath) => invoke('profiles:ensure-standard', gamePath),
    removeModEverywhere: (baseName) => invoke('profiles:remove-mod-everywhere', baseName),
    renameModEverywhere: (oldName, newName) => invoke('profiles:rename-mod-everywhere', { oldName, newName }),
    save: (profile) => invoke('profiles:save', profile),
    replaceAll: (list) => invoke('profiles:replace-all', list),
    delete: (id) => invoke('profiles:delete', id),
    apply: (gamePath, profileId) => invoke('profiles:apply', { gamePath, profileId }),
    pickIcon: (profileId) => invoke('profiles:pick-icon', profileId),
    // Desktop shortcuts. createShortcut takes { profileId, name, iconPath };
    // iconPath is the profile's own image and is optional.
    createShortcut: (opts) => invoke('profiles:create-shortcut', opts),
    // { [profileId]: '<path>' } - read from the desktop every time, so a
    // shortcut the user deleted in Explorer stops being reported as present.
    shortcutStatus: () => invoke('profiles:shortcut-status'),
    removeShortcut: (profileId) => invoke('profiles:remove-shortcut', profileId),
  },
  bridge: {
    getStatus:      () => invoke('bridge:status'),
    send:           (msg) => invoke('bridge:send', msg),
    // These return an unsubscribe function so a React effect can clean up
    // (`return off`). Without it a remounting component stacks listeners and
    // eventually trips Electron's max-listeners warning — and every duplicate
    // handler re-runs the side effect (a party action fired N times).
    onConnected:    (cb) => on('bridge:connected',    ()       => cb()),
    onDisconnected: (cb) => on('bridge:disconnected', ()       => cb()),
    onMessage:      (cb) => on('bridge:message',      (_, msg) => cb(msg)),
  },
  auth: {
    status:              () => invoke('auth:status'),
    login:               () => invoke('auth:login'),
    // Refresh the token in place: current tier/role, and another 7 days.
    renew:               () => invoke('auth:renew'),
    logout:              () => invoke('auth:logout'),
    getDiscordFriends:   () => invoke('auth:get-discord-friends'),
  },
  github: {
    // Opens GitHub OAuth in the browser, confirms the user controls the repo they
    // named, then files a claim carrying that proof for human review on Discord.
    // Grants nothing by itself. `repo` is required, `note` optional.
    // Resolves { ok, filed, github_login, hash_state, message }.
    verifyCreator: (modId, note, repo) => invoke('github:verify-creator', modId, note, repo),
  },
  // excalibur:// deep-link arrivals - fired when someone clicks a
  // profile-share link with the app installed. Payload:
  // { kind: 'profile', target: '<username>', url: '<raw>' }.
  deeplink: {
    onArrive: (cb) => {
      const handler = (_, payload) => cb(payload);
      ipcRenderer.on('deeplink', handler);
      return () => ipcRenderer.removeListener('deeplink', handler);
    },
    // Tell main we can act on deep links now. Main holds every link in a queue
    // until this fires, because a cold start from a desktop shortcut arrives
    // long before the renderer has loaded the profile list - and a play link
    // for a profile we have not read yet is silently dropped. Call this ONCE
    // boot has finished, not when the page loads.
    ready: () => ipcRenderer.send('deeplink:ready'),
  },
  social: {
    onFriendAction:      (cb) => on('social:friend-action',       (_, msg) => cb(msg)),
    onOwnPresenceChange: (cb) => on('social:own-presence-change', (_, msg) => cb(msg)),
  },
  // Main asks the renderer to change page. Currently only the in-game pregame
  // tiles use it (see the setup_tile handler in main.js), whose taps reached
  // no desktop listener at all before 2026-08-02.
  nav: {
    onNavigate: (cb) => on('app:navigate', (_, msg) => cb(msg)),
  },
  presence: {
    setRoute:      (route)    => invoke('presence:set-route',       route),
    setConfig:     (cfg)      => invoke('presence:set-config',      cfg),
    setDevStatus:  (enabled)  => invoke('presence:set-dev-status',  enabled),
    setEnabled:    (enabled)  => invoke('presence:set-enabled',     enabled),
  },
  notificationMirror: {
    getStatus:     () => invoke('notifmirror:get-status'),
    requestAccess: () => invoke('notifmirror:request-access'),
    listAllApps:   () => invoke('notifmirror:list-all-apps'),
    getDefaultBrowser: () => invoke('notifmirror:get-default-browser'),
  },
  downloader: {
    registry:      ()             => invoke('downloader:registry'),
    detectLoader:  (gamePath)     => invoke('downloader:detect-loader', gamePath),
    installed:     (gamePath)     => invoke('downloader:installed', gamePath),
    repoInfo:      (gitPath)      => invoke('downloader:repo-info', gitPath),
    install:       (gamePath, mod) => invoke('downloader:install',   { gamePath, mod }),
    uninstall:     (gamePath, mod) => invoke('downloader:uninstall', { gamePath, mod }),
    onProgress:    (cb) => { const h = (_, data) => cb(data); ipcRenderer.on('downloader:progress', h); return () => ipcRenderer.removeListener('downloader:progress', h); },
    onDone:        (cb) => { const h = (_, data) => cb(data); ipcRenderer.on('downloader:done',     h); return () => ipcRenderer.removeListener('downloader:done',     h); },
  },
  smartNaming: {
    // Hand a finished recording to the disk engine. Never throws; resolves to
    // { ok:true, renamed:bool, ... }. renamed:false means the file safely kept
    // OBS's own name.
    finalize: (opts) => invoke('smart-naming:finalize', opts),
  },
  obs: {
    detectOutputFolder: () => invoke('obs:detect-output-folder'),
    diagnose:           () => invoke('obs:diagnose'),
  },
  tierOverlay: {
    // Show the tier pill on the transparent overlay window. Tier is one
    // of 'free' | 'pro' | 'pro_plus' | 'dev'. Safe to call repeatedly -
    // each call restarts the animation with the new tier.
    show: (tier) => invoke('tier-overlay:show', tier),
  },
  // System-level actions driven by the title-bar dropdown menu -
  // open logs folder, relaunch the launcher, fetch the version
  // string. All thin wrappers around main-process handlers.
  system: {
    openLogs:    () => invoke('system:open-logs'),
    relaunch:    () => invoke('system:relaunch'),
    getVersion:  () => invoke('system:get-version'),
  },
  updater: {
    status:    () => invoke('updater:status'),
    check:     () => invoke('updater:check'),
    install:   () => invoke('updater:install'),
    // What the Update button in the prompt calls: download, then install as soon
    // as it lands. One round trip instead of the renderer waiting for a
    // 'downloaded' push and calling back, which is a window in which the user
    // can close the app and lose the update they just accepted.
    //
    // There is deliberately no bare `download()`. autoDownload is OFF in every
    // policy, so something has to start the transfer, but every caller so far
    // wants download-then-install as one act. A second entry point with no
    // caller is a path nobody tests: scripts/check-update-channels.mjs reports
    // handled-but-uncalled IPC for exactly this reason.
    downloadAndInstall: () => invoke('updater:download-and-install'),
    getConfig: () => invoke('updater:get-config'),
    setConfig: (cfg) => invoke('updater:set-config', cfg),
    // Push channel - main fires 'updater:state' whenever the state
    // machine advances. Returns an unsubscribe fn so the React effect
    // can clean up on unmount.
    onState: (cb) => {
      const handler = (_, state) => cb(state);
      ipcRenderer.on('updater:state', handler);
      return () => ipcRenderer.removeListener('updater:state', handler);
    },
  },
  // Dev-only signal: the paid assemblies the game just loaded were built from a
  // different checkout than this app. Fires during a game launch, once per
  // launch, and only when they actually disagree.
  modBuild: {
    onPaidStale: (cb) => {
      const handler = (_, info) => cb(info);
      ipcRenderer.on('mod:paid-build-stale', handler);
      return () => ipcRenderer.removeListener('mod:paid-build-stale', handler);
    },
    // The paid assemblies were deliberately withheld for this launch (a
    // debugger/dump tool was seen, or the requesting process was not the
    // configured game). Fires so the user learns WHY the paid half is missing
    // instead of reading it as "paid mods are broken".
    onPaidWithheld: (cb) => {
      const handler = (_, info) => cb(info);
      ipcRenderer.on('mod:paid-withheld', handler);
      return () => ipcRenderer.removeListener('mod:paid-withheld', handler);
    },
  },
  util: {
    screens: () => invoke('util:screens'),
    openLog: () => invoke('util:open-log'),
    clearLog: () => invoke('util:clear-log'),
    resetConfig: () => invoke('util:reset-config'),
    openBepInEx: (gamePath) => invoke('util:open-bepinex', gamePath),
    openFolder: (p) => invoke('util:open-folder', p),
    openExternal: (url) => invoke('util:open-external', url),
    paths: () => invoke('util:paths'),
    username: () => invoke('util:username'),
    readBepInExLog: (gamePath) => invoke('util:read-bepinex-log', gamePath),
    // No arguments on purpose: identity and permission are both read from the
    // verified token in the main process, never supplied by the caller.
    diagnostics: () => invoke('util:diagnostics'),
    canDiagnose: () => invoke('util:can-diagnose'),
    appVersion: () => invoke('util:app-version'),
  },
  reshade: {
    detect:        (gamePath) => invoke('reshade:detect', gamePath),
    openDownload:  () => invoke('reshade:open-download'),
    installPreset: (args) => invoke('reshade:install-preset', args),
  },
  // ── Session log history (Modrinth-style per-modpack log archive) ──
  gameLogs: {
    snapshot:   (profileId, gamePath) => invoke('game-logs:snapshot', { profileId, gamePath }),
    list:       (profileId)           => invoke('game-logs:list', profileId),
    read:       (logPath)             => invoke('game-logs:read', logPath),
    delete:     (logPath)             => invoke('game-logs:delete', logPath),
    openFolder: (profileId)           => invoke('game-logs:open-folder', profileId),
  },
  // ── Live-logs pop-out window (tails BepInEx/LogOutput.log in near-real-time) ──
  logWindow: {
    open:           (gamePath) => invoke('logwin:open', { gamePath }),
    ready:          ()         => invoke('logwin:ready'),
    setAlwaysOnTop: (v)        => invoke('logwin:set-always-on-top', v),
    close:          ()         => invoke('logwin:close'),
    // Streams { initial } once, then { chunk } for appended bytes, { cleared } on
    // relaunch, { waiting } when the game hasn't produced a log yet. Returns a disposer.
    onData: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('logwin:data', h); return () => ipcRenderer.removeListener('logwin:data', h); },
  },
  // ── Mod Test Lab pop-out (toggle built-in features live for testing) ──
  testLab: {
    open:           ()  => invoke('testlab:open'),
    close:          ()  => invoke('testlab:close'),
    setAlwaysOnTop: (v) => invoke('testlab:set-always-on-top', v),
    // On-demand mod rebuild (dev checkouts only). modsStatus reports which C#
    // sources are newer than the built payload; rebuildMods runs the same
    // build the file watcher runs.
    modsStatus:     ()  => invoke('testlab:mods-status'),
    rebuildMods:    ()  => invoke('testlab:rebuild-mods'),
  },
  // ── In-app live logs (streams the current session into the Mods-page panel) ──
  liveLog: {
    start:  (gamePath) => invoke('livelog:start', { gamePath }),
    stop:   ()         => invoke('livelog:stop'),
    // Same payload shape as logWindow.onData ({initial}/{chunk}/{cleared}/{waiting}). Returns a disposer.
    onData: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('livelog:data', h); return () => ipcRenderer.removeListener('livelog:data', h); },
  },
  // ── Luma Looks engine control (2026-07-31) ──────────────────────────────────
  // The Luma panel drives the hosted realism engine over its 47800 control server
  // (via electron/luma-bridge.cjs). connect() starts the client; onHello delivers the
  // engine's live settings; apply() pushes a full settings object back.
  luma: {
    connect:    () => invoke('luma:connect'),
    disconnect: () => invoke('luma:disconnect'),
    apply:      (settings) => invoke('luma:apply', settings),
    status:     () => invoke('luma:status'),
    // The handler for this has existed in luma-window.cjs since the window
    // shipped, and there was no preload key for it - so the Luma controller was
    // permanently alwaysOnTop with no way for the user to turn it off. It
    // floats over every other application, which is exactly the kind of window
    // people want to be able to drop behind things.
    setAlwaysOnTop: (on) => invoke('luma:set-always-on-top', !!on),
    onHello: (cb) => on('luma:hello', (_e, d) => cb(d)),
    onState: (cb) => on('luma:state', (_e, d) => cb(d)),
    onStats: (cb) => on('luma:stats', (_e, d) => cb(d)),
    // Presets area (built-in controller) — see electron/luma-presets.cjs.
    presetsList:      () => invoke('luma:presets-list'),
    presetSave:       (preset) => invoke('luma:preset-save', preset),
    presetDelete:     (name) => invoke('luma:preset-delete', name),
    presetExport:     (preset) => invoke('luma:preset-export', preset),
    presetImport:     () => invoke('luma:preset-import'),
    presetsOpenFolder:() => invoke('luma:presets-open-folder'),
    // The pop-out window itself (electron/luma-window.cjs): opened from the
    // Specials panel, minimized/closed from its own frameless title bar.
    openWindow:     () => invoke('luma:open-window'),
    closeWindow:    () => invoke('luma:close-window'),
    minimizeWindow: () => invoke('luma:minimize-window'),
    onMinimize: (cb) => on('luma:minimize', () => cb()),
    onRestore:  (cb) => on('luma:restore', () => cb()),
  },
});
