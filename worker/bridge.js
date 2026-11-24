import { hostname } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Bundler, splitPayload, tail } from './lib.js';
import { SessionCache, entryHash } from './transcript.js';

export const BRIDGE_VERSION = '1.1.0';
const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120000;
const LOAD_TIMEOUT_MS = 15 * 60 * 1000;
const WATCH_TTL_MS = 30 * 60 * 1000;
const FS_MAX_DIRS = 500;
const FS_HIDDEN = new Set([
  'system volume information', '$recycle.bin', 'recycler', 'recovery',
  'config.msi', 'documents and settings', 'msocache',
]);

// Kernlogik der Bridge: poll rpc, dispatche _bridge/* auf acp,
// pflegt pro Sitzung einen kompakten SessionCache (transcript.js)
// und streamt nur fuer beobachtete (watched) Sitzungen kompakte
// Live-Events nach Supabase. Alles ueber die Store-Schnittstelle,
// damit sie mit MemoryStore oder einem Fake-Acp getestet werden kann.
export class Bridge {
  constructor({ store, acp, ownerId, log = () => {}, bundlerOpts = {}, fsHome, now = () => Date.now() }) {
    this.store = store;
    this.acp = acp;
    this.ownerId = ownerId;
    this.log = log;
    this.now = now;
    this.hostname = hostname();
    this.fsHome = fsHome || process.env.USERPROFILE || 'C:\\Users\\HenriB';
    this.pendingAgent = new Map(); // rpcId -> agent request
    this.caches = new Map(); // sid -> SessionCache
    this.loading = new Map(); // sid -> laufendes session/load
    this.watched = new Map(); // sid -> {since, detail}
    this.busy = new Set(); // sids mit laufendem Remote-Prompt
    this.liveBundler = new Bundler({
      windowMs: 400,
      maxBytes: 8192,
      ...bundlerOpts,
      onFlush: (key, ops) => this._emit('live', key, { ops }),
    });
    if (acp) this._wire(acp);
  }

  _wire(acp) {
    acp.on('update', (p) => {
      const sid = p?.sessionId;
      const cache = sid && this.caches.get(sid);
      if (!cache) return; // nur Sessions, die wir geladen haben
      const ops = cache.applyUpdate(p);
      this._live(sid, ops);
    });
    acp.on('notification', (n) => {
      const sid = n.params?.sessionId;
      const cache = sid && this.caches.get(sid);
      const ops = cache ? cache.applyNotification(n.method, n.params) : [];
      this._live(sid, ops);
    });
    acp.on('request', (req) => {
      this.pendingAgent.set(req.rpcId, req);
      this._emit('request', req.params?.sessionId || null, {
        rpcId: req.rpcId,
        method: req.method,
        params: req.params,
      });
    });
    acp.on('exit', ({ code }) => {
      this.log(`acp beendet (code ${code}) – Daemon offline. Caches verworfen.`);
      this.caches.clear();
      this.watched.clear();
      this.busy.clear();
      for (const [, req] of this.pendingAgent) {
        req.respond({ error: { code: -32000, message: 'acp exited' } });
      }
      this.pendingAgent.clear();
    });
  }

  // Ops in den Live-Strom geben (nur watched, detail-abhaengig gefiltert,
  // nicht waehrend des Replays – das Ergebnis kommt per open-RPC).
  _live(sid, ops) {
    const w = this.watched.get(sid);
    const cache = this.caches.get(sid);
    if (!w || !ops?.length || cache?.replaying) return;
    for (const raw of ops) {
      let op = raw;
      if (!w.detail && op.role === 'thought') continue;
      if (!w.detail && op.role === 'steps') op = { type: 'msg', i: op.i, role: 'steps', n: op.n };
      this.liveBundler.add(sid, op);
    }
  }

  watch(sid, detail) {
    this.watched.set(sid, { since: this.now(), detail: !!detail });
  }

  touchWatch(sid) {
    const w = this.watched.get(sid);
    if (w) w.since = this.now();
  }

  pruneWatched() {
    for (const [sid, w] of this.watched) {
      if (this.busy.has(sid)) continue;
      if (this.now() - w.since > WATCH_TTL_MS) {
        this.watched.delete(sid);
        this.log(`watch TTL abgelaufen: ${sid}`);
      }
    }
  }

  // Payload ggfs. splitten und einfuegen (Fehler nur loggen – Strom darf nicht reissen).
  _emit(kind, sessionId, payload) {
    const rows = splitPayload(payload).map((p) => ({ session_id: sessionId, kind, payload: p }));
    this.store.insertEvents(rows).catch((e) => this.log(`events insert fehlgeschlagen: ${e.message}`));
  }

  async flush() {
    this.liveBundler.flushAll();
  }

  _openResult(sid, p) {
    const cache = this.caches.get(sid);
    const detail = !!p.detail;
    const limit = Math.max(1, p.limit || 20);
    let messages;
    let reset = true;
    if (!p.force && cache.matchSince(p.since)) {
      reset = false;
      messages = cache.fromIndex(p.since.count - 1, detail); // letzte Nachricht erneut (kann noch wachsen)
    } else {
      messages = cache.tail(limit, detail);
    }
    // Riesige Optionslisten (Modell-Picker, ~300 KB) werden lazy:
    // nur Metadaten senden, volle Liste holt das Frontend bei Bedarf.
    const configOptions = (cache.configOptions || []).map((o) =>
      JSON.stringify(o.options || []).length > 20000 ? { ...o, options: [], _meta: { ...o._meta, lazy: true } } : o,
    );
    return {
      sessionId: sid,
      // Bei Delta-Antworten (reset:false) werden Metadaten weggelassen –
      // das Frontend behaelt seinen Cache, Aenderungen kommen per Live-Op.
      ...(reset
        ? { modes: cache.modes, configOptions, commands: cache.commands }
        : {}),
      usage: cache.usage,
      title: cache.title,
      running: cache.running,
      status: { steps: cache.stepsSinceUser, plan: cache.currentPlan() },
      meta: cache.meta,
      total: cache.entries.length,
      reset,
      messages,
    };
  }

  methods() {
    return {
      '_bridge/ping': async () => ({
        pong: true,
        version: BRIDGE_VERSION,
        hostname: this.hostname,
        daemon_ok: !!this.acp?.alive,
        watched: this.watched.size,
      }),
      '_bridge/session/list': async (p = {}) => {
        const params = {};
        for (const k of ['cwd', 'query', 'orderBy', 'sortDirection']) if (p[k] !== undefined) params[k] = p[k];
        const r = await this.acp.request('session/list', params, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result;
      },
      '_bridge/session/new': async (p) => {
        const params = { cwd: p.cwd, mcpServers: [] };
        if (p.additionalDirectories) params.additionalDirectories = p.additionalDirectories;
        const r = await this.acp.request('session/new', params, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        const cache = new SessionCache(r.result.sessionId);
        cache.applyLoadResult(r.result);
        this.caches.set(r.result.sessionId, cache);
        return r.result;
      },
      // Sitzung oeffnen: Cache laden falls noetig, dann Delta oder Tail liefern.
      // Parallele opens auf dieselbe ungeladene Sitzung warten auf dasselbe load.
      '_bridge/session/open': async (p) => {
        const sid = p.sessionId;
        while (this.loading.has(sid)) await this.loading.get(sid);
        if (p.force) this.caches.delete(sid);
        if (!this.caches.has(sid)) {
          const cache = new SessionCache(sid);
          cache.replaying = true;
          this.caches.set(sid, cache);
          const params = { sessionId: sid, cwd: p.cwd, mcpServers: [] };
          if (p.additionalDirectories) params.additionalDirectories = p.additionalDirectories;
          const lp = this.acp.request('session/load', params, LOAD_TIMEOUT_MS).then((r) => {
            this.loading.delete(sid);
            cache.replaying = false;
            if (r.error) {
              this.caches.delete(sid);
              throw new AcpError(r.error);
            }
            cache.applyLoadResult(r.result);
          }, (e) => {
            this.loading.delete(sid);
            cache.replaying = false;
            this.caches.delete(sid);
            throw e;
          });
          this.loading.set(sid, lp);
          await lp;
        }
        this.watch(sid, p.detail);
        return this._openResult(sid, p);
      },
      '_bridge/session/history': async (p) => {
        if (this.loading.has(p.sessionId)) await this.loading.get(p.sessionId);
        const cache = this.caches.get(p.sessionId);
        if (!cache) throw new Error('Sitzung ist nicht geladen – erst oeffnen.');
        this.touchWatch(p.sessionId);
        return cache.history(p.before ?? Number.MAX_SAFE_INTEGER, p.limit || 30, !!p.detail);
      },
      '_bridge/session/unwatch': async (p) => {
        this.watched.delete(p.sessionId);
        return {};
      },
      '_bridge/session/load': async (p) => {
        // Legacy: volles Replay ohne Cache-Filter (Frontend nutzt open).
        const params = { sessionId: p.sessionId, cwd: p.cwd, mcpServers: [] };
        if (p.additionalDirectories) params.additionalDirectories = p.additionalDirectories;
        const r = await this.acp.request('session/load', params, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result;
      },
      '_bridge/session/close': async (p) => {
        const r = await this.acp.request('session/close', { sessionId: p.sessionId }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        this.watched.delete(p.sessionId);
        this.caches.delete(p.sessionId);
        return r.result || {};
      },
      '_bridge/session/delete': async (p) => {
        const r = await this.acp.request('session/delete', { sessionId: p.sessionId }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        this.watched.delete(p.sessionId);
        this.caches.delete(p.sessionId);
        return r.result || {};
      },
      '_bridge/session/rename': async (p) => {
        const r = await this.acp.request('_cognition.ai/session/rename', { sessionId: p.sessionId, title: p.title }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result || {};
      },
      '_bridge/session/prompt': async (p) => {
        const sid = p.sessionId;
        const cache = this.caches.get(sid);
        if (cache) cache.setRunning(true).forEach((op) => this._live(sid, [op]));
        this.busy.add(sid);
        this.touchWatch(sid);
        try {
          const r = await this.acp.request('session/prompt', { sessionId: sid, prompt: p.prompt }, PROMPT_TIMEOUT_MS);
          if (r.error) throw new AcpError(r.error);
          return r.result;
        } finally {
          this.busy.delete(sid);
          if (cache) cache.setRunning(false).forEach((op) => this._live(sid, [op]));
        }
      },
      '_bridge/session/cancel': async (p) => {
        this.acp.notify('session/cancel', { sessionId: p.sessionId });
        const cache = this.caches.get(p.sessionId);
        if (cache) cache.setRunning(false).forEach((op) => this._live(p.sessionId, [op]));
        return { cancelled: true };
      },
      '_bridge/session/set_mode': async (p) => {
        const r = await this.acp.request('session/set_mode', { sessionId: p.sessionId, modeId: p.modeId }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        this.touchWatch(p.sessionId);
        return r.result || {};
      },
      '_bridge/session/set_config_option': async (p) => {
        const r = await this.acp.request('session/set_config_option', { sessionId: p.sessionId, configId: p.configId, value: p.value }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        this.touchWatch(p.sessionId);
        return r.result;
      },
      '_bridge/session/defaultConfigOptions': async (p = {}) => {
        const r = await this.acp.request('_cognition.ai/session/defaultConfigOptions', { cwd: p.cwd || 'C:\\' }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result;
      },
      '_bridge/fs/list': async (p = {}) => this._fsList(p),
      '_bridge/respond': async (p) => {
        const req = this.pendingAgent.get(p.rpcId);
        if (!req) throw new Error(`kein offener Request ${p.rpcId}`);
        this.pendingAgent.delete(p.rpcId);
        req.respond(p.response);
        this._emit('bridge', req.params?.sessionId || null, {
          type: 'request_answered',
          rpcId: p.rpcId,
          response: p.response,
        });
        return {};
      },
    };
  }

  _fsList(p) {
    if (!p.path) {
      // Roots: Profil, Desktop, Projects/Projekte + vorhandene Laufwerke.
      const roots = [];
      for (const d of [this.fsHome, join(this.fsHome, 'Desktop'), join(this.fsHome, 'Projects'), join(this.fsHome, 'Projekte')]) {
        try {
          if (statSync(d).isDirectory()) roots.push(d);
        } catch {}
      }
      for (let c = 67; c <= 90; c++) {
        const d = `${String.fromCharCode(c)}:\\`;
        try {
          statSync(d);
          if (!roots.includes(d)) roots.push(d);
        } catch {}
      }
      return { path: null, parent: null, dirs: roots, truncated: false };
    }
    const path = p.path;
    if (!/^[a-zA-Z]:[\\/]/.test(path)) throw new Error('Pfad muss absolut sein (z. B. C:\\…).');
    let ents;
    try {
      ents = readdirSync(path, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') throw new Error('Ordner existiert nicht.');
      if (e.code === 'EPERM' || e.code === 'EACCES') throw new Error('Kein Zugriff auf diesen Ordner.');
      throw new Error(`Ordner nicht lesbar: ${e.message}`);
    }
    const dirs = ents
      .filter((e) => {
        if (!e.isDirectory()) return false;
        const n = e.name.toLowerCase();
        return !e.name.startsWith('.') && !e.name.startsWith('$') && !FS_HIDDEN.has(n);
      })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    const parent = dirname(path);
    return {
      path,
      parent: parent === path ? null : parent,
      dirs: dirs.slice(0, FS_MAX_DIRS),
      truncated: dirs.length > FS_MAX_DIRS,
    };
  }

  // Rueckgabe false bei Poll-Fehler (Backoff obliegt dem Aufrufer).
  async tick() {
    let rows;
    try {
      rows = await this.store.pollPendingRpc();
    } catch {
      return false;
    }
    this.pruneWatched();
    for (const row of rows) {
      let claimed;
      try {
        claimed = await this.store.claimRpc(row.id);
      } catch (e) {
        this.log(`rpc claim fehlgeschlagen: ${e.message}`);
        continue;
      }
      if (!claimed) continue;
      this.log(`rpc ${row.method} (${row.id.slice(0, 8)})`);
      this._handle(row).catch((e) => this.log(`rpc handler Fehler: ${e.message}`));
    }
    return true;
  }

  async _handle(row) {
    const fn = this.methods()[row.method];
    if (!fn) {
      await this.store
        .finishRpc(row.id, { error: { code: -32601, message: `unbekannte Methode ${row.method}` } })
        .catch((e) => this.log(`finishRpc fehlgeschlagen: ${e.message}`));
      return;
    }
    try {
      const result = await fn(row.params || {});
      await this.store.finishRpc(row.id, { result });
      this.log(`rpc ${row.method} done`);
    } catch (e) {
      const err = e instanceof AcpError ? e.acpError : { code: -32000, message: tail(e.message, 300) };
      await this.store.finishRpc(row.id, { error: err }).catch((e2) => this.log(`finishRpc fehlgeschlagen: ${e2.message}`));
      this.log(`rpc ${row.method} error: ${err.message}`);
    }
  }

  async heartbeat() {
    try {
      await this.store.upsertStatus({
        hostname: this.hostname,
        daemon_ok: !!this.acp?.alive,
        version: BRIDGE_VERSION,
      });
    } catch (e) {
      this.log(`bridge_status fehlgeschlagen: ${e.message}`);
    }
  }

  async cleanup() {
    try {
      const r = await this.store.cleanup();
      if (r) this.log(`cleanup: ${r.events} events, ${r.rpc} rpc geloescht.`);
    } catch (e) {
      this.log(`cleanup fehlgeschlagen: ${e.message}`);
    }
  }
}

export class AcpError extends Error {
  constructor(acpError) {
    super(acpError.message || 'acp error');
    this.acpError = acpError;
  }
}

export { entryHash };
