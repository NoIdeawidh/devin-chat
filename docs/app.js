import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@18.1.3/+esm';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.17/+esm';

const MOCK = new URLSearchParams(location.search).has('mock');
const SUPABASE_URL = 'https://iazsajsohlwrkijasrvx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_NEUmXrKjpChsMwa810ojcQ_OpSiaoMm';
const OWNER_ID = 'fd898a7a-bda3-45d4-a3d2-b7ed9990e591';
const LOGIN_EMAIL = 'henri@devin-chat.local';
const RPC_POLL_MS = 800;
const RPC_TIMEOUT_MS = 30 * 60 * 1000;
const EVENTS_POLL_MS = 1500;
const STATUS_POLL_MS = 15000;
const ONLINE_GRACE_MS = 60 * 1000;

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
  async pollEvents(lastId) {
    const r = await this.sb.from('events').select('id,session_id,kind,payload,created_at').gt('id', lastId).order('id').limit(500);
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
    this.pushEv = (session_id, kind, payload) =>
      this.ev.push({ id: this.evId++, session_id, kind, payload, created_at: new Date().toISOString() });
  }
  async login(e, p) { if (!p) return { error: { message: 'Passwort fehlt' } }; return { data: { session: { user: { id: 'mock' } } }, error: null }; }
  async session() { return { data: { session: null }, error: null }; }
  onAuth() { return { data: { subscription: { unsubscribe() {} } } }; }
  logout() {}
  async aal() { return { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null }; }
  async listFactors() { return { data: { totp: [] }, error: null }; }
  async enroll() {
    return {
      data: { id: 'mock-factor', totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#fff"/><rect x="10" y="10" width="30" height="30"/><rect x="80" y="10" width="30" height="30"/><rect x="10" y="80" width="30" height="30"/><rect x="50" y="50" width="20" height="20"/></svg>', secret: 'MOCKSECRET2345' } },
      error: null,
    };
  }
  async verify() { return { data: {}, error: null }; }
  unenroll() {}
  async bridgeStatus() {
    return { last_seen: new Date().toISOString(), hostname: 'DESKTOP-MOCK', daemon_ok: true, version: '1.0.0' };
  }
  async pollEvents(lastId) { return this.ev.filter((e) => e.id > lastId); }
  async latestEventId() { return 0; } // Mock: Replay soll komplett durchlaufen

  async rpc(method, p = {}) {
    await sleep(120);
    const F = this.f;
    switch (method) {
      case '_bridge/ping': return { pong: true, version: '1.0.0', hostname: 'DESKTOP-MOCK', daemon_ok: true };
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
        return r;
      }
      case '_bridge/session/load': {
        const sid = p.sessionId;
        const meta = F.sessions.find((s) => s.sessionId === sid);
        if (meta?._meta?.['cognition.ai/isLocked']) throw Object.assign(new Error('Session is already open in another process'), { rpcError: { code: -32000, message: 'already open in another process' } });
        setTimeout(() => { for (const u of F.replay) this.pushEv(sid, 'update', { bundled: [{ ...u, sessionId: sid }] }); }, 200);
        const r = JSON.parse(JSON.stringify(F.newResult));
        r.sessionId = sid;
        r._meta = meta?._meta || {};
        return r;
      }
      case '_bridge/session/prompt': {
        const sid = p.sessionId;
        const text = (p.prompt || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
        this.pushEv(sid, 'update', { bundled: [{ sessionId: sid, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } }] });
        this.running[sid] = true;
        // Simulierte Antwort mit Gedanken + Permission + Tool-Call
        const chunks = ['Antwort: ', 'ich habe ', 'die Datei ', 'gelesen.'];
        let delay = 300;
        this.pushEv(sid, 'update', { bundled: [{ sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Ich lese zuerst die Datei…' } } }] });
        if (/permission|tool|datei|lies|schreib/i.test(text)) {
          const rpcId = 'mock-req-' + this.evId;
          setTimeout(() => {
            this.pushEv(sid, 'update', { bundled: [{ sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Datei lesen', kind: 'read', status: 'pending', locations: [{ path: 'README.md' }] } }] });
            this.pushEv(sid, 'request', { rpcId, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'tc1', title: 'Datei lesen' }, options: [{ optionId: 'allow', name: 'Erlauben' }, { optionId: 'always', name: 'Immer erlauben' }, { optionId: 'deny', name: 'Ablehnen' }] } });
          }, delay);
          delay += 600;
        }
        for (const [i, c] of chunks.entries()) {
          setTimeout(() => { if (this.running[sid]) this.pushEv(sid, 'update', { bundled: [{ sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: c } } }] }); }, delay + i * 250);
        }
        setTimeout(() => {
          if (!this.running[sid]) return;
          this.pushEv(sid, 'update', { bundled: [{ sessionId: sid, update: { sessionUpdate: 'usage_update', used: 12345, size: 200000 } }] });
          this.pushEv(sid, 'notification', { method: '_cognition.ai/agent_stopped', params: { sessionId: sid } });
          this.running[sid] = false;
        }, delay + chunks.length * 250);
        await sleep(delay + chunks.length * 250 + 50);
        return { stopReason: this.running[sid] ? 'end_turn' : 'cancelled', usage: { totalTokens: 12345 } };
      }
      case '_bridge/session/cancel':
        this.running[p.sessionId] = false;
        return { cancelled: true };
      case '_bridge/session/set_mode':
        this.currentMode[p.sessionId] = p.modeId;
        this.pushEv(p.sessionId, 'update', { bundled: [{ sessionId: p.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: p.modeId } }] });
        return {};
      case '_bridge/session/set_config_option': {
        const o = this.cfg.find((x) => x.id === p.configId);
        if (o) o.currentValue = p.value;
        this.pushEv(p.sessionId, 'update', { bundled: [{ sessionId: p.sessionId, update: { sessionUpdate: 'config_option_update', configOptions: this.cfg } }] });
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

// ================= App =================

const state = {
  transport: null,
  lastEventId: 0,
  splitBuf: new Map(),
  sessions: new Map(), // sid -> sess object
  currentSid: null,
  pendingPerm: [], // {rpcId, sessionId, options, title}
  listTimer: null,
  online: false,
  daemonOk: false,
  started: false,
  searchTimer: null,
};

const sess = (sid) => state.sessions.get(sid);

function newSessObj(meta = {}) {
  return {
    meta,
    modes: null,
    configOptions: [],
    msgs: [], // {type:'user'|'agent'|'thought'|'tool'|'note', text, tool?}
    plan: [],
    usage: null,
    commands: [],
    running: false,
    loaded: false,
    title: meta.title || '',
  };
}

// ---------- Update-Verarbeitung ----------

function applyUpdate(sid, p) {
  const s = state.sessions.get(sid) || state.sessions.set(sid, newSessObj()).get(sid);
  const u = p.update || {};
  switch (u.sessionUpdate) {
    case 'user_message_chunk': {
      const last = s.msgs[s.msgs.length - 1];
      if (last?.type === 'user' && !last.done) last.text += u.content?.text || '';
      else s.msgs.push({ type: 'user', text: u.content?.text || '' });
      break;
    }
    case 'agent_message_chunk': {
      const last = s.msgs[s.msgs.length - 1];
      if (last?.type === 'agent' && !last.done) last.text += u.content?.text || '';
      else s.msgs.push({ type: 'agent', text: u.content?.text || '' });
      break;
    }
    case 'agent_thought_chunk': {
      const last = s.msgs[s.msgs.length - 1];
      if (last?.type === 'thought' && !last.done) last.text += u.content?.text || '';
      else s.msgs.push({ type: 'thought', text: u.content?.text || '' });
      break;
    }
    case 'tool_call': {
      s.msgs.push({
        type: 'tool',
        toolCallId: u.toolCallId,
        title: u.title || u.kind || 'Werkzeug',
        kind: u.kind,
        status: u.status,
        locations: u.locations,
        rawInput: u.rawInput,
        content: u.content,
      });
      break;
    }
    case 'tool_call_update': {
      const t = s.msgs.find((m) => m.type === 'tool' && m.toolCallId === u.toolCallId);
      if (t) Object.assign(t, { title: u.title || t.title, status: u.status || t.status, content: u.content ?? t.content, locations: u.locations ?? t.locations });
      break;
    }
    case 'plan':
      s.plan = u.entries || [];
      break;
    case 'usage_update':
      s.usage = { used: u.used, size: u.size };
      break;
    case 'available_commands_update':
      s.commands = u.availableCommands || [];
      break;
    case 'config_option_update':
      s.configOptions = u.configOptions || s.configOptions;
      break;
    case 'current_mode_update':
      if (s.modes) s.modes.currentModeId = u.currentModeId;
      else s.modes = { currentModeId: u.currentModeId, availableModes: [] };
      break;
    case 'session_info_update':
      if (u.title) s.title = u.title;
      break;
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
    case 'update': {
      const items = p.bundled || [p];
      let headerDirty = false;
      for (const u of items) {
        const usid = u.sessionId || e.session_id;
        applyUpdate(usid, u);
        if (usid === state.currentSid && /mode_update|config_option_update/.test(u.update?.sessionUpdate || '')) headerDirty = true;
      }
      if (headerDirty) renderSessionHeader();
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
    case 'notification': {
      if (p.method === '_cognition.ai/agent_stopped') {
        const s = sess(e.session_id);
        if (s) { s.running = false; s.msgs.forEach((m) => (m.done = true)); }
      }
      if (p.method === '_cognition.ai/output') {
        const s = sess(e.session_id);
        if (s && p.params?.text) s.msgs.push({ type: 'note', text: p.params.text });
      }
      if (p.method?.startsWith('_cognition.ai/mcp/')) {
        const url = p.params?.url || p.params?.authUrl || p.params?.authorizationUrl;
        if (url && e.session_id) {
          const s = sess(e.session_id);
          if (s) s.msgs.push({ type: 'note', text: `MCP-Anmeldung erforderlich – am PC bestätigen oder öffnen: ${url}` });
        }
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
  }
}

// ---------- Render ----------

function renderMsg(m) {
  const d = document.createElement('div');
  if (m.type === 'user') {
    d.className = 'msg user';
    d.innerHTML = `<div class="bubble">${esc(m.text)}</div>`;
  } else if (m.type === 'agent') {
    d.className = 'msg agent';
    d.innerHTML = `<div class="bubble md">${md(m.text)}</div>`;
    addCopyButtons(d);
  } else if (m.type === 'thought') {
    d.className = 'msg thought';
    d.innerHTML = `<details class="thought-box"><summary>Gedanken</summary><div>${esc(m.text)}</div></details>`;
  } else if (m.type === 'tool') {
    d.className = 'msg tool';
    const loc = (m.locations || []).map((l) => l.path).join(', ');
    const out = (m.content || []).map((c) => c.content?.text || c.text || '').join('\n');
    const diff = (m.content || []).find((c) => c.type === 'diff');
    d.innerHTML = `<details class="tool-card ${m.status === 'in_progress' ? 'running' : ''}">
      <summary><span class="tool-kind">${esc(m.kind || 'tool')}</span> ${esc(m.title)} <span class="tool-status">${esc(m.status || '')}</span></summary>
      ${loc ? `<div class="tool-path">${esc(loc)}</div>` : ''}
      ${diff ? `<pre class="diff">${esc(diff.newText || diff.diff || '')}</pre>` : ''}
      ${out ? `<pre class="tool-out">${esc(out.slice(0, 4000))}</pre>` : ''}
    </details>`;
  } else {
    d.className = 'msg note';
    d.innerHTML = `<div class="note-box">${esc(m.text)}</div>`;
  }
  return d;
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

function renderTranscript() {
  const s = sess(state.currentSid);
  const box = $('#transcript');
  if (!s) { box.innerHTML = ''; return; }
  box.innerHTML = '';
  for (const m of s.msgs) box.appendChild(renderMsg(m));
  if (s.running) {
    const t = document.createElement('div');
    t.className = 'msg running-hint';
    t.textContent = 'Devin arbeitet …';
    box.appendChild(t);
  }
  renderPlan(s);
  renderUsage(s);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function renderPlan(s) {
  const box = $('#plan-box');
  if (!s.plan?.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="plan-title">Plan</div>` + s.plan.map((e) =>
    `<div class="plan-entry ${esc(e.status || '')}">${e.status === 'completed' ? '☑' : e.status === 'in_progress' ? '▶' : '☐'} ${esc(e.content || e.title || '')}</div>`
  ).join('');
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
  // Modus
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

function openModelSheet(o) {
  const sh = $('#model-sheet');
  sh.hidden = false;
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

async function refreshSessionList() {
  const q = $('#search').value.trim();
  const orderBy = $('#sort-sel').value || 'updated_at';
  let data;
  try {
    data = await rpcCall('_bridge/session/list', { query: q || undefined, orderBy, sortDirection: 'desc' });
  } catch (e) {
    $('#sess-list').innerHTML = `<div class="empty">Fehler: ${esc(e.message)}</div>`;
    return;
  }
  const groups = new Map();
  for (const s of data.sessions || []) {
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

async function openSession(meta) {
  const sid = meta.sessionId;
  if (!state.sessions.has(sid)) state.sessions.set(sid, newSessObj(meta));
  const s = sess(sid);
  s.meta = { ...s.meta, ...meta };
  s.title = s.title || meta.title || sid;
  state.currentSid = sid;
  showSession();
  $('#transcript').innerHTML = '<div class="empty">Lade Sitzung …</div>';
  // Cursor auf den aktuellen Endstand setzen: session/load streamt das Replay
  // frisch – alte Events anderer Sitzungen würden den Poll nur ausbremsen.
  try { state.lastEventId = Math.max(state.lastEventId, await state.transport.latestEventId()); } catch {}
  try {
    const r = await rpcCall('_bridge/session/load', { sessionId: sid, cwd: meta.cwd, additionalDirectories: meta.additionalDirectories });
    s.modes = r.modes;
    s.configOptions = r.configOptions || [];
    s.meta._meta = { ...s.meta._meta, ...r._meta };
    s.loaded = true;
    renderSessionHeader();
    renderTranscript();
  } catch (e) {
    $('#transcript').innerHTML = `<div class="empty error">${esc(e.message)}${/already open|locked/i.test(e.message) ? '<br>Sitzung ist auf dem PC geöffnet.' : ''}</div>`;
  }
}

async function newSession() {
  const cwds = [...new Set([...(await rpcCall('_bridge/session/list', {}).catch(() => ({ sessions: [] }))).sessions.map((s) => s.cwd)])];
  const sh = $('#new-sheet');
  sh.hidden = false;
  const dl = $('#cwd-list');
  dl.innerHTML = cwds.map((c) => `<option value="${esc(c)}">`).join('');
  $('#cwd-input').value = cwds[0] || '';
  $('#dirs-input').value = '';
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
  renderTranscript();
  updateSendBtn();
  try {
    const r = await rpcCall('_bridge/session/prompt', { sessionId: state.currentSid, prompt: blocks });
    s.running = false;
    s.msgs.forEach((m) => (m.done = true));
  } catch (e) {
    s.running = false;
    s.msgs.push({ type: 'note', text: 'Fehler: ' + e.message });
  }
  renderTranscript();
  updateSendBtn();
}

async function cancel() {
  if (!state.currentSid) return;
  await rpcCall('_bridge/session/cancel', { sessionId: state.currentSid }).catch(showErr);
  const s = sess(state.currentSid);
  if (s) s.running = false;
  renderTranscript();
  updateSendBtn();
}

function updateSendBtn() {
  const s = sess(state.currentSid);
  $('#send-btn').hidden = !!s?.running;
  $('#cancel-btn').hidden = !s?.running;
}

// ---------- Slash-Autocomplete ----------

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
  $('#img-input').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      state.pendingImage = { data: r.result.split(',')[1], mime: f.type };
      $('#img-chip').hidden = false;
    };
    r.readAsDataURL(f);
  };
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
  try {
    const rows = await state.transport.pollEvents(state.lastEventId);
    for (const e of rows) {
      state.lastEventId = Math.max(state.lastEventId, e.id);
      applyEvent(e);
    }
    if (rows.length) { renderTranscript(); refreshSessionListDebounced(); }
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

// ---------- Views ----------

function showList() {
  $('#view-session').hidden = true;
  $('#view-list').hidden = false;
  state.currentSid = null;
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
  // aal2 erzwingen: Faktor verifizieren oder einrichten
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
    // vorhandene unverifizierte Faktoren entfernen
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
  setInterval(pollStatus, STATUS_POLL_MS);
  state.transport.latestEventId?.().then((id) => { state.lastEventId = Math.max(state.lastEventId, id); }).catch(() => {});
  setInterval(pollEvents, EVENTS_POLL_MS);
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && state.started) {
      await pollEvents();
      if (state.currentSid) {
        const s = sess(state.currentSid);
        const meta = s?.meta;
        if (meta) { s.msgs = []; openSession(meta); }
      }
    }
  });
  window.addEventListener('focus', pollEvents);
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

  if (MOCK) {
    const fixture = await (await fetch('mock-replay.json')).json();
    state.transport = new MockTransport(fixture);
    window.devinRemote = { state, rpcCall, sess, applyEvent, refreshSessionList };
    return;
  }
  state.transport = new SupaTransport();
  window.devinRemote = { state, rpcCall, sess, applyEvent, refreshSessionList };
  const { data } = await state.transport.session();
  if (data.session) {
    try { await afterPassword(); } catch { /* MFA-Flow zeigt sich bei Bedarf */ }
  }
}

boot();
