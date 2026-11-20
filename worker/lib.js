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
