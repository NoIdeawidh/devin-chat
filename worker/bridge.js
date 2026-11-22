import { hostname } from 'node:os';
import { Bundler, splitPayload, tail } from './lib.js';

export const BRIDGE_VERSION = '1.0.0';
const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120000;

// Kernlogik der Bridge: poll rpc, dispatche _bridge/* auf acp,
// streame ACP-Events in events. Alles ueber die Store-Schnittstelle,
// damit sie mit MemoryStore oder einem Fake-Acp getestet werden kann.
export class Bridge {
  constructor({ store, acp, ownerId, log = () => {}, bundlerOpts = {} }) {
    this.store = store;
    this.acp = acp;
    this.ownerId = ownerId;
    this.log = log;
    this.hostname = hostname();
    this.pendingAgent = new Map(); // rpcId -> agent request
    this.bundler = new Bundler({
      ...bundlerOpts,
      onFlush: (key, items) => this._emit('update', key, { bundled: items }),
    });
    if (acp) this._wire(acp);
  }

  _wire(acp) {
    acp.on('update', (p) => {
      const sid = p?.sessionId || null;
      this.bundler.add(sid, p);
    });
    acp.on('notification', (n) => {
      this._emit('notification', n.params?.sessionId || null, { method: n.method, params: n.params });
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
      this.log(`acp beendet (code ${code}) – Daemon offline.`);
      for (const [, req] of this.pendingAgent) {
        req.respond({ error: { code: -32000, message: 'acp exited' } });
      }
      this.pendingAgent.clear();
    });
  }

  // Payload ggfs. splitten und einfuegen (Fehler nur loggen – Strom darf nicht reissen).
  _emit(kind, sessionId, payload) {
    const rows = splitPayload(payload).map((p) => ({ session_id: sessionId, kind, payload: p }));
    this.store.insertEvents(rows).catch((e) => this.log(`events insert fehlgeschlagen: ${e.message}`));
  }

  async flush() {
    this.bundler.flushAll();
  }

  methods() {
    return {
      '_bridge/ping': async () => ({
        pong: true,
        version: BRIDGE_VERSION,
        hostname: this.hostname,
        daemon_ok: !!this.acp?.alive,
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
        return r.result;
      },
      '_bridge/session/load': async (p) => {
        const params = { sessionId: p.sessionId, cwd: p.cwd, mcpServers: [] };
        if (p.additionalDirectories) params.additionalDirectories = p.additionalDirectories;
        const r = await this.acp.request('session/load', params, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result;
      },
      '_bridge/session/close': async (p) => {
        const r = await this.acp.request('session/close', { sessionId: p.sessionId }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result || {};
      },
      '_bridge/session/delete': async (p) => {
        const r = await this.acp.request('session/delete', { sessionId: p.sessionId }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result || {};
      },
      '_bridge/session/rename': async (p) => {
        const r = await this.acp.request('_cognition.ai/session/rename', { sessionId: p.sessionId, title: p.title }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result || {};
      },
      '_bridge/session/prompt': async (p) => {
        const r = await this.acp.request('session/prompt', { sessionId: p.sessionId, prompt: p.prompt }, PROMPT_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result;
      },
      '_bridge/session/cancel': async (p) => {
        this.acp.notify('session/cancel', { sessionId: p.sessionId });
        return { cancelled: true };
      },
      '_bridge/session/set_mode': async (p) => {
        const r = await this.acp.request('session/set_mode', { sessionId: p.sessionId, modeId: p.modeId }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result || {};
      },
      '_bridge/session/set_config_option': async (p) => {
        const r = await this.acp.request('session/set_config_option', { sessionId: p.sessionId, configId: p.configId, value: p.value }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result;
      },
      '_bridge/session/defaultConfigOptions': async (p = {}) => {
        const r = await this.acp.request('_cognition.ai/session/defaultConfigOptions', { cwd: p.cwd || 'C:\\' }, REQUEST_TIMEOUT_MS);
        if (r.error) throw new AcpError(r.error);
        return r.result;
      },
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

  async tick() {
    let rows;
    try {
      rows = await this.store.pollPendingRpc();
    } catch (e) {
      this.log(`rpc poll fehlgeschlagen: ${e.message}`);
      return;
    }
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
