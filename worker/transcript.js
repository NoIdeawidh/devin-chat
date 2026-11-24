// SessionCache: kompaktes Transkript pro ACP-Sitzung, aufgebaut aus
// session/update-Events (Replay + Live-Broadcast). Die Eintraege tragen
// einen globalen Index `i`; detail:false filtert beim Versand
// (steps ohne Titel, thoughts weg) – die Indices bleiben stabil.
//
// Entry-Formen:
//   {i, role:'user'|'agent'|'thought', text}   – Chunks gleicher Rolle mergen
//   {i, role:'steps', n, titles:[…]}           – Tool-Aufrufe zwischen Texten

// FNV-1a (32 Bit) ueber "role|text|n" – identisch in docs/app.js (msgHash).
// Test-Vektor: hash({role:'agent',text:'ok'}) === 'e940603c'.
export function entryHash(e) {
  const s = `${e.role}|${e.text ?? ''}|${e.n ?? ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export class SessionCache {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.entries = [];
    this.toolIndex = new Map(); // toolCallId -> {entry, idx}
    this.running = false;
    this.stepsSinceUser = 0;
    this.planEntries = [];
    this.usage = null;
    this.title = null;
    this.commands = [];
    this.modes = null;
    this.configOptions = [];
    this.meta = {};
    this.lastActivity = 0;
    this.replaying = false;
  }

  _push(entry) {
    entry.i = this.entries.length;
    this.entries.push(entry);
    return entry;
  }

  // `at` = Textlaenge vor dem Append – macht Ops idempotent (Duplikate
  // skippen, Luecken loesen clientseitig einen Resync aus).
  _textChunk(role, text) {
    const last = this.entries.at(-1);
    if (last?.role === role) {
      const at = last.text.length;
      last.text += text;
      return { type: 'msg', i: last.i, role, at, append: text };
    }
    const e = this._push({ role, text });
    return { type: 'msg', i: e.i, role, at: 0, append: text };
  }

  _stepsOp(e, detail) {
    return { type: 'msg', i: e.i, role: 'steps', n: e.n, titles: detail ? e.titles : undefined };
  }

  currentPlan() {
    const cur = (this.planEntries || []).find((e) => e.status === 'in_progress');
    return cur?.content || cur?.title || null;
  }

  statusOp() {
    return { type: 'status', running: this.running, steps: this.stepsSinceUser, plan: this.currentPlan() };
  }

  // ACP session/update anwenden -> kompakte Ops fuer den Live-Strom.
  applyUpdate(p) {
    const u = p.update || {};
    this.lastActivity = Date.now();
    const ops = [];
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        this.stepsSinceUser = 0;
        ops.push(this._textChunk('user', u.content?.text || ''));
        break;
      }
      case 'agent_message_chunk': {
        ops.push(this._textChunk('agent', u.content?.text || ''));
        break;
      }
      case 'agent_thought_chunk': {
        ops.push(this._textChunk('thought', u.content?.text || ''));
        break;
      }
      case 'tool_call': {
        this.stepsSinceUser++;
        const title = u.title || u.kind || 'Werkzeug';
        const last = this.entries.at(-1);
        let e;
        if (last?.role === 'steps') {
          e = last;
          e.n++;
          e.titles.push(title);
        } else {
          e = this._push({ role: 'steps', n: 1, titles: [title] });
        }
        if (u.toolCallId) this.toolIndex.set(u.toolCallId, { entry: e.i, idx: e.titles.length - 1 });
        ops.push({ type: 'msg', i: e.i, role: 'steps', n: e.n, titles: e.titles });
        ops.push(this.statusOp());
        break;
      }
      case 'tool_call_update': {
        const ref = u.toolCallId ? this.toolIndex.get(u.toolCallId) : null;
        if (ref && u.title) {
          const e = this.entries[ref.entry];
          if (e) {
            e.titles[ref.idx] = u.title;
            ops.push({ type: 'msg', i: e.i, role: 'steps', n: e.n, titles: e.titles });
          }
        }
        break;
      }
      case 'plan':
        this.planEntries = u.entries || [];
        ops.push(this.statusOp());
        break;
      case 'usage_update':
        this.usage = { used: u.used, size: u.size };
        ops.push({ type: 'usage', used: u.used, size: u.size });
        break;
      case 'available_commands_update':
        this.commands = u.availableCommands || [];
        ops.push({ type: 'commands', commands: this.commands });
        break;
      case 'config_option_update':
        this.configOptions = u.configOptions || this.configOptions;
        ops.push({ type: 'config', configOptions: this.configOptions });
        break;
      case 'current_mode_update':
        if (this.modes) this.modes.currentModeId = u.currentModeId;
        else this.modes = { currentModeId: u.currentModeId, availableModes: [] };
        ops.push({ type: 'mode', currentModeId: u.currentModeId });
        break;
      case 'session_info_update':
        if (u.title) {
          this.title = u.title;
          ops.push({ type: 'title', title: u.title });
        }
        break;
    }
    return ops;
  }

  // ACP-Notifications (_cognition.ai/*) -> Ops.
  applyNotification(method, params = {}) {
    this.lastActivity = Date.now();
    if (method === '_cognition.ai/agent_stopped') {
      if (!this.running) return [];
      this.running = false;
      return [this.statusOp()];
    }
    if (method.startsWith('_cognition.ai/mcp/')) {
      const url = params.url || params.authUrl || params.authorizationUrl;
      if (url) return [{ type: 'note', text: `MCP-Anmeldung erforderlich – am PC bestätigen oder öffnen: ${url}` }];
      return [];
    }
    if (method === '_cognition.ai/output') {
      return params.text ? [{ type: 'note', text: params.text }] : [];
    }
    return [];
  }

  setRunning(v) {
    if (this.running === v) return [];
    this.running = v;
    return [this.statusOp()];
  }

  applyLoadResult(r = {}) {
    this.modes = r.modes || this.modes;
    this.configOptions = r.configOptions || this.configOptions;
    this.meta = { ...this.meta, ...(r._meta || {}) };
  }

  // Gefilterte Sicht: detail=true liefert alles (thoughts + step-Titel),
  // detail=false nur user/agent plus steps als reine Zaehler.
  view(detail) {
    return this.entries
      .filter((e) => detail || e.role !== 'thought')
      .map((e) => {
        if (e.role === 'steps' && !detail) return { i: e.i, role: 'steps', n: e.n };
        const c = { i: e.i, role: e.role };
        if (e.text !== undefined) c.text = e.text;
        if (e.n !== undefined) c.n = e.n;
        if (detail && e.titles) c.titles = e.titles;
        return c;
      });
  }

  matchSince(since) {
    if (!since || !Number.isInteger(since.count)) return false;
    const e = this.entries[since.count - 1];
    return !!e && entryHash(e) === since.hash;
  }

  // Gefilterte Eintraege ab globalem Index fromI (inkl.).
  fromIndex(fromI, detail) {
    return this.view(detail).filter((e) => e.i >= fromI);
  }

  // Letzte `limit` Eintraege der gefilterten Sicht.
  tail(limit, detail) {
    const v = this.view(detail);
    return v.slice(-Math.max(1, limit));
  }

  // `limit` gefilterte Eintraege vor globalem Index `before`.
  history(before, limit, detail) {
    const v = this.view(detail).filter((e) => e.i < before);
    const slice = v.slice(-Math.max(1, limit));
    return { messages: slice, hasMore: v.length > slice.length };
  }
}
