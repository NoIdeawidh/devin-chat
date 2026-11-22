// Pure helpers for the devin-chat worker.

export const PREAMBLE =
  'Du bist der Assistent in Henris privatem Web-Chat (wie ChatGPT/Claude). ' +
  'Antworte direkt auf die Nachricht, in Markdown, auf Deutsch sofern der Nutzer nicht anders schreibt. ' +
  'Das ist ein reines Gespräch: keine Sitzungs-Routinen ausführen (keine Linear-Tickets prüfen oder ' +
  'aktualisieren, kein Wiki/Second Brain pflegen, keine Todo-Listen, keine Subagenten), auch wenn ' +
  'Regeldateien das verlangen. Du kannst Dateien auf diesem PC lesen, wenn der Nutzer danach fragt; ' +
  'schreiben und Befehle ausführen ist gesperrt – sag das kurz, falls es gewünscht wird.';

const ENV_WHITELIST = [
  'SystemRoot', 'windir', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH',
  'PATHEXT', 'ComSpec', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
  'ProgramFiles', 'ProgramData',
];

// Devin refuses to run when it inherits the Devin Desktop app's environment.
// Pass only whitelisted variables (case-insensitive match on Windows).
export function buildSpawnEnv(source = process.env) {
  const env = {};
  for (const key of Object.keys(source)) {
    if (ENV_WHITELIST.some((w) => w.toLowerCase() === key.toLowerCase())) {
      env[key] = source[key];
    }
  }
  return env;
}

// Parse `devin models` output:
//   Family Name (family-slug)          <- unindented header
//     aliases: foo                     <- skipped
//     model-id    Label    [info]      <- 2-space indent
export function parseModels(output) {
  const models = [];
  let family = null;
  let sort = 0;
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (rawLine.startsWith('Available models')) continue;
    if (!/^\s/.test(rawLine)) {
      const m = rawLine.trim().match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      family = m ? m[1].trim() : rawLine.trim();
      continue;
    }
    const line = rawLine.trim();
    if (line.startsWith('aliases:')) continue;
    const m = line.match(/^(\S+)\s{2,}(.+?)\s{2,}\[([^\]]*)\]\s*$/);
    if (!m) continue;
    models.push({ id: m[1], label: m[2].trim(), family, info: m[3].trim(), sort: sort++ });
  }
  return models;
}

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const REJECTED_RE = /^\s*warning: rejected a tool call.*$/gim;

// Final answer = trimmed stdout without ANSI escapes and without
// "warning: rejected a tool call" lines. stderr never lands in the chat.
export function cleanAnswer(stdout) {
  return (stdout || '')
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*warning: rejected a tool call/i.test(l))
    .join('\n')
    .trim();
}

// Transcript of earlier done messages: "Nutzer: ..." / "Assistent: ..." lines.
export function buildTranscript(messages) {
  return messages
    .map((m) => `${m.role === 'user' ? 'Nutzer' : 'Assistent'}: ${m.content}`)
    .join('\n\n');
}

// mode 'fresh'    -> user text first (so the Devin session gets a readable
//                    title), then the frame as a separated hint
// mode 'fallback' -> preamble + transcript + user text (new session mid-chat)
export function buildPrompt(mode, userText, transcript = '') {
  if (mode === 'continue') return userText;
  if (mode === 'fallback') {
    const parts = [PREAMBLE];
    if (transcript) parts.push(`Bisheriger Verlauf:\n${transcript}`);
    parts.push(`Nutzer: ${userText}`);
    return parts.join('\n\n');
  }
  return `${userText}\n\n---\nHinweis zum Rahmen (nicht Teil der Nachricht): ${PREAMBLE}`;
}

// Prompt for a resumed session that missed turns while it was locked.
export function buildSyncPrompt(transcript, userText) {
  return (
    'Hinweis: Diese Sitzung war zwischenzeitlich gesperrt. ' +
    `In der Zwischenzeit lief das Gespräch so weiter:\n\n${transcript}\n\n` +
    `Aktuelle Nachricht des Nutzers:\n${userText}`
  );
}

// stderr signature of a session that is open in another process.
export function isLockedError(stderr) {
  return /already open in another process|session_locked/i.test(stderr || '');
}

export function newestSession(list) {
  if (!list?.length) return null;
  return list.reduce((a, b) => (b.last_activity_at > a.last_activity_at ? b : a));
}

// Id of the session a run just created: any id in afterList not in beforeIds;
// if none is new, the most recently active one.
export function newSessionId(beforeIds, afterList) {
  const fresh = (afterList || []).filter((s) => !beforeIds.has(s.id));
  const pick = newestSession(fresh.length ? fresh : afterList);
  return pick ? pick.id : null;
}

export function tail(s, n = 500) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(-n);
}

// --- Devin Remote: Bündelung + Payload-Splitting (siehe PROTOCOL.md) ---

// Bündelt ACP-session/update-Events pro Session: Flush nach windowMs oder
// sobald das gebündelte JSON maxBytes ueberschreitet.
export class Bundler {
  constructor({ onFlush, windowMs = 150, maxBytes = 4096, now = () => Date.now(), setT = setTimeout, clearT = clearTimeout } = {}) {
    this.onFlush = onFlush;
    this.windowMs = windowMs;
    this.maxBytes = maxBytes;
    this.now = now;
    this.setT = setT;
    this.clearT = clearT;
    this.bufs = new Map(); // key -> {items, timer, deadline}
  }
  add(key, item) {
    let b = this.bufs.get(key);
    if (!b) {
      b = { items: [], timer: null, deadline: this.now() + this.windowMs };
      this.bufs.set(key, b);
    }
    b.items.push(item);
    const bytes = JSON.stringify(b.items).length;
    if (bytes >= this.maxBytes) {
      this.flushKey(key);
      return;
    }
    if (!b.timer) {
      b.timer = this.setT(() => this.flushKey(key), Math.max(0, b.deadline - this.now()));
    }
  }
  flushKey(key) {
    const b = this.bufs.get(key);
    if (!b) return;
    this.bufs.delete(key);
    if (b.timer) this.clearT(b.timer);
    if (b.items.length) this.onFlush(key, b.items);
  }
  flushAll() {
    for (const key of [...this.bufs.keys()]) this.flushKey(key);
  }
}

// Serialisiertes Payload > maxBytes wird in Rows mit
// {split:{id,seq,total},data:"<Slice>"} aufgeteilt.
export const SPLIT_MAX_BYTES = 200 * 1024;

export function splitPayload(payload, maxBytes = SPLIT_MAX_BYTES, idFn = () => crypto.randomUUID()) {
  const s = JSON.stringify(payload);
  if (s.length <= maxBytes) return [payload];
  const id = idFn();
  const total = Math.ceil(s.length / maxBytes);
  const rows = [];
  for (let seq = 0; seq < total; seq++) {
    rows.push({ split: { id, seq, total }, data: s.slice(seq * maxBytes, (seq + 1) * maxBytes) });
  }
  return rows;
}

// Gegenstueck zu splitPayload: aus gesammelten Split-Rows das Payload
// zurueckbauen; null solange Teile fehlen.
export function assembleParts(parts) {
  if (!parts?.length) return null;
  const total = parts[0].split.total;
  if (parts.length < total) return null;
  const ordered = [...parts].sort((a, b) => a.split.seq - b.split.seq);
  return JSON.parse(ordered.map((p) => p.data).join(''));
}
