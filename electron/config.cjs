const fs = require('fs');
const path = require('path');
const { getWritableBaseDir, logError } = require('./logger.cjs');

function getConfigPath() {
  return path.join(getWritableBaseDir(), 'config.json');
}

const defaults = {
  gamePath: null,         // Manually chosen or auto-detected path to the Gorilla Tag install folder
  theme: 'dark',          // 'dark' | 'light'
  accent: 'gold',         // Primary accent color id - see src/lib/accent-themes.js
  launchMode: 'steamvr',  // 'steamvr' | 'quest' - which runtime the Launch button targets
  window: null,           // Persisted BrowserWindow bounds
  onboarded: false,       // Used to skip first-run flows once a path is set
  launchOnStartup: false, // Add Excalibur to Windows startup (registry Run entry)
  startMinimized: false,  // When launched at startup, open minimized to the taskbar
  // Closing the window hides it to the system tray instead of quitting. OFF by
  // default on purpose: with it on, the X button stops meaning "quit", and an
  // app that silently keeps running after you closed it is the behaviour users
  // hate most - it has to be something you asked for. The tray icon only exists
  // while the window is hidden (see electron/tray.cjs).
  closeToTray: false,
  obsPassword: '',        // OBS WebSocket server password (blank = no password)
  // Where OBS's WebSocket server is. Device-specific (an OBS on this or another
  // PC), so it lives here in top-level settings alongside the password — NOT
  // per-profile and never cloud-synced. The desktop OBS bridge + the in-game mod
  // both connect here.
  obsHost: '127.0.0.1',
  obsPort: 4455,
  // One-shot marker for repairHijackedObsRecordingPath() in electron/main.js.
  // Builds up to 1.0.1 rewrote OBS's recording folder to %APPDATA%\Excalibur\
  // recordings every 15 seconds; this records that we have put it back once,
  // so the repair can never itself become a thing that overrides the user.
  obsRecPathRepaired: false,
  // The user's OWN OBS FilenameFormatting, captured by the renderer's OBS
  // bridge (src/lib/obs/useObsBridge.js) immediately before Smart Naming's
  // standing format first overwrites it, and cleared only when a restore is
  // CONFIRMED written back to OBS. Persisted because the standing format lives
  // in OBS's own profile: after a normal app quit, the next launch would
  // otherwise read OUR stale format back as "the user's original" and later
  // restore a literal name instead of what the user actually had.
  obsUserFilenameFormat: null,
  // ── Appearance ────────────────────────────────────────────────────────────
  // OLED is the default (owner call 2026-08-03). Only affects NEW configs -
  // anyone who already picked a background keeps it, because loadConfig merges
  // the saved value over these defaults.
  // 'signature' is the default (owner call 2026-08-12), replacing 'oled'. This
  // line only governs a BRAND NEW config; everyone who already has one keeps
  // whatever they picked, because loadConfig merges saved over defaults. The
  // one-time switch for existing installs is bgSignatureDefaultApplied below.
  bgStyle:       'signature', // Background style key (see src/lib/themes.js), or 'custom'
  // ONE-TIME, and the flag is the whole point of it.
  //
  // The ask was "make it the default for new users AND for everyone on the next
  // tester update, but they must definitely still be able to change it after".
  // Those two pull in opposite directions: forcing the value on update is what
  // reaches existing installs, and forcing it again would undo their next
  // change. So the migration runs exactly once, records that it ran, and never
  // looks at bgStyle again - after that the setting is theirs, permanently.
  //
  // Never reset this flag to re-run the switch. Bump to a NEW key if a future
  // default ever has to be pushed out the same way, so an install that already
  // moved past this one is not dragged back through it.
  bgSignatureDefaultApplied: false,
  // Custom background gradients (Pro+). The library and the pointer into it.
  // bgStyle:'custom' means "render bgGradients[bgGradientId]"; if that pointer
  // dangles, applyTheme falls back to a preset rather than painting nothing.
  // Kept as two keys, but ALWAYS written as one atomic config patch - see the
  // note in App.jsx handleAppearanceChange about how the old custom background
  // lost its colour. See src/lib/bg-gradients.js for the shape.
  bgGradients:   [],
  bgGradientId:  null,
  panelStyle:    'default',  // Panel opacity/blur: default | glass | frosted | solid
  radiusStyle:   'default',  // Corner radius: sharp | default | soft | bubble
  fontStyle:     'default',  // Font: default | mono | tight
  animSpeed:     'normal',   // Animation speed: off | fast | normal | slow
  // Performance mode. Supersedes the old standalone "Disable animations"
  // toggle, which only ever set animSpeed:'off'. This is the whole low-end-PC
  // switch: no animations, no ambient loops, no blur, no particles, no banner
  // video, and slower background polling. See src/lib/perf-mode.js.
  //
  // Deliberately NOT in the cloud-sync key list (src/lib/cloud-sync.js): it is
  // a statement about THIS MACHINE, and syncing it would push a laptop's
  // performance mode onto the same person's desktop.
  performanceMode: false,
  sidebarDensity:'regular',  // 'regular' | 'compact' - compact hides labels, shows icons only
  hideSidebarAvatar: false,  // Show the initial letter instead of the Discord picture (Settings > Privacy)
  glowIntensity: 100,        // Accent glow 0–200 (100 = default strength)
  particlesEnabled: true,    // Floating particles on home page
  particlesOpacity: 80,      // Particle opacity 0–100
  celebrationSounds: false,  // OFF by default - soft chime on activation events when enabled
  messageSounds:     true,   // soft pop on every incoming DM, app-wide (Social pipeline)
  // How loud that pop is, 0..1, where 1 is the full-strength sound the
  // "inaudible" fix produced. Halved by default (owner, 2026-08-03) with a
  // slider in the notifications modal, because full strength was tuned to carry
  // over game audio and is more than an app you leave open all day needs.
  // DEFAULT_MESSAGE_POP_VOLUME in src/lib/message-pop.js is the same number and
  // is what applies if this key is missing from an older config.
  messageSoundVolume: 0.5,
  liveLogsOnLaunch:  false,  // Pop out a live BepInEx log window when launching the game
  // Tracks which one-time activation milestones the user has crossed so
  // each celebration fires exactly once. Server is the source of truth
  // for the credit grant (so re-installing doesn't farm); this client
  // mirror only suppresses repeat confetti animations.
  activationsSeen: {},
  // ── Mod auto-update engine ──
  // The version the app believes is installed for each mod, keyed by baseName
  // (recorded whenever the app installs or updates a mod). This is the reliable
  // "current version" the update check compares against GitHub's latest release,
  // since the DLL's own PE version is frequently 0.0.0.0 / unreadable.
  modVersions: {},          // { 'Utilla': '1.6.29', ... }
  // Per-mod update policy, keyed by baseName. Unset = fall back to modUpdateDefault.
  modUpdatePolicy: {},      // { 'Utilla': 'auto' | 'ask' | 'never' }
  // The user's default for mods they haven't set individually. null = never asked;
  // the first download makes the choice mandatory, so this stops being null the
  // first time anyone installs a community mod. A per-mod entry above always wins
  // over it, so changing the default never silently overrides a deliberate choice.
  modUpdateDefault: null,   // 'auto' | 'ask' | 'never' | null
  // Tutorial notification: starts visible, becomes dismissed once the
  // user completes all tasks OR hits the "don't show me this again"
  // confirmation modal. Once dismissed, never returns this session
  // OR future sessions on this install.
  tutorialDismissed: false,
  tutorialTasksCompleted: {}, // { 'explore-customization': true, ... }
  // What's-New: tracks the version the user has already seen the
  // changelog for. When app version > seen version, the 10s
  // notification fires once on next launch.
  whatsNewSeenVersion: null,
  // Set once by the 2026-08-03 renumber migration; see applyConfigMigrations.
  whatsNewRenumberedTo09: false,
  // ── App auto-update policy (Settings -> General -> Updates) ──
  //
  //   'ask'  (default) on launch, the update prompt appears with the changelog
  //          for the version on offer. NOTHING is downloaded until the user
  //          agrees, so a metered connection is never spent without consent.
  //          Pressing Later dismisses it for this session only; it returns on
  //          the next launch. Pressing Update downloads and then restarts into
  //          the new version.
  //   'auto' on launch the update downloads and installs with no prompt.
  //
  // There is deliberately no third "never check" value: Later already gives a
  // user full control over any individual update, and a setting that stops
  // checking altogether is how someone ends up permanently stranded on a build
  // with a broken sign-in and no way to be told about it.
  //
  // A release flagged `mandatory` in src/lib/whats-new.js installs under 'ask'
  // too, but still shows the prompt and its reason. It just has no Later button.
  //
  // This is per-install, not per-account, and it applies to whichever CHANNEL
  // the user is on: a tester on 'auto' auto-installs tester builds, a regular
  // user on 'auto' auto-installs promoted builds. Same setting, different feed.
  updatePolicy: 'ask',      // 'ask' | 'auto'
  // First-ever-launch ad interstitial - fired ONCE per install, on
  // the very first boot after onboarding completes. Persists here
  // (not server-side) so a logout/re-login can't re-fire it.
  firstLaunchInterstitialSeen: false,
  // Once-per-install ad interstitials tied to bandwidth-heavy installs.
  // BepInEx = educational framing (the loader every Gorilla Tag mod uses).
  // Re-installs after a flag-reset will re-fire.
  //
  // The FFmpeg twin (`ffmpegFirstInstallInterstitialSeen`) went with FFmpeg
  // itself on 2026-08-08. Old config.json files on disk may still carry the
  // key; loadConfig merges over these defaults, so a stale key is inert.
  bepinexFirstInstallInterstitialSeen: false,
  // Daily challenges page state - { date, tiles, sponsorVideosWatched,
  // bonusClaimed }. Rolls over at local midnight (UI regenerates a
  // fresh state when state.date doesn't match today's YYYY-MM-DD).
  // Mocked client-side until the daily_challenges Supabase schema
  // lands in C-2.5b; real progress and credit grants will run through
  // the server then.
  dailyChallengeState: null,
  activeProfileId: null,      // ID of the last applied profile (for active indicator)
  // ── Cloud Sync ────────────────────────────────────────────────────────────
  // All three are DEVICE-SPECIFIC and are never pushed to the account (the
  // syncable-settings whitelist lives in src/lib/cloud-sync.js).
  cloudSyncEnabled:  true,    // Master on/off for backing up profiles + settings (+ Pro+ vault)
  installId:         null,    // Stable per-install device id, lazily minted by electron/sync.cjs
  vaultLastBackupAt: null,    // ms timestamp of the last successful Pro+ mod-vault backup ("Last backed up")
  // ── Smart File Naming ─────────────────────────────────────────────────────
  smartNamingConfig: {
    tokens: [
      { id: 'date',    enabled: true  },
      { id: 'time',    enabled: true  },
      { id: 'mode',    enabled: true  },
      { id: 'room',    enabled: false },
      { id: 'players', enabled: false },
      { id: 'profile', enabled: false },
      { id: 'session', enabled: false },
      { id: 'app',     enabled: true  },
    ],
    separator:       '_',    // token separator character
    prefix:          '',     // prepended before all tokens
    suffix:          '',     // appended after all tokens
    obsOutputFolder: '',     // OBS recording output folder (blank = auto-detect each time)
    sessionCounter:  0,      // auto-increments on each new recording
  },
  // ── Social / Friends ─────────────────────────────────────────────────────
  ownStatus:     'online',  // online | away | dnd | invisible - persisted across sessions
  // `lobbyJoinable` used to live here. It was removed 2026-07-27: it was written
  // by a Friends-page switch and by the wristband, mirrored to presence, and
  // shipped to every friend - and read by absolutely nothing. Old configs keep
  // the stale key harmlessly; nothing merges on it.
  shareRoomCode: false,     // false = room code hidden; others see "In Game" with no code
  // Following the party leader into a NEW room while you are already playing.
  //
  //   false (default) - the game asks first: "Join <code>?" on a VR card.
  //   true            - you are moved straight there and simply told about it.
  //
  // Defaults to asking because being pulled out of a round you are in the
  // middle of, without being asked, is the one thing the follow system has
  // always refused to do. Opting in is a promise you have made to yourself.
  //
  // This does NOT govern launching the game while already in a party: you are
  // standing in no room at that point, so there is nothing to interrupt and
  // nothing to ask about, and you land with your party either way.
  partyAutoJoinRoom: false,
  // Who can join your PARTY. Not to be confused with the removed lobby switch:
  // this one is real and gates every party-up request.
  // Stored here rather than on the party row because it must outlive any one
  // party: it drives the live setting while you are in a party, and is the
  // joinability the next party you create is given. See lib/party.js JOINABILITY.
  // A config written before 'none' was removed can still hold it; PartyPanel
  // normalises on read (normJoinability in lib/party.js) rather than migrating,
  // so an old device file does not leave the pill showing nothing selected.
  partyJoinability: 'friends',   // friends | closed
  // How many people your party holds, you included. Same reasoning as the line
  // above: it outlives any one party, driving the live cap while you are in one
  // and seeding the next party you create. The server clamps to 2-10 and
  // refuses to shrink below the people already in the room.
  partyMaxSize: 10,
  // In-game nametags. Read by the mod through ConfigWatcher (same path as
  // cameraConfig), so changes apply live without restarting Gorilla Tag.
  // Shape MUST match NAMETAGS_DEFAULT in src/lib/feature-defaults.js and the
  // parse in mod/Plugin.cs. (highlightFriends/highlightParty were the v1 keys
  // — replaced by friendIcon/partyCrown/tierColors when the tag design moved
  // to the rounded-bar + icon-row + tier-colored-name look; stale v1 keys
  // riding along in an old config.json are harmless: the mod only parses the
  // keys above.)
  nametagConfig: {
    // 'all' | 'excalibur' | 'party' | 'none'.
    //
    // 'all' since 2026-08-15, REVERSING the party-only default of 2026-07-27
    // (owner call, both times). Party-only is correct in principle and was
    // almost invisible in practice: a tester reported nametags "totally
    // broken", and his log showed the feature working perfectly and drawing
    // nothing, because every player near him read `exc=0 ... member=0
    // leader=0` - nobody in the lobby was in his party OR running Excalibur.
    // A default whose normal outcome is an empty screen reads as a dead
    // feature, and it was reported as one.
    //
    // 'all' rather than back to 'excalibur' deliberately: 'excalibur' would
    // have left that same tester seeing exactly nothing, since none of the
    // nine players around him were running it either.
    visibility:   'all',
    // Present on every default block so a deliberate 'excalibur' pick sticks:
    // the loader migration below only flips blocks WITHOUT this flag.
    visMigratedToParty: true,
    // ...and the same trick for the reversal. See the 2026-08-15 migration.
    visUnpartied: true,
    showLogo:     true,        // Excalibur mark on the bar for Excalibur users
    partyCrown:   true,        // crown icon for members of your party
    friendIcon:   true,        // friend icon for people on your friends list
    tierColors:   true,        // name text colored by the player's tier/role
    showDistance: false,       // append "· 12m"
    maxDistance:  30,          // metres; beyond this a tag isn't drawn
    // ── Appearance (2026-07-31) ──────────────────────────────────────────
    // Every one of these was a hardcoded constant in NametagsModule. They are
    // multipliers/overrides rather than absolutes so the tuned defaults stay
    // the defaults: 1.0 and 0.42 ARE what shipped before.
    scale:        1.0,         // 0.5-2.0 size multiplier on the distance curve
    heightOffset: 0.30,        // metres above the head (0.15-0.9)
    barOpacity:   0.55,        // backing bar alpha; 0 = floating text, no plate
    fadeWithDistance: true,    // fade out toward maxDistance vs stay solid
    seeThroughWalls:  false,   // draw over geometry (wallhack-ish, off by default)
    customColor:  '',          // '#rrggbb' name colour used when tierColors is off
  },
  // Luma Looks companion settings (mirrored from the active profile's
  // featureConfig like wristbandConfig/cameraConfig). The EFFECTS are not
  // here - they live in the engine's own settings.json; this is how you reach
  // the controller and what a session starts as. panelKey read by
  // LumaLooksModule via ConfigWatcher; defaultPreset read by main.js on the
  // engine's hello. Keep shape-identical to LUMA_LOOKS_DEFAULT in
  // src/lib/feature-defaults.js.
  lumaLooksConfig: {
    panelKey: 'L',        // single key opening the in-game controller; 'None' = off
    // Master on/off for EVERY Luma effect, pressed in game. ONE string
    // carrying the whole bind including its modifier ("Shift+L", "F9", "None"),
    // so config can never hold a modifier belonging to a key that is no longer
    // set. It shares the letter with panelKey deliberately: L opens the
    // controller, Shift+L kills the looks, and a bare letter can therefore
    // never switch every effect off by accident.
    // Session-scoped in the mod, never written back here.
    toggleKey: 'Shift+L',
    defaultPreset: '',    // preset applied at session start; '' = keep last look
  },
  // ── Launch Options ───────────────────────────────────────────────────────
  launchOptions: {
    resolution: 'default',   // 'default' | '720' | '1080' | '1440' | '2160'
    monitor:    'default',   // 'default' | '1' | '2' | ...
    displayMode: 'default',  // 'default' | 'windowed' | 'fullscreen' | 'borderless'
    frameRate:  'default',   // 'default' | 'unlimited' | any number 1-10000 as a string
    customArgs: '',          // extra CLI args passed verbatim
  },
  // Set true after Excalibur launches GT with a display/resolution/monitor
  // override (Unity persists those into GT's registry). Cleared once we've
  // restored GT's display defaults after the session ends, so plain Steam
  // launches don't inherit Excalibur's windowed/forced-resolution settings.
  pendingDisplayRestore: false,
  // One-time migration flag: older Excalibur versions leaked GT's display
  // settings into its registry without restoring them. On first launch of a
  // version that has the restore logic, we self-heal any already-leaked state
  // once (no-op if already at GT's defaults), then never auto-heal again.
  displayLeakHealed: false,
  // ── Discord Rich Presence ────────────────────────────────────────────────
  presenceConfig: {
    param1: 'game_mode',       // first display param: game_mode | room_code | player_count | tags | session_time | none
    param2: 'none',            // optional second param (same options)
    showClientRpc:   true,     // desktop client presence while mod manager is open
    showInGameRpc:   true,     // in-game Excalibur presence (overrides Gorilla Tag's default)
    showTimestamp:   true,     // elapsed session timer in in-game presence
  },
  // ── Notification Mirror ──────────────────────────────────────────────────
  // Which Windows apps' toast notifications get mirrored in-game. Device-
  // specific (an OS-level permission + a Windows notification listener
  // process), so it lives here like obsHost above — NOT per-profile.
  // Empty means the feature has nothing to mirror, so the listener process
  // never runs even if the companion toggle is on.
  notificationMirrorApps: ['Discord'],
  // How/where the in-game toast itself looks — read directly by the mod's
  // NotificationMirrorModule on every config change (same mechanism as
  // cameraConfig/setupTilesConfig below), so it persists across mod
  // reconnects without the desktop needing to resend anything.
  notificationMirrorConfig: {
    position: 'bottom-center', // 'bottom-center' | 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
    duration: 'medium',        // 'short' | 'medium' | 'long'
  },
  // ── Social notification switches (the VR half) ───────────────────────────
  // Mirrored down from the user's notification settings on the Social page,
  // which is the ONLY place these are edited. `vrKinds` is a flat
  // prompt-kind -> allowed map so VrNotificationsModule can answer "may I draw
  // this card" with a dictionary lookup, without knowing what a category is.
  // The kinds come from SocialBridgeModule.Raise: party_invite, party_request,
  // party_joined, party_left, party_leader, party_follow, dm, party_chat.
  //
  // Empty by default and treated as "allow" by the mod. That matters on a
  // fresh install and while the profile is still loading: a missing switch
  // must never swallow a party invite. Real values arrive the moment the
  // social profile resolves.
  notificationPrefs: {
    vrKinds: {},
  },
  // ── Setup Tiles ──────────────────────────────────────────────────────────
  // Which floating tiles appear when Gorilla Tag boots, their placement, and the
  // starfield. The in-game module reads this section; the desktop keeps it
  // pointed at whichever Excalibur profile is active.
  //
  // Renamed from `pregameTilesConfig` on 2026-08-08; applyConfigMigrations
  // carries saved blocks across, so do not reintroduce the old key here.
  setupTilesConfig: {
    showProfile:   true,
    showRecording: true,
    showMods:      true,
    showFriends:   true,
    starfield:     true,   // drifting stars behind the tiles
    // Ambient pad volume, 0 = muted. Deliberately low: it is a bed under the
    // room, not music, and it plays inches from the ears.
    ambienceVolume: 0.10,
    // Seconds before the screen dismisses itself. 0 = off, which is the
    // default: the lobby waits for you. The mod clamps anything above 0 to
    // 3..60 and paints a countdown into the CONTINUE button, so it can never
    // vanish without warning.
    autoContinue:  0,
    // Per-tile options - what each tile SHOWS, as opposed to whether it
    // appears. Mirrors SETUP_TILES_DEFAULT in src/lib/feature-defaults.js and
    // is read by SetupTilesModule.ApplyTileOptions.
    friendsFilter:      'all',   // 'all' | 'online' | 'pinned'
    friendsShowRoom:    true,
    friendsShowAvatars: true,
    profileShowAvatar:  true,
    profileShowStatus:  true,
    profileShowRoomTag: true,
    recordingShowObs:   true,
    recordingShowMeter: true,
    recordingWarnIdle:  true,
    modsShowVersions:   true,
    modsSort:           'name',  // 'name' | 'load'
    // Placement of the row around your head (mod clamps these).
    distance:      1.35,   // metres in front of you
    spread:        13.5,   // degrees between tiles
    height:       -0.50,   // metres relative to the head
    scale:         1.0,    // tile size multiplier
    order: ['showProfile', 'showRecording', 'showMods', 'showFriends'],
  },
  // ── Excalibur Camera ─────────────────────────────────────────────────────
  // Preferences (keys / screenshots / capture size) + the camera's starting
  // shot. Live lens+framing tuning happens in-game, not here.
  cameraConfig: {
    menuKey: 'F8',
    shotKey: 'None',
    flyKey: 'F4',
    panelsKey: 'Tab',
    fwdKey: 'W',
    backKey: 'S',
    leftKey: 'A',
    rightKey: 'D',
    // Q/E climb and dive, Z/C roll, Shift boost. Space stays clear for replay
    // play/pause. Must match src/lib/feature-defaults.js and the mod's own
    // fallback in CameraModule - the mod reads THIS file, so this one wins.
    upKey: 'Q',
    downKey: 'E',
    rollLeftKey: 'Z',
    rollRightKey: 'C',
    shotFormat: 'png',
    shotQuality: 92,
    shotDir: '',
    shotPattern: 'shot-{date}-{time}',
    outW: 1920,
    outH: 1080,
    defaultMode: 'off',
    // Panel visibility is NOT stored here — every camera panel (Controller,
    // Casting, Keyframes, Misc, Map Loader) is toggled in-game from the
    // "EXCALIBUR CAMERA" master list. Only lens/framing/prefs live in
    // cameraConfig (written by the mod / desktop menu).
  },
  // DEV ONLY: number of placeholder friends injected into the social state
  // so crowded surfaces can be eyeballed. 0 = off. Never surfaced outside
  // the Developer Panel.
  devFakeFriends: 0,
  wristbandConfig: {
    tabs: [
      {
        id: 'status', enabled: true,
        // showActions covers the whole control block at the bottom of the tab
        // (the nametags toggle plus RESTART / LEAVE / PUBLIC). Defaults on: the
        // C# side also defaults it on for configs written before it existed, so
        // an older config does not come up with the buttons missing.
        settings: { showGameMode: true, showRoomCode: true, showPlayerCount: true, showSessionTime: true, showTagCount: true, showActions: true },
      },
      {
        id: 'obs', enabled: true,
        settings: {
          // Wristband buttons
          showRec:         true,
          showMarker:      true,
          showStream:      false,   // streaming hidden by default - opt-in only
          // PAUSE button, scene-switcher chips and the floating live-preview
          // wing. Read by WristbandObsTab.ApplySettings all along; defaulted
          // here (true, matching the C# fallbacks) on 2026-08-01 when they
          // gained desktop controls, so old configs behave identically.
          showPause:       true,
          showScenes:      true,
          showPreview:     true,
          // Wristband info lines
          // READOUT: all three OFF (owner call 2026-08-08), and renamed so the
          // change reaches people who already have Excalibur.
          //
          // showStatus and showTimecode shipped `true`, so they are sitting in
          // every existing config and would have beaten a flipped default the
          // same way the OBS overlay's REC line did. showStreamTimecode was
          // already false by default but is renamed with them, because the ask
          // was that all three are off after the next tester update, and anyone
          // who had switched it on would otherwise keep it.
          showStatus2:          false,
          showTimecode2:        false,
          showStreamTimecode2:  false,
          // Mic block at the bottom of the tab: status line, live waveform,
          // HEAR MYSELF (monitor) and MIC REC. Arrived here when the CHECK tab
          // was removed.
          showMic:              true,
          // In-game heads-up overlay (parented to the player's camera).
          // Off by default so it doesn't surprise anyone - opt-in.
          // EVERY ONE OF THESE IS OFF (2026-08-05). They used to default true,
          // so switching the overlay on planted a permanent "OBS · ready" in
          // the corner of your vision for the entire session. It is not a
          // notification and it never leaves. Nothing shows now unless it was
          // asked for by name.
          //
          // `overlayShowStatus` is GONE rather than renamed. It used to mean
          // ready + reconnecting + disabled together, and keeping the name
          // while narrowing it to "ready" would have silently switched the
          // problem states on for everyone who already had it set.
          // THE `2` SUFFIXES ARE LOAD-BEARING. Renamed 2026-08-08 after a
          // tester reported that "● REC 00:12:04" still appeared on launch
          // even though the overlay had been defaulted off.
          //
          // The previous pass only retired `overlayShowStatus`, so the two
          // switches BORN in that pass (ready, problems) were absent from
          // every saved config and correctly defaulted off, while these three
          // already EXISTED on disk and kept their old saved values. Two of
          // them originally shipped `true`, so REC and LIVE stayed on for
          // everyone while ready and reconnecting vanished. That is exactly
          // the split the tester described.
          //
          // A default is only consulted when the key is ABSENT, and loadConfig
          // is `{ ...defaults, ...parsed }`, so a saved value always wins.
          // Renaming is what makes these absent once, which is the only way a
          // changed default reaches an existing install.
          showOverlay2:               false,
          overlayShowRecordingTime2:  false,
          overlayShowStreamingTime2:  false,
          overlayShowReady:           false,
          overlayShowProblems:        false,
          // Headset only unless this is on: the overlay is dropped from every
          // FLAT camera pass, which also keeps it out of anything you record.
          overlayOnDesktop:           false,
          // Automatic recording — a DESKTOP behaviour, stored here because the
          // OBS tab is where it belongs for the user. The desktop OBS bridge
          // reads these; the in-game mod ignores them. Off by default.
          autoRecordOnLaunch:         false,
          autoStopOnQuit:             false,
        },
      },
      {
        id: 'friends', enabled: true,
        settings: { showActivity: true, showPinnedStar: true },
      },
      {
        id: 'party', enabled: true,
        settings: { showMembers: true, showRoomCode: true },
      },
      {
        // showQuickReplies removed 2026-08-01: no C# reader existed and the
        // game has no quick replies. Old configs still carrying it are
        // harmless - WristbandMessagesTab.ApplySettings reads only showPreview
        // and ignores unknown keys.
        id: 'messages', enabled: true,
        settings: { showPreview: true },
      },
      {
        id: 'music', enabled: true,
        settings: {},
      },
      {
        id: 'mods', enabled: true,
        settings: {},
      },
      {
        // QUICK STYLE. Lives on its own workspace button (the third slot in
        // the wristband's left tray), not in the PAGES rail - it is a
        // get-in-change-it-get-out surface.
        //
        // PRO (owner confirmed 2026-08-07). This comment previously said Free,
        // which contradicted every other copy: the tab class ships in mod-pro/
        // (so a free account is never even SENT it), TAB_REQUIRED_TIER says
        // pro, and WristbandPanel.jsx says pro. `enabled: true` here is the
        // DEFAULT-ON switch, not an entitlement - tier is enforced by the three
        // places above, so this line being true does not hand it to free users.
        id: 'style', enabled: true,
        settings: {},
      },
      {
        // Renamed from 'packs' 2026-07-31 - it switches PROFILES, not packs.
        // loadConfig migrates the old id; see the tabs block below.
        id: 'profiles', enabled: true,
        settings: {},
      },
      // CHECK tab removed 2026-07-31. Its microphone status and MIC REC button
      // moved to the bottom of the OBS tab (settings.showMic below); the other
      // four rows only restated what the OBS tab already says. A saved config
      // that still carries a 'check' entry is harmless - the mod has no tab
      // with that id, so it is ignored.
      {
        // showBackButton removed 2026-08-01: no C# ever read it and the tab
        // has no back button (the icon rail is the navigation). Old configs
        // still carrying it are harmless - WristbandFilesTab.ApplySettings
        // reads only showPageControls and ignores unknown keys.
        id: 'files', enabled: true,
        settings: { showPageControls: true },
      },
      {
        // Performance tools. Unlike every other tab above, these settings are
        // not "show this row" — each one IS the feature, applied by the mod's
        // PerformanceModule (which reads them straight out of this block, so
        // they work even with the wristband switched off). Every one defaults
        // OFF: they visibly change how Gorilla Tag looks, and that is the
        // player's call, not ours.
        id: 'perf', enabled: true,
        settings: {
          uncapFps:       false,
          frameBoost:     false,
          noShadows:      false,
          noParticles:    false,
          noMirrors:      false,
          lowTextures:    false,
        },
      },
      // LUMA's two rail pages (2026-08-12). LAST, deliberately: SetTabConfig
      // builds the enabled list in CONFIG order and appends only ids the config
      // has never heard of, so putting these anywhere but the end would reorder
      // the rail away from TAB_ORDER in WristbandModule.cs.
      //
      // Both tabs ship in mod-proplus/, so a Pro account is never sent them and
      // `enabled: true` here hands nothing to anyone - the gate is
      // TAB_REQUIRED_TIER (pro_plus on both sides) plus the delivery decision.
      // They are listed at all so the desktop panel can turn them off and
      // reorder them; before this they were invisible to WristbandPanel.jsx.
      { id: 'luma',    enabled: true, settings: {} },
      { id: 'presets', enabled: true, settings: {} },
    ],
    // Which wrist the band is worn on: 'left' | 'right'. The in-game poses
    // were tuned for the left forearm; right is their mirror. See SetWristSide
    // in mod/Features/WristbandModule.cs.
    hand: 'left',
  },
};

// Apply every merge + one-time migration to an ALREADY-PARSED config object.
//
// Split out of loadConfig on 2026-08-01. It used to live inside the same
// try/catch as the read and the parse, which meant a CODE error in any
// migration below (a typo, a half-edited module, an unguarded deref) was
// caught by the handler whose job was to say "this FILE is corrupt" - and the
// caller then persisted `defaults` straight over the user's real settings.
// This is the identical bug that destroyed profiles.json on 2026-08-01; see
// the note above profiles.cjs loadAll. A code failure must never condemn the
// file, so this throws and the caller serves the unmigrated config instead.
function applyConfigMigrations(parsed) {
  const merged = { ...defaults, ...parsed };

  // ── The Signature background, once ───────────────────────────────────────
  // Moves EXISTING installs onto the new default background on the update that
  // introduces it, then gets out of the way forever. Gated on the flag, not on
  // the current value, so somebody who deliberately switches back to OLED
  // afterwards keeps OLED - comparing against 'oled' instead would silently
  // re-apply on every launch and make that setting impossible to keep.
  //
  // A CUSTOM gradient is left alone. Someone on bgStyle:'custom' built or
  // imported that themselves, which is a stronger statement of intent than a
  // preset they may never have touched, and stomping it would throw away work.
  // They still get the flag set, so this never runs at them again.
  //
  // PERSISTED IMMEDIATELY, and that is load-bearing rather than tidiness. The
  // flag only means "already done" if it survives the launch that set it -
  // in-memory alone, every launch would find it false, re-apply the default,
  // and the user's own choice would never stick. That is precisely the failure
  // the request called out ("make sure they can DEFINITELY still change it").
  // saveConfig writes temp + rename and does not read config back, so there is
  // no recursion here - same call the wristband tab merge below makes.
  if (!merged.bgSignatureDefaultApplied) {
    if (merged.bgStyle !== 'custom') merged.bgStyle = 'signature';
    merged.bgSignatureDefaultApplied = true;
    try { saveConfig(merged); } catch { /* a 15s autosave will catch it */ }
  }

    // Deep-merge wristband tabs so new default tabs (added in later versions)
    // are appended to saved configs that predate them.
    if (parsed.wristbandConfig?.tabs) {
      // RENAMES FIRST, or the merge below treats an old id as a tab we simply
      // do not have and the new id as one that is missing - leaving BOTH in the
      // list. The user then sees a dead entry no tab claims, their tab order
      // gains a slot, and the per-tab settings they had configured are stranded
      // on the orphan. Renaming in place keeps position, enabled state
      // and settings exactly where they were.
      //   packs -> profiles   2026-07-31, when it stopped being about packs
      const TAB_RENAMES = { packs: 'profiles' };
      const renamedTabs = parsed.wristbandConfig.tabs.map((t) => (
        TAB_RENAMES[t?.id] ? { ...t, id: TAB_RENAMES[t.id] } : t
      ));
      const renamed = renamedTabs.some((t, i) => t.id !== parsed.wristbandConfig.tabs[i]?.id);
      // Dedupe AFTER the rename map: a transitional save carrying both the old
      // and new id would otherwise yield two 'profiles' tabs (a doubled rail
      // slot in VR, duplicate React keys). First occurrence wins.
      const seenIds = new Set();
      const savedTabs = renamedTabs.filter((t) => {
        if (seenIds.has(t?.id)) return false;
        seenIds.add(t?.id);
        return true;
      });
      const deduped = savedTabs.length !== renamedTabs.length;

      const savedIds = new Set(savedTabs.map((t) => t.id));
      const missing = defaults.wristbandConfig.tabs.filter((t) => !savedIds.has(t.id));
      merged.wristbandConfig = {
        ...defaults.wristbandConfig,
        ...parsed.wristbandConfig,
        tabs: [...savedTabs, ...missing],
      };
      if (missing.length || renamed || deduped) {
        // Persist: the in-game mod reads this FILE via ConfigWatcher, so an
        // in-memory-only merge would never reach a running game. Through
        // saveConfig (write temp + rename) so the watcher can never see a
        // half-written file; saveConfig only writes, so no recursion here.
        try { saveConfig(merged); } catch { }
      }
    }

    // Same reason as the wristband merge above: a config saved before a new
    // nametag option existed would otherwise be missing that key entirely,
    // and the toggle would render as `undefined` (= off) instead of its
    // intended default.
    //
    // The migration below MUST read the PARSED block, captured here before the
    // defaults spread: defaults.nametagConfig now carries
    // visMigratedToParty:true, so the merged block inherits the flag on every
    // old flagless config and testing it would mean the flip never fires.
    const rawNt = parsed && parsed.nametagConfig;
    if (parsed.nametagConfig) {
      merged.nametagConfig = { ...defaults.nametagConfig, ...parsed.nametagConfig };
    }
    // One-time migration (2026-07-27): the nametag default changed from
    // 'excalibur' to 'party' (tags are a party feature — owner call). A saved
    // 'excalibur' is almost certainly the OLD DEFAULT, not a choice, so flip
    // it once; the flag makes a later deliberate 'excalibur' selection stick
    // (the UI writes it on every save, so only pre-flag configs can be
    // flagless — which is exactly why only the parsed copy can be trusted).
    if (rawNt
        && rawNt.visibility === 'excalibur'
        && !rawNt.visMigratedToParty) {
      merged.nametagConfig = { ...merged.nametagConfig, visibility: 'party', visMigratedToParty: true };
    }
    // One-time migration (2026-08-15): and BACK again. The 2026-07-27 flip
    // above moved everyone to party-only, and the field result was a feature
    // that draws nothing in an ordinary public lobby - see the default block.
    // So a saved 'party' is flipped once to 'all'.
    //
    // This CANNOT tell "was auto-migrated to party" from "deliberately chose
    // party": the flag above is written by the migration AND by the default
    // block, so both end up identical on disk. The information to separate
    // them was never recorded. Flipping is the right call anyway because the
    // app is pre-release - the population is a handful of testers, all of whom
    // are reporting the feature as broken - and its own flag makes it a
    // one-shot: re-pick party afterwards and it sticks forever.
    //
    // Ordered AFTER the party migration on purpose, so a config arriving on
    // 'excalibur' with no flags goes excalibur -> party -> all in one load
    // rather than being left on party until the next launch.
    const ntAfter = merged.nametagConfig;
    if (ntAfter && ntAfter.visibility === 'party' && !(rawNt && rawNt.visUnpartied)) {
      merged.nametagConfig = { ...ntAfter, visibility: 'all', visUnpartied: true };
    }

    // One-time migration (2026-08-02): fly binds are Q/E climb+dive, Z/C roll,
    // Shift boost - which is where they started. They were moved to
    // Space/Shift on 08-01 and briefly to R on 08-02; both are reverted here
    // because the owner flew them and rejected both. Space in particular has
    // to stay clear: a loaded replay owns it for play/pause.
    //
    // Matched on the WHOLE previous default set, not on upKey alone. All four
    // values together is a default nobody chose; one of them on its own may
    // well be a deliberate rebind, and flipping that would be taking a key off
    // somebody who picked it. The flag then lets a deliberate return to either
    // old scheme stick. Persisted because the in-game mod reads THIS file via
    // ConfigWatcher, so an unwritten migration is one the mod never sees.
    const PRIOR_BIND_DEFAULTS = [
      { upKey: 'Space', downKey: 'LeftShift', rollLeftKey: 'Q', rollRightKey: 'E' },
      { upKey: 'R',     downKey: 'LeftShift', rollLeftKey: 'Q', rollRightKey: 'E' },
    ];
    if (merged.cameraConfig && !merged.cameraConfig.bindsMigratedQEZC) {
      const cam = merged.cameraConfig;
      const wasPriorDefault = PRIOR_BIND_DEFAULTS.some((d) =>
        cam.upKey === d.upKey && cam.downKey === d.downKey
        && cam.rollLeftKey === d.rollLeftKey && cam.rollRightKey === d.rollRightKey);
      if (wasPriorDefault) {
        merged.cameraConfig = {
          ...cam,
          upKey: 'Q', downKey: 'E', rollLeftKey: 'Z', rollRightKey: 'C',
          bindsMigratedQEZC: true,
        };
        try { fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8'); } catch { }
      }
    }

    // One-time prune of SCRAPPED feature ids (2026-08-03).
    //
    // quick-launch, group-lobby, creator-panel and cosmetic-tryon were removed
    // on 2026-07-24; tier-badge never existed as a feature (the tier overlay is
    // its own window, gated by tier-overlay.cjs, not by a flag). All five were
    // still sitting in config.features, and two of them were set TRUE.
    //
    // Harmless at runtime - the enable loop in Plugin.cs only walks REGISTERED
    // modules, so an id with no module is never consulted - but it is stale
    // data that reads like live state. An audit on 2026-08-03 had to stop and
    // prove "cosmetic-tryon: true" was not a running feature, which is exactly
    // the cost of leaving it there.
    //
    // A FIXED LIST, not "prune anything not in builtin-features". A blanket
    // prune would silently delete ids belonging to a feature added by the OTHER
    // developer's branch before this file learned about it, and the failure
    // would look like their feature switching itself off. Naming them means
    // this can only ever remove the five things it is meant to.
    const SCRAPPED_FEATURE_IDS = [
      'quick-launch', 'group-lobby', 'creator-panel', 'cosmetic-tryon', 'tier-badge',
    ];
    if (merged.features && typeof merged.features === 'object') {
      const gone = SCRAPPED_FEATURE_IDS.filter((id) => id in merged.features);
      if (gone.length) {
        const features = { ...merged.features };
        for (const id of gone) delete features[id];
        merged.features = features;
        // logError, not logInfo: this file only imports logError from
        // logger.cjs, and logInfo here would be a ReferenceError that took the
        // whole config load down with it. It is a one-time notice, not a fault.
        logError(`config: pruned ${gone.length} scrapped feature id(s): ${gone.join(', ')}`);
        try { fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8'); } catch { }
      }
    }

    // Heal internal plumbing features. `social-bridge` is hidden (no UI can
    // re-enable it) but every social surface in the mod depends on it; old
    // pack-reconciliation code used to zero it, permanently killing friends/
    // presence in the wristband. Hidden features have no legitimate "off"
    // state a user could have chosen, so force them back to their default.
    if (merged.features && merged.features['social-bridge'] === false) {
      merged.features = { ...merged.features, 'social-bridge': true };
    }
    // `vr-notifications` is the same class of hidden infra (the in-VR toast
    // stack party invites / join requests / DMs arrive on). It was zeroed by
    // the same pack-reconciliation window while it was still a visible
    // feature; now that it's hidden there is no UI to switch it back on.
    if (merged.features && merged.features['vr-notifications'] === false) {
      merged.features = { ...merged.features, 'vr-notifications': true };
    }

    // ── Discord Rich Presence: unlocked at public launch (2026-08-15) ───────
    // Through the closed beta this block did the OPPOSITE - it forced
    // features['rich-presence'] = false on every single load. That was needed
    // because the in-game mod runs its OWN presence module and reads its on/off
    // state from THIS file, not from the desktop lockdown, so a tester's
    // BepInEx log on 0.9.3 still read "Discord RPC ready for <name>" while the
    // desktop side was silent.
    //
    // DELETING THAT FORCE IS NOT ENOUGH, which is the whole reason this block
    // still exists. Every install that ran a beta build has a literal
    // `"rich-presence": false` written into its config.json. `rich-presence` is
    // a HIDDEN feature (builtin-features.js), so the launch reconcile skips it
    // and would never undo that value - presence would stay dark forever for
    // exactly the people who have been testing, and only new installs would get
    // it. So the beta's own footprint has to be cleaned up explicitly.
    //
    // ONE-TIME, NOT A PERMANENT HEAL. The two heals above (social-bridge,
    // vr-notifications) force their value on every load, which is right for
    // hidden infrastructure with no legitimate "off" state. Rich Presence is
    // different: it HAS a legitimate off state, because Settings offers a real
    // toggle for it (ungated now that RPC_ENABLED is true). Forcing it true on
    // every load would mean a user switches presence off, restarts, and finds
    // it back on - a setting that silently refuses to stick. Guarded by a
    // persisted marker, the same shape as the whatsNew renumber below, so it
    // corrects the beta's leftover exactly once and never fights the user again.
    if (!merged.rpcUnlockedAtLaunch) {
      merged.rpcUnlockedAtLaunch = true;
      if (merged.features && merged.features['rich-presence'] === false) {
        merged.features = { ...merged.features, 'rich-presence': true };
        logError('config: rich-presence was forced off by the closed beta, restored to its default now that presence is public');
      }
      try { fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8'); } catch { }
    }

    // One-time migration (2026-08-03): the version renumber back to beta.
    //
    // 1.0.12 became 0.8.7 and this build is 0.9.0, so every version number went
    // DOWN. whatsNewSeenVersion survives the reinstall (it lives in the same
    // userData dir), and WhatsNewToast only shows entries that are semver-NEWER
    // than it. A saved '1.0.12' is newer than every entry in the renumbered
    // changelog, so without this the catch-up modal would never open again -
    // silently, with nothing to indicate anything was wrong. Exactly the class
    // of failure the renumber was supposed to be free of.
    //
    // Guarded by a flag rather than by "is it 1.x", so that a future genuine
    // 1.0 release cannot re-trigger it and re-show the changelog to everyone.
    // Persisted immediately: this file is the record, and an in-memory-only
    // reset would fire again on the next launch.
    if (!merged.whatsNewRenumberedTo09) {
      const seen = String(merged.whatsNewSeenVersion || '');
      const major = parseInt(seen.split('.')[0], 10);
      merged.whatsNewRenumberedTo09 = true;
      if (Number.isFinite(major) && major >= 1) {
        // null, not '0.8.7': null means "never marked", which is what makes the
        // 0.9.0 page open. Pinning it to 0.8.7 would work today and quietly
        // break if this ever ran twice against a different starting point.
        merged.whatsNewSeenVersion = null;
        logError(`config: whatsNewSeenVersion '${seen}' predates the 0.9.0 renumber, cleared so the changelog shows`);
      }
      try { fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2), 'utf8'); } catch { }
    }

    // One-time migration (2026-08-08): "pregame tiles" was renamed to "setup
    // tiles" everywhere. Two of those names are PERSISTED here, so without this
    // the rename would silently switch the feature off for everyone who had it
    // on and reset every tile setting to defaults - the config would still be
    // valid, just describing a feature nothing answers to any more.
    //
    //   features['pregame-tiles']  the enable switch
    //   pregameTilesConfig         the whole settings block
    //
    // Old key wins only when the new one is absent, so a config already carrying
    // both (written by a newer build, then opened by an older one, then this one)
    // keeps the newer value. The old keys are deleted so this cannot re-fire and
    // stomp a later edit.
    if (merged.features && Object.prototype.hasOwnProperty.call(merged.features, 'pregame-tiles')) {
      const f = { ...merged.features };
      if (!Object.prototype.hasOwnProperty.call(f, 'setup-tiles')) f['setup-tiles'] = f['pregame-tiles'];
      delete f['pregame-tiles'];
      merged.features = f;
    }
    if (parsed.pregameTilesConfig) {
      // Merge over the defaults, not the parsed block alone: a block saved before
      // a newer option existed would otherwise carry that key as undefined.
      merged.setupTilesConfig = {
        ...defaults.setupTilesConfig,
        ...parsed.pregameTilesConfig,
        ...(parsed.setupTilesConfig || {}),
      };
      delete merged.pregameTilesConfig;
      // Persist: the in-game mod reads this FILE via ConfigWatcher, so an
      // in-memory-only rename would never reach a running game.
      try { saveConfig(merged); } catch { }
    }

  return merged;
}

function loadConfig() {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return { ...defaults };

  // A read or parse failure is NOT proof the file is bad. config.json is read
  // and rewritten by several writers at once - the in-game mod's ConfigWatcher
  // holds it open, Cloud Sync rewrites it, a second window saves bounds - so a
  // read can land mid-rename and return torn bytes or EBUSY while the file on
  // disk is perfectly fine. The old single try/catch returned `defaults` on the
  // first such blip, and main.js:2894 writes that straight back from a 15s
  // timer, so one transient failure silently replaced gamePath, modVersions,
  // modUpdatePolicy and every panel setting. Retry on fresh reads first.
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw = null;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      lastError = `read failed: ${e.message}`;
    }

    let parsed = null;
    if (raw !== null) {
      try { parsed = JSON.parse(raw); }
      catch (e) { lastError = `parse failed: ${e.message}`; }
    }

    if (parsed !== null) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        lastError = 'config.json is not an object';
      } else {
        // Migrations run OUTSIDE the parse catch on purpose - see the note on
        // applyConfigMigrations. Serving the user's real settings unmigrated is
        // always better than serving defaults over the top of them.
        try { return applyConfigMigrations(parsed); }
        catch (e) {
          logError(`config: migration failed, serving unmigrated config: ${e.message}`);
          return { ...defaults, ...parsed };
        }
      }
    }

    // Give a concurrent rename a moment to land before the fresh read.
    // Synchronous on purpose - every caller of loadConfig is synchronous.
    const until = Date.now() + 40;
    while (Date.now() < until) { /* spin - 40ms, worst case twice */ }
  }

  logError(`config: config.json unreadable after retries (${lastError})`);

  // Preserve the bytes under a dated name before anyone writes defaults over
  // them, so the user's settings stay recoverable by hand. Without this the
  // next save silently destroyed the only copy.
  try {
    const quarantine = `${p}.corrupt-${Date.now()}`;
    fs.renameSync(p, quarantine);
    logError(`config: quarantined the unreadable config at ${quarantine}`);
  } catch (e) {
    logError(`config: could not quarantine the unreadable config: ${e.message}`);
  }
  return { ...defaults };
}

function saveConfig(cfg) {
  const p = getConfigPath();
  // Atomic: write a temp file, then rename over config.json. The in-game mod
  // reads this file the instant its watcher fires (FileShare.ReadWrite, no
  // lock), so a plain writeFileSync could be seen half-written - which parsed
  // as "every feature off" until the next write. Rename is atomic on NTFS.
  // The mod's watcher listens for Renamed/Created as well as Changed.
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch {
    // Rename can transiently fail on Windows if a reader holds the target
    // open; fall back to the old in-place write rather than losing the save.
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

module.exports = { getConfigPath, loadConfig, saveConfig, defaults };
