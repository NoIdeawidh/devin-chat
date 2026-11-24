import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from './acp.js';
import { Bridge } from './bridge.js';
import { SupaStore } from './store.js';
import { WORKER_DIR, WORKER_LOG } from './paths.js';

const LOG_FILE = WORKER_LOG;
const POLL_MS = 1000;
const HEARTBEAT_MS = 30 * 1000;
const CLEANUP_MS = 60 * 60 * 1000;
const ACP_RESTART_MS = 15 * 1000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const { SUPABASE_URL, SUPABASE_KEY, BRIDGE_EMAIL, BRIDGE_PASSWORD, OWNER_ID } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY || !BRIDGE_EMAIL || !BRIDGE_PASSWORD || !OWNER_ID) {
  log('Fehlende Umgebungsvariablen (SUPABASE_URL/SUPABASE_KEY/BRIDGE_EMAIL/BRIDGE_PASSWORD/OWNER_ID) – Abbruch.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: true, persistSession: false },
});
const store = new SupaStore(supabase, { email: BRIDGE_EMAIL, password: BRIDGE_PASSWORD, ownerId: OWNER_ID, log });

let keepAwake = null;
function startKeepAwake() {
  const ps =
    '$sig = \'[System.Runtime.InteropServices.DllImport("kernel32.dll")] ' +
    'public static extern uint SetThreadExecutionState(uint esFlags);\'; ' +
    '$t = Add-Type -MemberDefinition $sig -Name K32 -Namespace W -PassThru; ' +
    'while ($true) { $t::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 30 }';
  keepAwake = spawn(
    'powershell',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
    { windowsHide: true, stdio: 'ignore' },
  );
  keepAwake.on('error', (e) => log(`Keep-awake Fehler: ${e.message}`));
  log(`Keep-awake gestartet (PID ${keepAwake.pid}).`);
}
function stopKeepAwake() {
  if (keepAwake && !keepAwake.killed) {
    try {
      keepAwake.kill();
    } catch {}
  }
}
process.on('exit', stopKeepAwake);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const acp = new AcpClient({ cwd: WORKER_DIR, log });
const bridge = new Bridge({ store, acp, ownerId: OWNER_ID, log });

acp.on('exit', () => {
  setTimeout(async () => {
    if (acp.stopped) return;
    log('acp Neustart …');
    try {
      await acp.start();
      bridge.heartbeat();
    } catch (e) {
      log(`acp Neustart fehlgeschlagen: ${e.message}`);
    }
  }, ACP_RESTART_MS);
});

async function main() {
  await store.signIn();
  try {
    await acp.start();
  } catch (e) {
    log(`acp Start fehlgeschlagen: ${e.message} – Bridge laeuft weiter und versucht Neustart.`);
  }
  startKeepAwake();
  await bridge.heartbeat();
  await bridge.cleanup();
  // Tick-Schleife mit Overlap-Guard + exponentiellem Backoff bei Poll-Fehlern
  // (Ausfaelle erzeugen sonst Tausende Logzeilen/Requests pro Stunde).
  let tickBusy = false;
  let pollFails = 0;
  let tickDelay = POLL_MS;
  const tickLoop = async () => {
    if (!tickBusy) {
      tickBusy = true;
      let ok = false;
      try {
        ok = await bridge.tick();
      } catch {
        ok = false;
      }
      tickBusy = false;
      if (!ok) {
        pollFails++;
        if (pollFails === 1) log('rpc poll fehlgeschlagen – Backoff aktiv.');
        tickDelay = Math.min(30000, POLL_MS * 2 ** Math.min(pollFails, 5));
      } else {
        if (pollFails) log(`rpc poll wieder ok (nach ${pollFails} Fehlversuchen).`);
        pollFails = 0;
        tickDelay = POLL_MS;
      }
    }
    setTimeout(tickLoop, tickDelay);
  };
  tickLoop();
  setInterval(() => bridge.heartbeat(), HEARTBEAT_MS);
  setInterval(() => bridge.cleanup(), CLEANUP_MS);
  log('Bridge läuft – warte auf RPC.');
}

main().catch((e) => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
