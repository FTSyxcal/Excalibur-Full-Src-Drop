'use strict';
// Mirror Gorilla Tag's MINIMIZE state onto the Luma controller window (owner: "if Gorilla Tag is
// minimized the window is minimized too"). Electron can't parent to a foreign Win32 window, so instead
// we watch GT's real window state: a single long-lived PowerShell process polls IsIconic on GT's main
// window and prints ONLY on a state change (MIN / NORM / GONE). We key off GT's changes — never the
// controller's own — so clicking the controller (which doesn't change GT's state) never minimises it.
//
// One child process for the whole watch (not one spawn per poll), cleaned up when the window closes.

const { spawn } = require('child_process');

// PowerShell: define IsIconic once, then loop. Emits a line only when GT's state transitions, so the
// Node side acts on edges, not every tick. 400ms is responsive without being busy.
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LumaWin { [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd); }
"@
$last = ''
while ($true) {
  $p = Get-Process 'Gorilla Tag' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { if ([LumaWin]::IsIconic($p.MainWindowHandle)) { $state = 'MIN' } else { $state = 'NORM' } }
  else    { $state = 'GONE' }
  if ($state -ne $last) { $last = $state; Write-Output $state; [Console]::Out.Flush() }
  Start-Sleep -Milliseconds 400
}
`;

let child = null;

// onChange receives 'MIN' | 'NORM' | 'GONE' each time GT's window state transitions.
function startMinimizeWatch(onChange) {
  if (child) return;
  if (process.platform !== 'win32') return;    // Win32-only; no-op elsewhere
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { child = null; return; }
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'MIN' || line === 'NORM' || line === 'GONE') {
        try { onChange(line); } catch { /* window gone */ }
      }
    }
  });
  child.on('error', () => { child = null; });
  child.on('close', () => { child = null; });
}

function stopMinimizeWatch() {
  if (child) { try { child.kill(); } catch { /* already dead */ } child = null; }
}

module.exports = { startMinimizeWatch, stopMinimizeWatch };
