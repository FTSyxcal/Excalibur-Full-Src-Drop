'use strict';
// LUMA LOOKS presets (2026-07-31) — the Excalibur side of the standalone app's preset system, so the
// built-in controller has the same "save / apply / import / export" area. Built-in presets are
// vendored (src/lib/luma-presets.json, mirrored from luma-looks/shared/presets); user presets live in
// userData/luma-user-presets.json and export/import as .llpre files (same format the standalone uses,
// so presets move between the two apps). Settings objects are opaque here — the renderer pushes an
// applied preset's `settings` straight to the engine over 47800, exactly like any other edit.

const { app, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// Lives in electron/, NOT src/. It used to be `require('../src/lib/...')`, and
// `src` is in the packager's --ignore list, so in every shipped build that
// require threw and the silent catch below turned all SIX built-in presets into
// an empty list. Nobody noticed because the failure was indistinguishable from
// "no presets". Proven against the real app.asar: zero hits for 'luma-presets'.
// Nothing in src/ ever imported this file, so it simply belongs here.
let builtinPresets = [];
try {
  builtinPresets = require('./luma-presets.json');
  if (!Array.isArray(builtinPresets)) {
    console.error('[luma-presets] built-in presets file is not an array - shipping none');
    builtinPresets = [];
  }
} catch (e) {
  // Loud, not silent. A missing preset file is a broken build, not a valid state.
  console.error('[luma-presets] FAILED to load built-in presets:', e.message);
  builtinPresets = [];
}

const USER_FILE = () => path.join(app.getPath('userData'), 'luma-user-presets.json');

function loadUser() {
  try {
    const arr = JSON.parse(fs.readFileSync(USER_FILE(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveUser(list) {
  try { fs.writeFileSync(USER_FILE(), JSON.stringify(list, null, 1)); return true; }
  catch { return false; }
}

function valid(p) {
  return p && typeof p.name === 'string' && p.name.trim() && p.settings && typeof p.settings === 'object';
}

function registerLumaPresets() {
  ipcMain.handle('luma:presets-list', () => ({ builtin: builtinPresets, user: loadUser() }));

  ipcMain.handle('luma:preset-save', (_e, preset) => {
    if (!valid(preset)) return { ok: false, error: 'Invalid preset' };
    const list = loadUser();
    const entry = {
      name: preset.name.trim(),
      description: (preset.description || 'Custom preset').toString(),
      settings: preset.settings,
    };
    const i = list.findIndex((p) => p.name === entry.name);
    if (i >= 0) list[i] = entry; else list.push(entry);
    // saveUser returns FALSE on a failed write and the result was thrown away,
    // so a full disk or a locked file still answered { ok: true }. The panel
    // then showed the preset as saved, the user closed the app, and it was gone
    // - the one failure where telling the truth actually matters.
    if (!saveUser(list)) {
      return { ok: false, error: 'Could not write your presets file. Check disk space and try again.' };
    }
    return { ok: true, user: list };
  });

  ipcMain.handle('luma:preset-delete', (_e, name) => {
    const list = loadUser().filter((p) => p.name !== name);
    if (!saveUser(list)) {
      return { ok: false, error: 'Could not write your presets file, so nothing was deleted.' };
    }
    return { ok: true, user: list };
  });

  ipcMain.handle('luma:preset-export', async (_e, preset) => {
    if (!valid(preset)) return { ok: false, error: 'Invalid preset' };
    const safe = preset.name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'preset';
    const r = await dialog.showSaveDialog({
      title: 'Export Luma Looks preset',
      defaultPath: `${safe}.llpre`,
      filters: [{ name: 'Luma Looks preset', extensions: ['llpre'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify({
        format: 'luma-looks-preset',
        version: 2,
        name: preset.name,
        description: preset.description || '',
        settings: preset.settings,
      }, null, 1));
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('luma:preset-import', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Import Luma Looks presets',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Luma Looks preset', extensions: ['llpre'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const list = loadUser();
    let imported = 0;
    const errors = [];
    for (const fp of r.filePaths) {
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const name = (data.name || path.basename(fp, '.llpre')).toString().trim();
        if (!name || !data.settings || typeof data.settings !== 'object') throw new Error('not a Luma Looks preset');
        const entry = { name, description: (data.description || 'Imported preset').toString(), settings: data.settings };
        const i = list.findIndex((p) => p.name === name);
        if (i >= 0) list[i] = entry; else list.push(entry);
        imported++;
      } catch (e) { errors.push(`${path.basename(fp)}: ${e.message}`); }
    }
    if (imported) saveUser(list);
    return { ok: imported > 0, imported, errors, user: list };
  });

  ipcMain.handle('luma:presets-open-folder', async () => {
    try { await shell.showItemInFolder(USER_FILE()); return { ok: true }; }
    catch { try { await shell.openPath(app.getPath('userData')); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } }
  });
}

// Main-process lookup for the "starting look" feature (lumaLooksConfig.defaultPreset):
// user presets shadow built-ins of the same name, matching the list order the picker shows.
function findPresetByName(name) {
  if (!name) return null;
  const all = [...builtinPresets, ...loadUser()];
  return all.find((p) => valid(p) && p.name === name) || null;
}

module.exports = { registerLumaPresets, findPresetByName };
