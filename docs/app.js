import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@18.1.3/+esm';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.17/+esm';
import { applyMsgOp } from './apply.js';

const MOCK = new URLSearchParams(location.search).has('mock');
const SUPABASE_URL = 'https://iazsajsohlwrkijasrvx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_NEUmXrKjpChsMwa810ojcQ_OpSiaoMm';
const OWNER_ID = 'fd898a7a-bda3-45d4-a3d2-b7ed9990e591';
const LOGIN_EMAIL = 'henri@devin-chat.local';
const RPC_POLL_MS = 800;
const RPC_TIMEOUT_MS = 30 * 60 * 1000;
const EVENTS_POLL_MS = 1200;
const STATUS_POLL_MS = 15000;
const ONLINE_GRACE_MS = 60 * 1000;
const OPEN_LIMIT = 20;
const HISTORY_LIMIT = 30;
const IDB_MAX_ENTRIES = 600;

marked.setOptions({ breaks: true });
const md = (s) => DOMPurify.sanitize(marked.parse(s || ''));
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeAgo = (iso) => {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60e3) return 'gerade';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} Min.`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} Std.`;
  return `${Math.floor(d / 86400e3)} T.`;
};
const shortCwd = (cwd) => (cwd || '').replace(/\\/g, '/').replace(/^C:\/Users\/[^/]+\/?/, '~/');

// FNV-1a 32bit ueber "role|text|n" – identisch zu worker/transcript.js entryHash.
const msgHash = (e) => {
  const s = `${e.role}|${e.text ?? ''}|${e.n ?? ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

// ================= Transport =================

class SupaTransport {
  constructor() {
    this.sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: true, persistSession: true },
    });
  }
  session() { return this.sb.auth.getSession(); }
  onAuth(cb) { return this.sb.auth.onAuthStateChange(cb); }
  login(email, password) { return this.sb.auth.signInWithPassword({ email, password }); }
  logout() { return this.sb.auth.signOut(); }
  aal() { return this.sb.auth.mfa.getAuthenticatorAssuranceLevel(); }
  listFactors() { return this.sb.auth.mfa.listFactors(); }
  enroll() { return this.sb.auth.mfa.enroll({ factorType: 'totp' }); }
  unenroll(id) { return this.sb.auth.mfa.unenroll({ factorId: id }); }
  verify(factorId, code) { return this.sb.auth.mfa.challengeAndVerify({ factorId, code }); }

  async rpc(method, params = {}) {
    const ins = await this.sb.from('rpc').insert({ method, params }).select('id').single();
    if (ins.error) throw new Error(ins.error.message);
    const id = ins.data.id;
    const t0 = Date.now();
    for (;;) {
      const r = await this.sb.from('rpc').select('status,result,error').eq('id', id).single();
      if (r.error) throw new Error(r.error.message);
      if (r.data.status === 'done') return r.data.result;
      if (r.data.status === 'error') throw Object.assign(new Error(r.data.error?.message || 'RPC Fehler'), { rpcError: r.data.error });
      if (Date.now() - t0 > RPC_TIMEOUT_MS) throw new Error('Zeitüberschreitung – Bridge antwortet nicht.');
      await sleep(RPC_POLL_MS);
    }
  }
  // Nur live-Events der aktuellen Sitzung + request/bridge/notification aller
  // (Permission-Dialogs auch fuer andere Sitzungen sichtbar).
  async pollEvents(lastId, sid) {
    let q = this.sb.from('events').select('id,session_id,kind,payload,created_at').gt('id', lastId).order('id').limit(500);
    if (sid) q = q.or(`session_id.eq.${sid},kind.eq.request,kind.eq.bridge,kind.eq.notification`);
    else q = q.in('kind', ['request', 'bridge', 'notification']);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return r.data;
  }
  async latestEventId() {
    const r = await this.sb.from('events').select('id').order('id', { ascending: false }).limit(1);
    if (r.error) throw new Error(r.error.message);
    return r.data[0]?.id || 0;
  }
  async bridgeStatus() {
    const r = await this.sb.from('bridge_status').select('*').eq('owner', OWNER_ID).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    return r.data;
  }
}

class MockTransport {
  constructor(fixture) {
    this.f = fixture;
    this.ev = [];
    this.evId = 1;
    this.running = {};
    this.currentMode = {};
    this.cfg = JSON.parse(JSON.stringify(fixture.defaultConfigOptions.configOptions));
    this.caches = new Map(); // sid -> entries (wie Bridge-SessionCache, vereinfacht)
    this.pushEv = (session_id, kind, payload) =>
      this.ev.push({ id: this.evId++, session_id, kind, payload, created_at: new Date().toISOString() });
  }
  async login(e, p) { if (!p) return { error: { message: 'Passwort fehlt' } }; return { data: { session: { user: { id: 'mock' } } }, error: null }; }
  async session() { return { data: { session: null }, error: null }; }
  onAuth() { return { data: { subscription: { unsubscribe() {} } } }; }
  logout() {}
  async aal() { return { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }; }
  async listFactors() { return { data: { totp: [{ id: 'mock-factor', status: 'verified' }] } }; }
  async enroll() {
    return {
      data: { id: 'mock-factor', totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#fff"/><rect x="10" y="10" width="30" height="30"/><rect x="80" y="10" width="30" height="30"/><rect x="10" y="80" width="30" height="30"/><rect x="50" y="50" width="20" height="20"/></svg>', secret: 'MOCKSECRET2345' } },
      error: null,
    };
  }
  async verify() { return { data: {}, error: null }; }
  unenroll() {}
  async bridgeStatus() {
    return { last_seen: new Date().toISOString(), hostname: 'DESKTOP-MOCK', daemon_ok: true, version: '1.1.0' };
  }
  async pollEvents(lastId, sid) {
    return this.ev.filter((e) => e.id > lastId && (sid ? e.session_id === sid || ['request', 'bridge', 'notification'].includes(e.kind) : ['request', 'bridge', 'notification'].includes(e.kind)));
  }
  async latestEventId() { return 0; }

  _live(sid, ops) { this.pushEv(sid, 'live', { ops }); }

  // Mini-SessionCache: raw replay-updates -> kompakte Entries (wie transcript.js)
  _buildEntries(sid) {
    const entries = [];
    // Synthetische Vorgeschichte, damit History-Paging im Mock sichtbar ist.
    for (let k = 0; k < 30; k++) {
      entries.push({ i: entries.length, role: 'user', text: `Ältere Frage ${k + 1}` });
      entries.push({ i: entries.length, role: 'agent', text: `Antwort ${k + 1}: **Markdown** mit \`Code\`.` });
    }
    let stepsSinceUser = 0;
    for (const u of this.f.replay) {
      const upd = u.update || {};
      const last = entries.at(-1);
      switch (upd.sessionUpdate) {
        case 'user_message_chunk':
        case 'agent_message_chunk': {
          const role = upd.sessionUpdate.startsWith('user') ? 'user' : 'agent';
          if (role === 'user') stepsSinceUser = 0;
          const t = upd.content?.text || '';
          if (last?.role === role) last.text += t;
          else entries.push({ i: entries.length, role, text: t });
          break;
        }
        case 'agent_thought_chunk': {
          const t = upd.content?.text || '';
          if (last?.role === 'thought') last.text += t;
          else entries.push({ i: entries.length, role: 'thought', text: t });
          break;
        }
        case 'tool_call': {
          stepsSinceUser++;
          const title = upd.title || upd.kind || 'Werkzeug';
          if (last?.role === 'steps') { last.n++; last.titles.push(title); }
          else entries.push({ i: entries.length, role: 'steps', n: 1, titles: [title] });
          break;
        }
      }
    }
    return { entries, stepsSinceUser };
  }

  async rpc(method, p = {}) {
    await sleep(80);
    const F = this.f;
    switch (method) {
      case '_bridge/ping': return { pong: true, version: '1.1.0', hostname: 'DESKTOP-MOCK', daemon_ok: true };
      case '_bridge/session/list': {
        let s = F.sessions;
        if (p.cwd) s = s.filter((x) => x.cwd === p.cwd);
        if (p.query) s = s.filter((x) => x.title.toLowerCase().includes(p.query.toLowerCase()));
        return { sessions: s };
      }
      case '_bridge/session/new': {
        const r = JSON.parse(JSON.stringify(F.newResult));
        r.sessionId = 'mock-' + Math.random().toString(36).slice(2, 8);
        F.sessions.push({ sessionId: r.sessionId, cwd: p.cwd || 'C:\\Users\\HenriB\\Projekte', title: 'Neue Sitzung', updatedAt: new Date().toISOString(), _meta: { 'cognition.ai/isLocked': false } });
        this.caches.set(r.sessionId, { entries: [], stepsSinceUser: 0 });
        return r;
      }
      case '_bridge/session/open': {
        const sid = p.sessionId;
        const meta = F.sessions.find((s) => s.sessionId === sid);
        if (meta?._meta?.['cognition.ai/isLocked']) throw Object.assign(new Error('Session is already open in another process'), { rpcError: { code: -32000, message: 'already open in another process' } });
        if (!this.caches.has(sid)) this.caches.set(sid, this._buildEntries(sid));
        const c = this.caches.get(sid);
        const detail = !!p.detail;
        const view = c.entries.filter((e) => detail || e.role !== 'thought').map((e) => (e.role === 'steps' && !detail ? { i: e.i, role: 'steps', n: e.n } : { ...e }));
        const limit = Math.max(1, p.limit || 20);
        let messages, reset = true;
        const lastE = c.entries[p.since?.count - 1];
        if (!p.force && p.since && lastE && msgHash(lastE) === p.since.hash) {
          reset = false;
          messages = view.filter((e) => e.i >= p.since.count - 1);
        } else {
          messages = view.slice(-limit);
        }
        return {
          sessionId: sid,
          modes: F.newResult.modes,
          configOptions: this.cfg,
          usage: { used: 42310, size: 262144 },
          commands: F.newResult.commands || [],
          title: meta?.title || sid,
          running: !!this.running[sid],
          status: { steps: c.stepsSinceUser, plan: 'Sitzung analysieren' },
          meta: meta?._meta || {},
          total: c.entries.length,
          reset,
          messages,
        };
      }
      case '_bridge/session/history': {
        const c = this.caches.get(p.sessionId) || { entries: [] };
        const view = c.entries.filter((e) => p.detail || e.role !== 'thought').filter((e) => e.i < (p.before ?? 1e9));
        const slice = view.slice(-(p.limit || 30));
        return { messages: slice, hasMore: view.length > slice.length };
      }
      case '_bridge/session/unwatch': return {};
      case '_bridge/session/load': {
        const r = JSON.parse(JSON.stringify(F.newResult));
        r.sessionId = p.sessionId;
        return r;
      }
      case '_bridge/fs/list': {
        if (!p.path) return { path: null, parent: null, dirs: ['C:\\Users\\HenriB', 'C:\\Users\\HenriB\\Desktop', 'C:\\Users\\HenriB\\Projekte', 'C:\\'], truncated: false };
        const map = {
          'C:\\Users\\HenriB': ['.hidden', 'Projekte', 'Desktop', 'Dokumente', 'devin-chat', 'System Volume Information'],
          'C:\\Users\\HenriB\\Projekte': ['devin-chat', 'niche-factory'],
        };
        const dirs = (map[p.path] || ['Ordner A', 'Ordner B']).filter((d) => !d.startsWith('.') && !d.startsWith('$') && d !== 'System Volume Information');
        return { path: p.path, parent: p.path.replace(/\\[^\\]+$/, '') || null, dirs, truncated: false };
      }
      case '_bridge/session/prompt': {
        const sid = p.sessionId;
        const text = (p.prompt || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        const c = this.caches.get(sid) || this.caches.set(sid, { entries: [], stepsSinceUser: 0 }).get(sid);
        const pushE = (e) => { e.i = c.entries.length; c.entries.push(e); return e; };
        pushE({ role: 'user', text });
        this._live(sid, [{ type: 'msg', i: c.entries.length - 1, role: 'user', at: 0, append: text }, { type: 'status', running: true, steps: 0, plan: null }]);
        this.running[sid] = true;
        let delay = 300;
        const chunks = ['Antwort: ', 'ich habe ', 'die Datei ', 'gelesen.'];
        if (/permission|tool|datei|lies|schreib/i.test(text)) {
          const rpcId = 'mock-req-' + this.evId;
          setTimeout(() => {
            const se = pushE({ role: 'steps', n: 1, titles: ['Datei lesen'] });
            c.stepsSinceUser++;
            this._live(sid, [{ type: 'msg', i: se.i, role: 'steps', n: 1, titles: ['Datei lesen'] }, { type: 'status', running: true, steps: 1, plan: null }]);
            this.pushEv(sid, 'request', { rpcId, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'tc1', title: 'Datei lesen' }, options: [{ optionId: 'allow', name: 'Erlauben' }, { optionId: 'always', name: 'Immer erlauben' }, { optionId: 'deny', name: 'Ablehnen' }] } });
          }, delay);
          delay += 600;
        }
        for (const [k, ck] of chunks.entries()) {
          setTimeout(() => {
            if (!this.running[sid]) return;
            const last = c.entries.at(-1);
            let i, at;
            if (last?.role === 'agent') { at = last.text.length; last.text += ck; i = last.i; }
            else { const e = pushE({ role: 'agent', text: ck }); i = e.i; at = 0; }
            this._live(sid, [{ type: 'msg', i, role: 'agent', at, append: ck }]);
          }, delay + k * 250);
        }
        setTimeout(() => {
          if (!this.running[sid]) return;
          this._live(sid, [{ type: 'usage', used: 43000, size: 262144 }, { type: 'status', running: false, steps: c.stepsSinceUser, plan: null }]);
          this.running[sid] = false;
        }, delay + chunks.length * 250);
        await sleep(delay + chunks.length * 250 + 50);
        return { stopReason: this.running[sid] ? 'end_turn' : 'cancelled', usage: { totalTokens: 12345 } };
      }
      case '_bridge/session/cancel':
        this.running[p.sessionId] = false;
        this._live(p.sessionId, [{ type: 'status', running: false, steps: 0, plan: null }]);
        return { cancelled: true };
      case '_bridge/session/set_mode':
        this.currentMode[p.sessionId] = p.modeId;
        this._live(p.sessionId, [{ type: 'mode', currentModeId: p.modeId }]);
        return {};
      case '_bridge/session/set_config_option': {
        const o = this.cfg.find((x) => x.id === p.configId);
        if (o) o.currentValue = p.value;
        this._live(p.sessionId, [{ type: 'config', configOptions: this.cfg }]);
        return { configOptions: this.cfg };
      }
      case '_bridge/session/defaultConfigOptions': return { configOptions: this.cfg };
      case '_bridge/session/rename': {
        const s = F.sessions.find((x) => x.sessionId === p.sessionId);
        if (s) s.title = p.title;
        return {};
      }
      case '_bridge/session/delete': {
        F.sessions = F.sessions.filter((x) => x.sessionId !== p.sessionId);
        this.caches.delete(p.sessionId);
        return {};
      }
      case '_bridge/session/close': return {};
      case '_bridge/respond': {
        this.pushEv(p.sessionId || null, 'bridge', { type: 'request_answered', rpcId: p.rpcId });
        return {};
      }
      default: throw new Error(`mock: unbekannte Methode ${method}`);
    }
  }
}

// ================= IndexedDB-Cache =================

const idb = {
  _db: null,
  db() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('devin-remote', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('sessions');
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(sid) {
    try {
      const db = await this.db();
      return await new Promise((res) => {
        const q = db.transaction('sessions').objectStore('sessions').get(sid);
        q.onsuccess = () => res(q.result || null);
        q.onerror = () => res(null);
      });
    } catch { return null; }
  },
  async put(sid, obj) {
    try {
      const db = await this.db();
      await new Promise((res) => {
        const t = db.transaction('sessions', 'readwrite');
        t.objectStore('sessions').put(obj, sid);
        t.oncomplete = res; t.onerror = res;
      });
    } catch {}
  },
};

function saveSession(s) {
  idb.put(s.meta.sessionId, {
    meta: s.meta,
    title: s.title,
    entries: s.entries.slice(-IDB_MAX_ENTRIES),
    total: s.total,
    usage: s.usage,
    commands: s.commands,
    modes: s.modes,
    configOptions: s.configOptions,
    savedAt: Date.now(),
  });
}

// ================= App =================

const state = {
  transport: null,
  lastEventId: 0,
  splitBuf: new Map(),
  sessions: new Map(),
  currentSid: null,
  pendingPerm: [],
  listTimer: null,
  online: false,
  daemonOk: false,
  started: false,
  searchTimer: null,
  timers: [],
  datasave: localStorage.getItem('dr.datasave') !== '0',
  pins: JSON.parse(localStorage.getItem('dr.pins') || '[]'),
  sessionRows: JSON.parse(localStorage.getItem('dr.sesslist') || 'null'),
};

const sess = (sid) => state.sessions.get(sid);
const detailOn = () => !state.datasave;

function newSessObj(meta = {}) {
  return {
    meta,
    modes: null,
    configOptions: [],
    entries: [], // {i, role, text|n|titles}
    notes: 0,
    usage: null,
    commands: [],
    running: false,
    steps: 0,
    planCurrent: null,
    total: 0,
    hasMore: false,
    loaded: false,
    title: meta.title || '',
    rendered: new Map(), // i -> {node, sig}
  };
}

// ---------- Open-Result / Live-Ops ----------

function putEntry(s, e) {
  const ix = s.entries.findIndex((x) => x.i >= e.i);
  if (ix >= 0 && s.entries[ix].i === e.i) s.entries[ix] = e;
  else if (ix >= 0) s.entries.splice(ix, 0, e);
  else s.entries.push(e);
}

function applyOpenResult(s, r) {
  s.modes = r.modes || s.modes;
  s.configOptions = r.configOptions || s.configOptions;
  s.usage = r.usage || s.usage;
  s.commands = r.commands || s.commands;
  s.title = r.title || s.title;
  s.running = !!r.running;
  s.steps = r.status?.steps || 0;
  s.planCurrent = r.status?.plan || null;
  s.total = r.total || 0;
  s.meta._meta = { ...s.meta._meta, ...r.meta };
  if (r.reset) {
    s.entries = [...(r.messages || [])];
    s.hasMore = r.messages?.length && s.entries[0]?.i > 0;
    s.rendered.clear();
    renderTranscript(true);
  } else {
    for (const m of r.messages || []) putEntry(s, { ...m });
    renderTranscript();
  }
  s.loaded = true;
  renderHistState();
}

function applyOp(sid, op) {
  const s = sess(sid);
  if (!s) return;
  switch (op.type) {
    case 'msg': {
      const res = applyMsgOp(s.entries, op);
      if (res === 'resync') { requestResync(sid); break; }
      if (res === 'applied' && sid === state.currentSid) patchTranscript(op.i);
      break;
    }
    case 'status':
      s.running = !!op.running;
      s.steps = op.steps ?? s.steps;
      s.planCurrent = op.plan ?? null;
      if (sid === state.currentSid) { renderWorkline(s); updateSendBtn(); }
      break;
    case 'usage':
      s.usage = { used: op.used, size: op.size };
      if (sid === state.currentSid) renderUsage(s);
      break;
    case 'title':
      s.title = op.title;
      if (sid === state.currentSid) renderSessionHeader();
      break;
    case 'mode':
      if (s.modes) s.modes.currentModeId = op.currentModeId;
      else s.modes = { currentModeId: op.currentModeId, availableModes: [] };
      if (sid === state.currentSid) renderSessionHeader();
      break;
    case 'config':
      s.configOptions = op.configOptions || s.configOptions;
      if (sid === state.currentSid) renderSessionHeader();
      break;
    case 'commands':
      s.commands = op.commands || [];
      break;
    case 'note': {
      const last = s.entries.at(-1);
      putEntry(s, { i: (last ? Math.ceil(last.i) : -1) + 0.5, role: 'note', text: op.text });
      if (sid === state.currentSid) renderTranscript();
      break;
    }
  }
}

function applyEvent(e) {
  const p = e.payload;
  if (p?.split) {
    const key = p.split.id;
    const arr = state.splitBuf.get(key) || [];
    arr[p.split.seq] = p;
    state.splitBuf.set(key, arr);
    if (arr.filter(Boolean).length < p.split.total) return;
    state.splitBuf.delete(key);
    const full = JSON.parse(arr.sort((a, b) => a.split.seq - b.split.seq).map((x) => x.data).join(''));
    return applyEvent({ ...e, payload: full });
  }
  switch (e.kind) {
    case 'live': {
      for (const op of p.ops || []) applyOp(e.session_id, op);
      break;
    }
    case 'request': {
      if (p.method === 'session/request_permission') {
        const o = p.params?.options || [];
        state.pendingPerm.push({ rpcId: p.rpcId, sessionId: p.params?.sessionId || e.session_id, title: p.params?.toolCall?.title || 'Genehmigung', options: o });
        showPermSheet();
      }
      break;
    }
    case 'bridge': {
      if (p.type === 'request_answered') {
        state.pendingPerm = state.pendingPerm.filter((r) => r.rpcId !== p.rpcId);
        showPermSheet();
      }
      break;
    }
    case 'notification': {
      // nur noch MCP-Hinweise kommen ungefiltert an
      if (p.method?.startsWith('_cognition.ai/mcp/')) {
        const url = p.params?.url || p.params?.authUrl || p.params?.authorizationUrl;
        if (url && e.session_id) {
          const s = sess(e.session_id);
          if (s) { const last = s.entries.at(-1); putEntry(s, { i: (last ? Math.ceil(last.i) : -1) + 0.5, role: 'note', text: `MCP-Anmeldung erforderlich – am PC bestätigen oder öffnen: ${url}` }); }
        }
      }
      break;
    }
  }
}

// Luecke im Strom -> open mit since resynchronisiert (debounced pro Sitzung).
const resyncTimers = new Map();
function requestResync(sid) {
  if (resyncTimers.has(sid)) return;
  resyncTimers.set(sid, setTimeout(async () => {
    resyncTimers.delete(sid);
    const s = sess(sid);
    if (!s?.loaded) return;
    const lastReal = [...s.entries].reverse().find((e) => Number.isInteger(e.i));
    const since = lastReal ? { count: lastReal.i + 1, hash: msgHash(lastReal) } : undefined;
    try {
      const r = await rpcCall('_bridge/session/open', {
        sessionId: sid, cwd: s.meta.cwd, additionalDirectories: s.meta.additionalDirectories,
        since, limit: OPEN_LIMIT, detail: detailOn(), force: !lastReal,
      });
      applyOpenResult(s, r);
      renderSessionHeader();
      saveSession(s);
    } catch (e) { showErr(e); }
  }, 400));
}

// Event-Cursor vor open/resume auf den neuesten Stand setzen – Backlog-
// Duplikate werden so uebersprungen (Ops sind dank `at` idempotent).
async function seedEventCursor() {
  try {
    const cur = await state.transport.latestEventId?.();
    if (cur) state.lastEventId = Math.max(state.lastEventId, cur);
  } catch {}
}

// ---------- Render ----------

function renderEntry(e) {
  const d = document.createElement('div');
  if (e.role === 'user') {
    d.className = 'msg user';
    d.innerHTML = `<div class="bubble">${esc(e.text)}</div>`;
  } else if (e.role === 'agent') {
    d.className = 'msg agent';
    d.innerHTML = `<div class="bubble md">${md(e.text)}</div>`;
    addCopyButtons(d);
  } else if (e.role === 'thought') {
    d.className = 'msg thought';
    d.innerHTML = `<details class="thought-box"><summary>Gedanken</summary><div>${esc(e.text)}</div></details>`;
  } else if (e.role === 'steps') {
    d.className = 'msg steps';
    const titles = e.titles?.length ? ` · ${e.titles.map((t) => esc(t)).join(' · ')}` : '';
    d.innerHTML = `<div class="steps-line">⚙ ${e.n} Schritt${e.n === 1 ? '' : 'e'}${titles}</div>`;
  } else {
    d.className = 'msg note';
    d.innerHTML = `<div class="note-box">${esc(e.text)}</div>`;
  }
  return d;
}

function visibleEntry(e) {
  if (e.role === 'thought') return detailOn();
  if (e.role === 'steps') return detailOn();
  return true;
}

function entrySig(e) {
  return `${e.role}:${(e.text || '').length}:${e.n || 0}:${(e.titles || []).length}`;
}

function addCopyButtons(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Kopieren';
    btn.onclick = () => { navigator.clipboard?.writeText(pre.innerText); btn.textContent = 'kopiert'; setTimeout(() => (btn.textContent = 'Kopieren'), 1500); };
    pre.appendChild(btn);
  });
}

const NEAR_BOTTOM = 80;
const nearBottom = () => {
  const box = $('#transcript');
  return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM;
};
const stickBottom = () => { $('#transcript').scrollTop = $('#transcript').scrollHeight; };

// Volles Neuzeichnen (open/reset/history/Toggle) oder gezieltes Patchen.
function renderTranscript(full = false) {
  const s = sess(state.currentSid);
  const box = $('#transcript');
  if (!s) { box.innerHTML = ''; return; }
  const wasNear = nearBottom();
  const sentinel = ensureSentinel();
  if (full) {
    for (const n of [...box.querySelectorAll('.msg')]) n.remove();
    s.rendered.clear();
  }
  for (const e of s.entries) {
    if (!visibleEntry(e)) continue;
    const cur = s.rendered.get(e.i);
    const sig = entrySig(e);
    if (cur && cur.sig === sig) continue;
    const node = renderEntry(e);
    if (cur) {
      cur.node.replaceWith(node);
    } else {
      // nach i einsortiert einfuegen (vor der Workline)
      const next = [...box.querySelectorAll('.msg')].find((n) => Number(n.dataset.i) > e.i);
      box.insertBefore(node, next || $('#work-hint'));
    }
    node.dataset.i = e.i;
    s.rendered.set(e.i, { node, sig });
  }
  renderWorkline(s);
  renderUsage(s);
  if (full || wasNear) stickBottom();
}

// Gezieltes Update eines Eintrags (Live-Op)
function patchTranscript(i) {
  const s = sess(state.currentSid);
  if (!s) return;
  const e = s.entries.find((x) => x.i === i);
  if (!e || !visibleEntry(e)) return;
  const cur = s.rendered.get(i);
  const sig = entrySig(e);
  if (cur && cur.sig === sig) return;
  const wasNear = nearBottom();
  const node = renderEntry(e);
  node.dataset.i = i;
  if (cur) cur.node.replaceWith(node);
  else {
    const next = [...$('#transcript').querySelectorAll('.msg')].find((n) => Number(n.dataset.i) > i);
    $('#transcript').insertBefore(node, next || $('#work-hint'));
  }
  s.rendered.set(i, { node, sig });
  if (wasNear) stickBottom();
}

function renderWorkline(s) {
  const el = $('#work-hint');
  if (s.running) {
    el.hidden = false;
    el.textContent = `Devin arbeitet …${s.steps ? ` · ${s.steps} Schritte` : ''}${s.planCurrent ? ` · ${s.planCurrent}` : ''}`;
  } else {
    el.hidden = true;
  }
}

function ensureSentinel() {
  const box = $('#transcript');
  let st = $('#hist-sentinel');
  if (!st) {
    st = document.createElement('div');
    st.id = 'hist-sentinel';
    st.className = 'hist-sentinel';
    box.prepend(st);
    const wl = document.createElement('div');
    wl.id = 'work-hint';
    wl.className = 'running-hint';
    wl.hidden = true;
    box.appendChild(wl);
    st._io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) loadHistory();
    }, { root: box, threshold: 0.1 });
    st._io.observe(st);
  }
  renderHistState();
  return st;
}

function renderHistState() {
  const s = sess(state.currentSid);
  const st = $('#hist-sentinel');
  if (!st || !s) return;
  if (!s.loaded || !s.hasMore) { st.innerHTML = ''; return; }
  st.innerHTML = `<button class="hist-btn" id="hist-btn">Ältere Nachrichten laden</button>`;
  $('#hist-btn').onclick = loadHistory;
}

let historyLoading = false;
async function loadHistory() {
  const s = sess(state.currentSid);
  if (!s || historyLoading || !s.entries.length || !s.hasMore) return;
  historyLoading = true;
  const box = $('#transcript');
  const first = s.entries.find(visibleEntry) || s.entries[0];
  try {
    const r = await rpcCall('_bridge/session/history', { sessionId: s.meta.sessionId, before: first.i, limit: HISTORY_LIMIT, detail: detailOn() });
    const before = box.scrollHeight - box.scrollTop;
    for (const m of (r.messages || []).reverse()) {
      if (!s.entries.some((x) => x.i === m.i)) putEntry(s, { ...m });
    }
    s.hasMore = r.hasMore;
    s.total = Math.max(s.total, r.total || 0);
    renderHistState();
    renderTranscript();
    box.scrollTop = box.scrollHeight - before; // Leseposition halten
    saveSession(s);
  } catch (e) { showErr(e); }
  historyLoading = false;
}

function renderUsage(s) {
  const el = $('#usage-bar');
  if (!s.usage?.size) { el.hidden = true; return; }
  el.hidden = false;
  const pct = Math.min(100, Math.round((100 * s.usage.used) / s.usage.size));
  el.innerHTML = `<div class="usage-label">Kontext ${s.usage.used.toLocaleString('de')} / ${s.usage.size.toLocaleString('de')} (${pct}%)</div><div class="usage-track"><div class="usage-fill" style="width:${pct}%"></div></div>`;
}

function renderSessionHeader() {
  const s = sess(state.currentSid);
  if (!s) return;
  $('#sess-title').textContent = s.title || s.meta?.title || state.currentSid;
  $('#sess-cwd').textContent = shortCwd(s.meta?.cwd);
  const dirs = s.meta?.additionalDirectories || s.meta?._meta?.['cognition.ai/additionalWorkspaceDirs'] || [];
  $('#sess-dirs').textContent = dirs.length ? `+${dirs.length} Ordner` : '';
  const planPath = s.meta?._meta?.['cognition.ai/planFilePath'];
  $('#sess-plan').textContent = planPath ? shortCwd(planPath) : '';
  const modeSel = $('#mode-sel');
  const modes = s.modes?.availableModes || [];
  modeSel.innerHTML = modes.map((m) => `<option value="${m.id}" ${m.id === s.modes.currentModeId ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  modeSel.classList.toggle('danger', s.modes?.currentModeId === 'bypass');
  renderConfigOptions(s);
}

function renderConfigOptions(s) {
  const box = $('#config-opts');
  box.innerHTML = '';
  for (const o of s.configOptions || []) {
    if (o.id === 'model') { renderModelButton(s, o); continue; }
    const w = document.createElement('label');
    w.className = 'cfg-opt';
    w.innerHTML = `<span>${esc(o.name || o.id)}</span>`;
    const sel = document.createElement('select');
    sel.innerHTML = (o.options || []).map((op) => `<option value="${esc(op.value)}" ${op.value === o.currentValue ? 'selected' : ''}>${esc(op.name)}</option>`).join('');
    sel.onchange = () => rpcCall('_bridge/session/set_config_option', { sessionId: state.currentSid, configId: o.id, value: sel.value }).catch(showErr);
    w.appendChild(sel);
    box.appendChild(w);
  }
}

function renderModelButton(s, o) {
  const btn = $('#model-btn');
  const cur = (o.options || []).find((x) => x.value === o.currentValue);
  btn.textContent = cur?.name || o.currentValue || 'Modell';
  btn.onclick = () => openModelSheet(o);
}

async function openModelSheet(o) {
  const sh = $('#model-sheet');
  sh.hidden = false;
  // Grosse Optionslisten kommen lazy (open liefert nur _meta.lazy) –
  // volle Liste erst beim Oeffnen des Sheets nachladen.
  if (o._meta?.lazy || !o.options?.length) {
    const list = $('#model-list');
    list.innerHTML = '<div class="empty">Lade Modelle …</div>';
    try {
      const r = await rpcCall('_bridge/session/defaultConfigOptions', { cwd: sess(state.currentSid)?.meta?.cwd });
      const full = (r.configOptions || []).find((x) => x.id === o.id);
      if (full) o.options = full.options;
    } catch (e) { list.innerHTML = `<div class="empty error">${esc(e.message)}</div>`; return; }
  }
  const groups = new Map();
  for (const op of o.options || []) {
    const fam = (op.name || '').replace(/\s+(High|Medium|Low|Max|Fast|Slow|Turbo|Pro|Mini|Nano|Adaptive|Standard)(.*)$/i, '').trim() || op.name;
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam).push(op);
  }
  const render = (q = '') => {
    const list = $('#model-list');
    list.innerHTML = '';
    for (const [fam, ops] of groups) {
      const vis = ops.filter((x) => !q || x.name.toLowerCase().includes(q) || x.value.toLowerCase().includes(q));
      if (!vis.length) continue;
      const h = document.createElement('div');
      h.className = 'model-family';
      h.textContent = fam;
      list.appendChild(h);
      for (const op of vis) {
        const it = document.createElement('button');
        it.className = 'model-item' + (op.value === o.currentValue ? ' current' : '');
        it.innerHTML = `${esc(op.name)}${op._meta?.['cognition.ai/supportsImages'] ? ' <span class="img-tag">Bild</span>' : ''}`;
        it.onclick = async () => {
          sh.hidden = true;
          await rpcCall('_bridge/session/set_config_option', { sessionId: state.currentSid, configId: 'model', value: op.value }).catch(showErr);
          o.currentValue = op.value;
          renderSessionHeader();
        };
        list.appendChild(it);
      }
    }
  };
  $('#model-search').value = '';
  $('#model-search').oninput = (e) => render(e.target.value.toLowerCase());
  render();
}

// ---------- Permission Sheet ----------

function showPermSheet() {
  const sh = $('#perm-sheet');
  const r = state.pendingPerm[0];
  if (!r) { sh.hidden = true; renderBadge(); return; }
  sh.hidden = false;
  $('#perm-title').textContent = `Genehmigung: ${r.title}`;
  $('#perm-sess').textContent = sess(r.sessionId)?.title || r.sessionId || '';
  const box = $('#perm-options');
  box.innerHTML = '';
  for (const o of r.options) {
    const b = document.createElement('button');
    b.className = 'perm-opt' + (/reject|deny|block/i.test(o.optionId + o.name) ? ' deny' : '');
    b.textContent = o.name || o.optionId;
    b.onclick = async () => {
      state.pendingPerm = state.pendingPerm.filter((x) => x.rpcId !== r.rpcId);
      showPermSheet();
      await rpcCall('_bridge/respond', { rpcId: r.rpcId, response: { outcome: { outcome: 'selected', optionId: o.optionId } } }).catch(showErr);
    };
    box.appendChild(b);
  }
  const cancel = document.createElement('button');
  cancel.className = 'perm-opt deny';
  cancel.textContent = 'Abbrechen';
  cancel.onclick = async () => {
    state.pendingPerm = state.pendingPerm.filter((x) => x.rpcId !== r.rpcId);
    showPermSheet();
    await rpcCall('_bridge/respond', { rpcId: r.rpcId, response: { outcome: { outcome: 'cancelled' } } }).catch(showErr);
  };
  box.appendChild(cancel);
  renderBadge();
}

function renderBadge() {
  const n = state.pendingPerm.length;
  $('#perm-badge').hidden = !n;
  $('#perm-badge').textContent = n;
}

// ---------- Sitzungsliste ----------

function renderSessionRows(sessions) {
  const groups = new Map();
  for (const s of sessions || []) {
    const g = s.cwd || 'ohne Ordner';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const box = $('#sess-list');
  box.innerHTML = '';
  if (!groups.size) { box.innerHTML = '<div class="empty">Keine Sitzungen.</div>'; }
  for (const [cwd, list] of groups) {
    const h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = shortCwd(cwd);
    box.appendChild(h);
    for (const s of list) {
      const locked = s._meta?.['cognition.ai/isLocked'];
      const permN = state.pendingPerm.filter((r) => r.sessionId === s.sessionId).length;
      const row = document.createElement('div');
      row.className = 'sess-row' + (locked ? ' locked' : '');
      row.innerHTML = `<div class="sess-main"><div class="sess-title">${esc(s.title || s.sessionId)}</div>
        <div class="sess-sub">${timeAgo(s.updatedAt)}${locked ? ' · am PC geöffnet' : ''}</div></div>
        ${permN ? `<span class="badge">${permN}</span>` : ''}
        <button class="icon-btn rename-btn" title="Umbenennen">✎</button>
        <button class="icon-btn del-btn" title="Löschen">✕</button>`;
      row.querySelector('.rename-btn').onclick = async (ev) => {
        ev.stopPropagation();
        const t = prompt('Neuer Titel:', s.title || '');
        if (t !== null && t.trim()) await rpcCall('_bridge/session/rename', { sessionId: s.sessionId, title: t.trim() }).catch(showErr).then(refreshSessionList);
      };
      row.querySelector('.del-btn').onclick = async (ev) => {
        ev.stopPropagation();
        if (confirm(`Sitzung „${s.title || s.sessionId}“ wirklich löschen?`)) {
          await rpcCall('_bridge/session/delete', { sessionId: s.sessionId }).catch(showErr).then(refreshSessionList);
          if (state.currentSid === s.sessionId) showList();
        }
      };
      row.onclick = () => openSession(s);
      box.appendChild(row);
    }
  }
}

async function refreshSessionList() {
  const q = $('#search').value.trim();
  const orderBy = $('#sort-sel').value || 'updated_at';
  if (!q && state.sessionRows) renderSessionRows(state.sessionRows); // Cache zuerst
  try {
    const data = await rpcCall('_bridge/session/list', { query: q || undefined, orderBy, sortDirection: 'desc' });
    state.sessionRows = data.sessions || [];
    if (!q) localStorage.setItem('dr.sesslist', JSON.stringify(state.sessionRows));
    renderSessionRows(state.sessionRows);
  } catch (e) {
    if (!state.sessionRows) $('#sess-list').innerHTML = `<div class="empty">Fehler: ${esc(e.message)}</div>`;
  }
}

async function openSession(meta) {
  const sid = meta.sessionId;
  const prevSid = state.currentSid;
  if (!state.sessions.has(sid)) state.sessions.set(sid, newSessObj(meta));
  const s = sess(sid);
  s.meta = { ...s.meta, ...meta };
  s.title = s.title || meta.title || sid;
  state.currentSid = sid;
  showSession();
  renderSessionHeader();
  // gecachte Tail sofort anzeigen (unten verankert)
  const cached = await idb.get(sid);
  if (cached?.entries?.length && !s.entries.length) {
    s.entries = cached.entries;
    s.total = cached.total || 0;
    s.hasMore = true;
    s.usage = cached.usage || s.usage;
    s.commands = cached.commands || s.commands;
    s.modes = cached.modes || s.modes;
    s.configOptions = cached.configOptions || s.configOptions;
    s.title = cached.title || s.title;
    s.loaded = true;
  }
  ensureSentinel();
  renderHistState();
  renderSessionHeader();
  renderTranscript(true);
  try {
    // `since` vom letzten Server-Eintrag (ganzzahliges i) – Notizen auslassen.
    const lastReal = [...s.entries].reverse().find((e) => Number.isInteger(e.i));
    const since = lastReal ? { count: lastReal.i + 1, hash: msgHash(lastReal) } : undefined;
    await seedEventCursor(); // Backlog-Ops werden per `at` ohnehin dedupliziert
    const r = await rpcCall('_bridge/session/open', {
      sessionId: sid,
      cwd: meta.cwd,
      additionalDirectories: meta.additionalDirectories,
      since,
      limit: OPEN_LIMIT,
      detail: detailOn(),
    });
    applyOpenResult(s, r);
    renderSessionHeader();
    saveSession(s);
  } catch (e) {
    $('#transcript').innerHTML = `<div class="empty error">${esc(e.message)}${/already open|locked/i.test(e.message) ? '<br>Sitzung ist auf dem PC geöffnet.' : ''}</div>`;
  }
}

// ---------- Ordner-Auswahl (Pins, Vorschläge, Durchsuchen) ----------

function isPinned(p) { return state.pins.includes(p); }
function togglePin(p) {
  state.pins = isPinned(p) ? state.pins.filter((x) => x !== p) : [...state.pins, p];
  localStorage.setItem('dr.pins', JSON.stringify(state.pins));
  renderCwdPicker();
}

function cwdSuggestions() {
  const rows = state.sessionRows || [];
  const score = new Map();
  for (const s of rows) {
    if (!s.cwd) continue;
    const rec = Math.max(0, 30 - (Date.now() - new Date(s.updatedAt || 0).getTime()) / 86400e3);
    score.set(s.cwd, (score.get(s.cwd) || 0) + 1 + rec);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 6);
}

function cwdRow(path, label) {
  const row = document.createElement('div');
  row.className = 'cwd-row';
  row.innerHTML = `<span class="cwd-path" title="${esc(path)}">${esc(label || shortCwd(path))}</span>
    <button class="icon-btn pin-btn ${isPinned(path) ? 'pinned' : ''}" title="Anheften">${isPinned(path) ? '★' : '☆'}</button>`;
  row.querySelector('.cwd-path').onclick = () => { $('#cwd-input').value = path; };
  row.querySelector('.pin-btn').onclick = (e) => { e.stopPropagation(); togglePin(path); };
  return row;
}

let browsePath = null;
async function renderBrowse(path) {
  const box = $('#cwd-browse');
  if (path === undefined) { box.hidden = true; browsePath = null; return; }
  box.hidden = false;
  box.innerHTML = '<div class="empty">Lade Ordner …</div>';
  try {
    const r = await rpcCall('_bridge/fs/list', path ? { path } : {});
    browsePath = r.path;
    box.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'browse-bar';
    bar.innerHTML = `<button class="link-btn" id="browse-up" ${r.path === null ? 'hidden' : ''}>‹ hoch</button>
      <span class="browse-cur">${esc(shortCwd(r.path) || 'Laufwerke')}</span>`;
    box.appendChild(bar);
    const up = bar.querySelector('#browse-up');
    if (up) up.onclick = () => renderBrowse(r.parent);
    for (const d of r.dirs) {
      const full = r.path === null ? d : (r.path.endsWith('\\') ? r.path + d : r.path + '\\' + d);
      const row = document.createElement('div');
      row.className = 'cwd-row browse-row';
      row.innerHTML = `<span class="cwd-path">${esc(d)}</span><button class="icon-btn pin-btn ${isPinned(full) ? 'pinned' : ''}">★</button>`;
      row.querySelector('.cwd-path').onclick = () => (r.path === null ? renderBrowse(full) : renderBrowse(full));
      row.querySelector('.pin-btn').onclick = (e) => { e.stopPropagation(); togglePin(full); };
      box.appendChild(row);
    }
    if (r.truncated) { const t = document.createElement('div'); t.className = 'sheet-sub'; t.textContent = '… gekürzt'; box.appendChild(t); }
    if (r.path !== null) {
      const pick = document.createElement('button');
      pick.className = 'primary';
      pick.textContent = 'Diesen Ordner wählen';
      pick.onclick = () => { $('#cwd-input').value = r.path; };
      box.appendChild(pick);
    }
  } catch (e) {
    box.innerHTML = `<div class="empty error">${esc(e.message)}</div>`;
  }
}

function renderCwdPicker() {
  const pins = $('#cwd-pins');
  pins.innerHTML = '';
  if (state.pins.length) {
    pins.appendChild(Object.assign(document.createElement('div'), { className: 'cwd-sec', textContent: 'Angeheftet' }));
    for (const p of state.pins) pins.appendChild(cwdRow(p));
  }
  const sug = $('#cwd-sug');
  sug.innerHTML = '';
  const suggestions = cwdSuggestions().filter((c) => !isPinned(c));
  if (suggestions.length) {
    sug.appendChild(Object.assign(document.createElement('div'), { className: 'cwd-sec', textContent: 'Vorschläge' }));
    for (const c of suggestions) sug.appendChild(cwdRow(c));
  }
}

async function newSession() {
  const sh = $('#new-sheet');
  sh.hidden = false;
  $('#cwd-input').value = state.pins[0] || cwdSuggestions()[0] || '';
  $('#dirs-input').value = '';
  renderCwdPicker();
  renderBrowse(undefined);
  $('#cwd-browse-btn').onclick = () => renderBrowse(browsePath === null || browsePath === undefined ? null : undefined);
  $('#new-ok').onclick = async () => {
    const cwd = $('#cwd-input').value.trim();
    if (!cwd) return;
    const dirs = $('#dirs-input').value.split(';').map((x) => x.trim()).filter(Boolean);
    sh.hidden = true;
    try {
      const r = await rpcCall('_bridge/session/new', { cwd, additionalDirectories: dirs.length ? dirs : undefined });
      await refreshSessionList();
      openSession({ sessionId: r.sessionId, cwd, title: 'Neue Sitzung' });
    } catch (e) { showErr(e); }
  };
  $('#new-cancel').onclick = () => (sh.hidden = true);
}

// ---------- Senden ----------

async function send() {
  const s = sess(state.currentSid);
  const ta = $('#composer-input');
  const text = ta.value.trim();
  const img = state.pendingImage;
  if (!s || (!text && !img)) return;
  ta.value = '';
  ta.dispatchEvent(new Event('input'));
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  if (img) { blocks.push({ type: 'image', data: img.data, mimeType: img.mime }); state.pendingImage = null; $('#img-chip').hidden = true; }
  s.running = true;
  renderWorkline(s);
  updateSendBtn();
  try {
    await rpcCall('_bridge/session/prompt', { sessionId: state.currentSid, prompt: blocks });
    s.running = false;
  } catch (e) {
    s.running = false;
    putEntry(s, { i: (s.entries.at(-1)?.i || 0) + 0.5, role: 'note', text: 'Fehler: ' + e.message });
    renderTranscript();
  }
  renderWorkline(s);
  updateSendBtn();
  saveSession(s);
}

async function cancel() {
  if (!state.currentSid) return;
  await rpcCall('_bridge/session/cancel', { sessionId: state.currentSid }).catch(showErr);
  const s = sess(state.currentSid);
  if (s) { s.running = false; renderWorkline(s); }
  updateSendBtn();
}

function updateSendBtn() {
  const s = sess(state.currentSid);
  $('#send-btn').hidden = !!s?.running;
  $('#cancel-btn').hidden = !s?.running;
}

// ---------- Slash-Autocomplete / Bild ----------

function setupComposer() {
  const ta = $('#composer-input');
  const box = $('#cmd-box');
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
    const v = ta.value;
    const s = sess(state.currentSid);
    if (v.startsWith('/') && !v.includes(' ') && s?.commands?.length) {
      const q = v.slice(1).toLowerCase();
      const hits = s.commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
      if (hits.length) {
        box.hidden = false;
        box.innerHTML = '';
        for (const c of hits) {
          const it = document.createElement('button');
          it.className = 'cmd-item';
          it.innerHTML = `/${esc(c.name)}${c.input?.hint ? ' ' + esc(c.input.hint) : ''} <span class="cmd-desc">${esc(c.description || '')}</span>`;
          it.onclick = () => { ta.value = `/${c.name} `; box.hidden = true; ta.focus(); };
          box.appendChild(it);
        }
        return;
      }
    }
    box.hidden = true;
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#send-btn').onclick = send;
  $('#cancel-btn').onclick = cancel;
  $('#attach-btn').onclick = () => $('#img-input').click();
  $('#img-input').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (state.datasave && /^image\//.test(f.type)) {
      const scaled = await downscaleImage(f).catch(() => null);
      if (scaled) {
        state.pendingImage = { data: scaled.data, mime: 'image/jpeg' };
        $('#img-chip').hidden = false;
        $('#img-chip').textContent = `Bild angehängt (${Math.round(scaled.bytes / 1024)} KB)`;
        return;
      }
    }
    const r = new FileReader();
    r.onload = () => {
      state.pendingImage = { data: r.result.split(',')[1], mime: f.type };
      $('#img-chip').hidden = false;
      $('#img-chip').textContent = 'Bild angehängt';
    };
    r.readAsDataURL(f);
  };
}

// Datensparmodus: max. 1600 px lange Seite, JPEG q0.8.
function downscaleImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(img.src);
      const dataUrl = cv.toDataURL('image/jpeg', 0.8);
      res({ data: dataUrl.split(',')[1], bytes: Math.round(dataUrl.length * 0.75) });
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Status / Poll ----------

async function rpcCall(method, params) {
  return state.transport.rpc(method, params);
}

function showErr(e) {
  const bar = $('#err-bar');
  bar.textContent = e.message || String(e);
  bar.hidden = false;
  setTimeout(() => (bar.hidden = true), 5000);
}

async function pollEvents() {
  if (!state.currentSid) return; // nur solange eine Sitzung offen ist
  try {
    const rows = await state.transport.pollEvents(state.lastEventId, state.currentSid);
    for (const e of rows) {
      state.lastEventId = Math.max(state.lastEventId, e.id);
      applyEvent(e);
    }
    if (rows.length && sess(state.currentSid)) saveSession(sess(state.currentSid));
    $('#conn-dot').className = 'dot on';
  } catch (e) {
    $('#conn-dot').className = 'dot off';
  }
}

async function pollStatus() {
  try {
    const st = await state.transport.bridgeStatus();
    state.online = st ? Date.now() - new Date(st.last_seen).getTime() < ONLINE_GRACE_MS : false;
    state.daemonOk = !!st?.daemon_ok;
  } catch { state.online = false; state.daemonOk = false; }
  const el = $('#pc-status');
  el.textContent = state.online ? `PC online${state.daemonOk ? ' · Daemon ok' : ' · Daemon aus'}` : 'PC offline';
  el.className = 'status ' + (state.online ? (state.daemonOk ? 'ok' : 'warn') : 'off');
}

function refreshSessionListDebounced() {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => { if (!$('#view-list').hidden) refreshSessionList(); }, 1200);
}

function startTimers() {
  stopTimers();
  state.timers.push(setInterval(pollStatus, STATUS_POLL_MS));
  state.timers.push(setInterval(pollEvents, EVENTS_POLL_MS));
}
function stopTimers() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
}

// ---------- Views ----------

function showList() {
  const prev = state.currentSid;
  $('#view-session').hidden = true;
  $('#view-list').hidden = false;
  state.currentSid = null;
  if (prev) {
    const s = sess(prev);
    if (s) saveSession(s);
    rpcCall('_bridge/session/unwatch', { sessionId: prev }).catch(() => {});
  }
  refreshSessionList();
}

function showSession() {
  $('#view-list').hidden = true;
  $('#view-session').hidden = false;
}

// ---------- Auth / MFA ----------

function setupLogin() {
  const pw = $('#login-password');
  const warn = $('#pw-warn');
  pw.addEventListener('input', () => {
    warn.hidden = !(pw.value !== pw.value.trim());
  });
  $('#login-btn').onclick = doLogin;
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
}

async function doLogin() {
  const err = $('#login-err');
  err.hidden = true;
  const p = $('#login-password').value;
  $('#login-btn').disabled = true;
  try {
    const r = await state.transport.login(LOGIN_EMAIL, p);
    if (r.error) throw new Error(r.error.message);
    await afterPassword();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    $('#login-btn').disabled = false;
  }
}

async function afterPassword() {
  let factors = [];
  try {
    const lf = await state.transport.listFactors();
    factors = (lf.data?.totp || []).filter((f) => f.status === 'verified');
  } catch {}
  const mfaBox = $('#mfa-box');
  mfaBox.hidden = false;
  if (factors.length) {
    $('#mfa-title').textContent = 'Zwei-Faktor-Code eingeben';
    $('#mfa-qr').hidden = true;
    $('#mfa-secret').hidden = true;
    setupVerify(factors[0].id);
  } else {
    try {
      const all = await state.transport.listFactors();
      for (const f of all.data?.totp || []) if (f.status !== 'verified') await state.transport.unenroll(f.id);
    } catch {}
    const en = await state.transport.enroll();
    if (en.error) { $('#login-err').textContent = en.error.message; $('#login-err').hidden = false; return; }
    $('#mfa-title').textContent = 'Zwei-Faktor einrichten – QR scannen';
    $('#mfa-qr').hidden = false;
    const qr = en.data.totp?.qr_code || '';
    const img = document.createElement('img');
    img.alt = 'QR-Code für die Authenticator-App';
    const svg = qr.startsWith('data:') ? qr.slice(qr.indexOf(',') + 1) : qr;
    img.src = svg.trimStart().startsWith('<') ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : qr;
    $('#mfa-qr').replaceChildren(img);
    $('#mfa-secret').hidden = false;
    $('#mfa-secret').textContent = `Schlüssel: ${en.data.totp?.secret || ''}`;
    setupVerify(en.data.id);
  }
}

function setupVerify(factorId) {
  $('#mfa-code').value = '';
  $('#mfa-verify').onclick = async () => {
    const code = $('#mfa-code').value.trim();
    const r = await state.transport.verify(factorId, code);
    if (r.error) {
      $('#mfa-err').textContent = 'Code ungültig – erneut versuchen.';
      $('#mfa-err').hidden = false;
      return;
    }
    $('#mfa-err').hidden = true;
    startApp();
  };
}

// ---------- Start ----------

async function startApp() {
  if (state.started) return;
  state.started = true;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  pollStatus();
  state.transport.latestEventId?.().then((id) => { state.lastEventId = Math.max(state.lastEventId, id); }).catch(() => {});
  startTimers();
  refreshSessionList();
}

async function boot() {
  setupLogin();
  setupComposer();
  $('#logout-btn').onclick = async () => { await state.transport.logout(); location.reload(); };
  $('#back-btn').onclick = showList;
  $('#new-btn').onclick = newSession;
  $('#refresh-btn').onclick = refreshSessionList;
  $('#search').oninput = () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(refreshSessionList, 400); };
  $('#sort-sel').onchange = refreshSessionList;
  // Datensparmodus (Default an): Detail-Eintraege und Bilder nur bei Bedarf.
  const ds = $('#datasave');
  ds.checked = state.datasave;
  ds.onchange = async () => {
    state.datasave = ds.checked;
    localStorage.setItem('dr.datasave', ds.checked ? '1' : '0');
    if (state.currentSid) {
      const s = sess(state.currentSid);
      s.entries = [];
      s.rendered.clear();
      s.hasMore = false;
      openSession(s.meta); // mit neuem Detail-Flag neu laden
    }
  };
  $('#mode-sel').onchange = async (e) => {
    const v = e.target.value;
    if (v === 'bypass' && !confirm('Bypass Permissions: Devin führt ALLE Werkzeugaufrufe ohne Rückfrage aus. Wirklich aktivieren?')) {
      renderSessionHeader();
      return;
    }
    await rpcCall('_bridge/session/set_mode', { sessionId: state.currentSid, modeId: v }).catch(showErr);
    const s = sess(state.currentSid);
    if (s?.modes) s.modes.currentModeId = v;
    renderSessionHeader();
  };
  $('#model-close').onclick = () => ($('#model-sheet').hidden = true);
  // Polls pausieren, wenn der Tab versteckt ist
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      stopTimers();
    } else if (state.started) {
      pollStatus();
      pollEvents();
      startTimers();
      if (state.currentSid) {
        const s = sess(state.currentSid);
        if (s?.loaded) {
          const lastReal = [...s.entries].reverse().find((e) => Number.isInteger(e.i));
          const since = lastReal ? { count: lastReal.i + 1, hash: msgHash(lastReal) } : undefined;
          await seedEventCursor();
          rpcCall('_bridge/session/open', { sessionId: s.meta.sessionId, cwd: s.meta.cwd, additionalDirectories: s.meta.additionalDirectories, since, limit: OPEN_LIMIT, detail: detailOn() })
            .then((r) => { applyOpenResult(s, r); renderSessionHeader(); saveSession(s); })
            .catch(() => {});
        }
      }
    }
  });

  if ('serviceWorker' in navigator && !MOCK) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  }

  if (MOCK) {
    const fixture = await (await fetch('mock-replay.json')).json();
    state.transport = new MockTransport(fixture);
    window.devinRemote = { state, rpcCall, sess, applyEvent, refreshSessionList, msgHash, openSession, loadHistory };
    return;
  }
  state.transport = new SupaTransport();
  window.devinRemote = { state, rpcCall, sess, applyEvent, refreshSessionList, msgHash, openSession, loadHistory };
  const { data } = await state.transport.session();
  if (data.session) {
    try { await afterPassword(); } catch { /* MFA-Flow zeigt sich bei Bedarf */ }
  }
}

boot();
