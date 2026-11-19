import { createClient } from '@supabase/supabase-js';
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSpawnEnv,
  parseModels,
  cleanAnswer,
  buildTranscript,
  buildPrompt,
  tail,
} from './lib.js';

const WORKER_DIR = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(WORKER_DIR, 'sessions');
const LOG_FILE = join(WORKER_DIR, 'worker.log');
const DEFAULT_DEVIN =
  'C:\\Users\\HenriB\\AppData\\Local\\Programs\\Devin\\resources\\app\\extensions\\windsurf\\devin\\bin\\devin.exe';
const DEVIN_BIN = process.env.DEVIN_BIN || DEFAULT_DEVIN;
const POLL_MS = 1500;
const HEARTBEAT_MS = 10_000;
const MODEL_SYNC_MS = 6 * 60 * 60 * 1000;
const DEVIN_TIMEOUT_MS = 10 * 60 * 1000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const { SUPABASE_URL, SUPABASE_KEY, CHAT_EMAIL, CHAT_PASSWORD } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY || !CHAT_EMAIL || !CHAT_PASSWORD) {
  log('Fehlende Umgebungsvariablen (SUPABASE_URL/SUPABASE_KEY/CHAT_EMAIL/CHAT_PASSWORD) – Abbruch.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: true, persistSession: false },
});

async function signIn() {
  const { error } = await supabase.auth.signInWithPassword({
    email: CHAT_EMAIL,
    password: CHAT_PASSWORD,
  });
  if (error) throw new Error(`Login fehlgeschlagen: ${error.message}`);
  log('Angemeldet.');
}

function isAuthError(err) {
  const s = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
  return s.includes('jwt') || s.includes('401') || s.includes('pgrst301') || s.includes('auth');
}

// Run a supabase query; on auth/JWT failure sign in again once and retry.
async function db(fn) {
  let res = await fn();
  if (res.error && isAuthError(res.error)) {
    log('Auth-Fehler – melde neu an und wiederhole.');
    await signIn();
    res = await fn();
  }
  if (res.error) throw res.error;
  return res.data;
}

// ---------- keep-awake ----------

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

// ---------- devin ----------

function killTree(pid) {
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
}

function runDevin(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(DEVIN_BIN, args, {
      env: buildSpawnEnv(),
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, DEVIN_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

function devinArgs({ promptFile, cont, model }) {
  const args = ['-p', '--prompt-file', promptFile];
  if (cont) args.push('-c');
  args.push('--model', model, '--respect-workspace-trust', 'false');
  return args;
}

// ---------- model sync ----------

async function syncModels() {
  try {
    const r = await runDevin(['models'], WORKER_DIR);
    if (r.code !== 0) {
      log(`Modelsync: devin models exit ${r.code}: ${tail(r.err, 200)}`);
      return;
    }
    const models = parseModels(r.out);
    if (models.length === 0) {
      log('Modelsync: 0 Modelle geparst – behalte bestehende Zeilen.');
      return;
    }
    await db(() => supabase.from('models').upsert(models));
    const existing = await db(() => supabase.from('models').select('id'));
    const fresh = new Set(models.map((m) => m.id));
    const stale = (existing || []).map((r2) => r2.id).filter((id) => !fresh.has(id));
    if (stale.length) {
      await db(() => supabase.from('models').delete().in('id', stale));
    }
    const families = new Set(models.map((m) => m.family)).size;
    log(`Modelsync: ${models.length} Modelle in ${families} Familien.`);
  } catch (e) {
    log(`Modelsync Fehler: ${e.message}`);
  }
}

// ---------- heartbeat ----------

async function heartbeat() {
  try {
    await db(() =>
      supabase
        .from('worker_status')
        .upsert({ last_seen: new Date().toISOString(), hostname: hostname() }),
    );
  } catch (e) {
    log(`Heartbeat Fehler: ${e.message}`);
  }
}

// ---------- job processing ----------

async function resetRunning() {
  try {
    const rows = await db(() =>
      supabase.from('messages').update({ status: 'pending', updated_at: new Date().toISOString() }).eq('status', 'running').eq('role', 'assistant').select('id'),
    );
    if (rows?.length) log(`${rows.length} 'running'-Nachricht(en) zurück auf 'pending' gesetzt.`);
  } catch (e) {
    log(`Reset running Fehler: ${e.message}`);
  }
}

async function nextJob() {
  const rows = await db(() =>
    supabase
      .from('messages')
      .select('id, chat_id, model, created_at')
      .eq('role', 'assistant')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1),
  );
  return rows?.[0] || null;
}

async function claim(id) {
  const rows = await db(() =>
    supabase
      .from('messages')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id'),
  );
  return (rows?.length || 0) > 0;
}

async function finish(id, fields) {
  await db(() =>
    supabase
      .from('messages')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id),
  );
}

async function processJob(job) {
  const sessionDir = join(SESSIONS_DIR, job.chat_id);
  mkdirSync(sessionDir, { recursive: true });
  const marker = join(sessionDir, '.started');
  const promptFile = join(sessionDir, 'prompt.txt');

  // user text = latest role='user' message of the chat created before the placeholder
  const userRows = await db(() =>
    supabase
      .from('messages')
      .select('id, content, created_at')
      .eq('chat_id', job.chat_id)
      .eq('role', 'user')
      .lt('created_at', job.created_at)
      .order('created_at', { ascending: false })
      .limit(1),
  );
  const userMsg = userRows?.[0];
  if (!userMsg) {
    await finish(job.id, { status: 'error', error: 'Keine Nutzernachricht gefunden.' });
    return;
  }
  const userText = userMsg.content;

  // earlier done messages (before the triggering user message) for transcript fallback
  const history = await db(() =>
    supabase
      .from('messages')
      .select('role, content')
      .eq('chat_id', job.chat_id)
      .eq('status', 'done')
      .lt('created_at', userMsg.created_at)
      .order('created_at', { ascending: true }),
  );
  const prior = history || [];
  const hasHistory = prior.length > 0;
  const started = existsSync(marker);
  const cont = started; // -c only when this dir already has a session
  const mode = cont ? 'continue' : hasHistory ? 'fallback' : 'fresh';

  const model = job.model || 'swe-2-high';
  const prompt = buildPrompt(mode, userText, hasHistory ? buildTranscript(prior) : '');
  writeFileSync(promptFile, prompt, 'utf8');
  log(`Job ${job.id} chat=${job.chat_id} modus=${mode} modell=${model} text="${userText.slice(0, 60)}"`);

  let r = await runDevin(devinArgs({ promptFile, cont, model }), sessionDir);

  // -c failed -> retry once without -c, transcript prepended
  if (cont && !r.timedOut && r.code !== 0) {
    log(`-c Lauf fehlgeschlagen (exit ${r.code}) – retry ohne -c mit Transkript.`);
    const t = hasHistory ? buildTranscript(prior) : '';
    writeFileSync(promptFile, buildPrompt('fallback', userText, t), 'utf8');
    r = await runDevin(devinArgs({ promptFile, cont: false, model }), sessionDir);
  }

  if (r.timedOut) {
    await finish(job.id, { status: 'error', error: 'Zeitüberschreitung' });
    log(`Job ${job.id} Timeout.`);
    return;
  }

  const answer = cleanAnswer(r.out, r.err);
  if (r.code !== 0 || !answer) {
    const errMsg = tail(r.err, 500) || `devin exit ${r.code}, leere Antwort`;
    await finish(job.id, { status: 'error', error: errMsg });
    log(`Job ${job.id} Fehler: ${errMsg.slice(0, 120)}`);
    return;
  }

  await finish(job.id, { content: answer, status: 'done' });
  if (!started) writeFileSync(marker, new Date().toISOString());
  log(`Job ${job.id} fertig (${answer.length} Zeichen).`);
}

// ---------- main ----------

async function main() {
  await signIn();
  startKeepAwake();
  await resetRunning();
  await syncModels();
  await heartbeat();
  setInterval(() => heartbeat().catch((e) => log(`Heartbeat: ${e.message}`)), HEARTBEAT_MS);
  setInterval(() => syncModels().catch((e) => log(`Modelsync: ${e.message}`)), MODEL_SYNC_MS);
  log('Worker läuft – warte auf Nachrichten.');

  for (;;) {
    try {
      const job = await nextJob();
      if (job && (await claim(job.id))) {
        await processJob(job);
      } else {
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      log(`Loop Fehler: ${e.message}`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

function shutdown() {
  stopKeepAwake();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', stopKeepAwake);

main().catch((e) => {
  log(`Fatal: ${e.message}`);
  stopKeepAwake();
  process.exit(1);
});
