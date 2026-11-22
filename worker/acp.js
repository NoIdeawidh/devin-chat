import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { buildSpawnEnv, tail } from './lib.js';

const DEFAULT_DEVIN =
  'C:\\Users\\HenriB\\AppData\\Local\\Programs\\Devin\\resources\\app\\extensions\\windsurf\\devin\\bin\\devin.exe';

// JSON-RPC-Client fuer `devin acp` (eine Nachricht pro Zeile ueber stdio).
// Events: 'update' {sessionId, update} | 'notification' {method, params} |
// 'request' {rpcId, method, params, respond} | 'exit' {code}
export class AcpClient extends EventEmitter {
  constructor({ bin = process.env.DEVIN_BIN || DEFAULT_DEVIN, cwd, env, log = () => {}, initTimeout = 60000 } = {}) {
    super();
    this.bin = bin;
    this.cwd = cwd || process.cwd();
    this.env = env || buildSpawnEnv();
    this.log = log;
    this.initTimeout = initTimeout;
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map(); // jsonrpc id -> {resolve, timer}
    this.agentRequests = new Map(); // rpcId -> {id, method, params}
    this.ready = false;
    this.stopped = false;
  }

  get alive() {
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  async start() {
    this.stopped = false;
    this.child = spawn(this.bin, ['acp'], {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.buf = '';
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (d) => this.log(`acp stderr: ${tail(String(d), 200)}`));
    this.child.on('exit', (code) => {
      this.ready = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ error: { code: -32000, message: `acp exited (${code})` } });
        this.pending.delete(id);
      }
      this.emit('exit', { code });
    });
    this.child.on('error', (e) => this.log(`acp spawn error: ${e.message}`));
    const r = await this.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'devin-remote-bridge', version: '1.0.0' },
      },
      this.initTimeout
    );
    if (r.error) throw new Error(`initialize fehlgeschlagen: ${JSON.stringify(r.error)}`);
    this.ready = true;
    this.log('acp bereit (initialize ok).');
    return r.result;
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        this.log(`acp non-json: ${tail(line, 200)}`);
        continue;
      }
      this._onMessage(m);
    }
  }

  _onMessage(m) {
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
      return;
    }
    if (m.method && m.id !== undefined) {
      // Agent -> Client Request (z. B. session/request_permission)
      const rpcId = crypto.randomUUID();
      this.agentRequests.set(rpcId, m.id);
      const respond = (response) => {
        if (!this.alive) return;
        const msg =
          response && response.error
            ? { jsonrpc: '2.0', id: m.id, error: response.error }
            : { jsonrpc: '2.0', id: m.id, result: response };
        this.child.stdin.write(JSON.stringify(msg) + '\n');
        this.agentRequests.delete(rpcId);
      };
      this.emit('request', { rpcId, method: m.method, params: m.params, respond });
      return;
    }
    if (m.method === 'session/update') {
      this.emit('update', m.params);
      return;
    }
    if (m.method) {
      this.emit('notification', { method: m.method, params: m.params });
      return;
    }
    // Antwort auf Client -> Agent Request ohne pending (verspaetet) – ignorieren
  }

  request(method, params, timeoutMs = 120000) {
    return new Promise((resolve) => {
      if (!this.alive) return resolve({ error: { code: -32000, message: 'acp not running' } });
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ error: { code: -32000, message: `timeout ${method}` } });
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    if (!this.alive) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  kill() {
    this.stopped = true;
    if (this.child) this.child.kill();
  }
}
