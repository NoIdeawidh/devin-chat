import { createClient } from '@supabase/supabase-js';
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSpawnEnv,
  parseModels,
  cleanAnswer,
  buildTranscript,
  buildPrompt,
  buildSyncPrompt,
  isLockedError,
  newestSession,
  newSessionId,
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

function devinArgs({ promptFile, resumeId, model }) {
  const args = ['-p', '--prompt-file', promptFile];
  if (resumeId) args.push('-r', resumeId);
  args.push('--model', model, '--respect-workspace-trust', 'false');
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ONEOFF_DIR = join(SESSIONS_DIR, '_oneoff');

// devin list --format json for a directory -> array or null
async function listSessions(cwd) {
  const r = await runDevin(['list', '--format', 'json'], cwd);
  if (r.code !== 0) {
    log(`devin list in ${cwd} exit ${r.code}: ${tail(r.err, 200)}`);
    return null;
  }
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

function readSessionFile(sessionDir) {
  try {
    return JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeSessionFile(sessionDir, meta) {
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(meta));
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
    // PostgREST caps a select at 1000 rows -> page until a short page.
    const existing = [];
    for (let from = 0; ; from += 1000) {
      const page = await db(() => supabase.from('models').select('id').order('sort').range(from, from + 999));
      existing.push(...page);
      if (page.length < 1000) break;
    }
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

// Fresh run in the chat dir: identifies the created session via list-diff and
// stores it in session.json. Returns { r, mode }.
async function runFresh(sessionDir, promptFile, userText, transcript, model, logMode) {
  const mode = logMode || (transcript ? 'fallback' : 'fresh');
  const beforeIds = new Set(((await listSessions(sessionDir)) || []).map((s) => s.id));
  writeFileSync(promptFile, buildPrompt(transcript ? 'fallback' : 'fresh', userText, transcript), 'utf8');
  log(`modus=${mode}`);
  const r = await runDevin(devinArgs({ promptFile, model }), sessionDir);
  if (!r.timedOut) {
    const after = await listSessions(sessionDir);
    const sid = newSessionId(beforeIds, after);
    if (sid) {
      writeSessionFile(sessionDir, { id: sid, missedSince: null });
      log(`Sitzung ${sid} in session.json gespeichert.`);
    } else {
      log('Keine neue Sitzung gefunden – session.json nicht geschrieben.');
    }
  }
  return { r, mode };
}

// One-off run in _oneoff for a locked session; deletes exactly the session it
// created afterwards.
async function runOneoff(userText, transcript, model) {
  mkdirSync(ONEOFF_DIR, { recursive: true });
  const beforeIds = new Set(((await listSessions(ONEOFF_DIR)) || []).map((s) => s.id));
  const pf = join(ONEOFF_DIR, 'prompt.txt');
  writeFileSync(pf, buildPrompt('fallback', userText, transcript), 'utf8');
  const r = await runDevin(devinArgs({ promptFile: pf, model }), ONEOFF_DIR);
  const created = ((await listSessions(ONEOFF_DIR)) || [])
    .filter((s) => !beforeIds.has(s.id))
    .map((s) => s.id);
  for (const id of created) {
    const rr = await runDevin(['rm', id, '--force'], ONEOFF_DIR);
    if (rr.code !== 0) log(`devin rm ${id} fehlgeschlagen: ${tail(rr.err, 200)}`);
    else log(`One-off-Sitzung ${id} gelöscht.`);
  }
  if (!created.length) log('One-off: keine neue Sitzung gefunden, nichts zu löschen.');
  return r;
}

async function processJob(job) {
  const sessionDir = join(SESSIONS_DIR, job.chat_id);
  mkdirSync(sessionDir, { recursive: true });
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
      .select('role, content, created_at')
      .eq('chat_id', job.chat_id)
      .eq('status', 'done')
      .lt('created_at', userMsg.created_at)
      .order('created_at', { ascending: true }),
  );
  const prior = history || [];
  const transcript = prior.length ? buildTranscript(prior) : '';

  const model = job.model || 'swe-2-high';
  let meta = readSessionFile(sessionDir);

  // Migration: .started-Marker -> neueste Sitzung des Ordners übernehmen
  if (!meta && existsSync(join(sessionDir, '.started'))) {
    const newest = newestSession(await listSessions(sessionDir));
    if (newest) {
      meta = { id: newest.id, missedSince: null };
      writeSessionFile(sessionDir, meta);
      log(`Migration: Sitzung ${newest.id} für chat ${job.chat_id} übernommen.`);
    }
    try {
      unlinkSync(join(sessionDir, '.started'));
    } catch {}
  }

  let r;
  let mode;
  if (meta?.id) {
    mode = meta.missedSince ? 'resume+sync' : 'resume';
    const prompt = meta.missedSince
      ? buildSyncPrompt(
          buildTranscript(prior.filter((m) => m.created_at >= meta.missedSince)),
          userText,
        )
      : userText;
    writeFileSync(promptFile, prompt, 'utf8');
    log(`Job ${job.id} chat=${job.chat_id} modus=${mode} sitzung=${meta.id} modell=${model} text="${userText.slice(0, 60)}"`);
    for (let attempt = 1; ; attempt++) {
      r = await runDevin(devinArgs({ promptFile, resumeId: meta.id, model }), sessionDir);
      if (r.timedOut || r.code === 0 || !isLockedError(r.err)) break;
      log(`Sitzung ${meta.id} gesperrt (Versuch ${attempt}/3).`);
      if (attempt >= 3) break;
      await sleep(5000);
    }
    if (!r.timedOut && r.code !== 0) {
      if (isLockedError(r.err)) {
        mode = 'oneoff';
        log(`Sitzung ${meta.id} bleibt gesperrt – one-off-Lauf (modus=oneoff).`);
        r = await runOneoff(userText, transcript, model);
        if (!meta.missedSince) meta.missedSince = userMsg.created_at;
        writeSessionFile(sessionDir, meta);
      } else {
        log(`-r ${meta.id} fehlgeschlagen (kein Lock): ${tail(r.err, 200)} – neue Sitzung.`);
        try {
          unlinkSync(join(sessionDir, 'session.json'));
        } catch {}
        meta = null;
        ({ r, mode } = await runFresh(sessionDir, promptFile, userText, transcript, model, 'recreate'));
      }
    }
  } else {
    log(`Job ${job.id} chat=${job.chat_id} modell=${model} text="${userText.slice(0, 60)}"`);
    ({ r, mode } = await runFresh(sessionDir, promptFile, userText, transcript, model));
  }

  if (r.timedOut) {
    await finish(job.id, { status: 'error', error: 'Zeitüberschreitung' });
    log(`Job ${job.id} Timeout.`);
    return;
  }

  const answer = cleanAnswer(r.out);
  if (r.code !== 0 || !answer) {
    const errMsg = tail(r.err, 500) || `devin exit ${r.code}, leere Antwort`;
    await finish(job.id, { status: 'error', error: errMsg });
    log(`Job ${job.id} Fehler (modus=${mode}): ${errMsg.slice(0, 120)}`);
    return;
  }

  await finish(job.id, { content: answer, status: 'done' });
  if (meta?.id && meta.missedSince && mode !== 'oneoff') {
    meta.missedSince = null;
    writeSessionFile(sessionDir, meta);
  }
  log(`Job ${job.id} fertig (modus=${mode}, ${answer.length} Zeichen).`);
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
