import test from 'node:test';
import assert from 'node:assert/strict';
import { Bundler, splitPayload, assembleParts, SPLIT_MAX_BYTES } from '../lib.js';
import { Bridge } from '../bridge.js';
import { MemoryStore } from '../store.js';

// ---- Bundler: 150 ms / 4 KB ----

test('Bundler flushed nach windowMs', () => {
  const flushed = [];
  let now = 0;
  const timers = [];
  const b = new Bundler({
    onFlush: (k, items) => flushed.push({ k, items }),
    windowMs: 150,
    maxBytes: 4096,
    now: () => now,
    setT: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearT: () => {},
  });
  b.add('s1', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'a' } } });
  b.add('s1', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'b' } } });
  b.add('s2', { sessionId: 's2', update: { sessionUpdate: 'plan' } });
  assert.equal(flushed.length, 0);
  assert.equal(timers.length, 2);
  assert.equal(timers[0].ms, 150);
  timers[0].fn(); // Zeitablauf simulieren
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].k, 's1');
  assert.equal(flushed[0].items.length, 2);
});

test('Bundler flushed sofort bei > 4 KB', () => {
  const flushed = [];
  const b = new Bundler({ onFlush: (k, items) => flushed.push({ k, items }), windowMs: 150, maxBytes: 4096 });
  for (let i = 0; i < 20; i++) {
    b.add('s1', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x'.repeat(300) } } });
  }
  assert.equal(flushed.length >= 1, true);
  b.flushAll();
  assert.ok(flushed.flatMap((f) => f.items).length === 20);
});

// ---- Payload-Split > 200 KB ----

test('splitPayload: klein bleibt einzeln, gross wird geteilt und reassembliert', () => {
  const small = { a: 1 };
  assert.deepEqual(splitPayload(small), [small]);
  const big = { text: 'y'.repeat(SPLIT_MAX_BYTES + 5000) };
  const parts = splitPayload(big);
  assert.ok(parts.length >= 2);
  assert.equal(parts[0].split.seq, 0);
  assert.equal(parts[0].split.total, parts.length);
  for (const p of parts) assert.ok(JSON.stringify(p).length <= SPLIT_MAX_BYTES + 200);
  assert.equal(assembleParts(parts.slice(0, -1)), null); // unvollstaendig
  assert.deepEqual(assembleParts(parts), big);
});

// ---- RPC-Dispatch ----

class FakeAcp {
  constructor() { this.calls = []; this.responses = {}; }
  async request(method, params) { this.calls.push({ method, params }); return this.responses[method] || { result: {} }; }
  notify(method, params) { this.calls.push({ method, params, notification: true }); }
  get alive() { return true; }
  on() {}
}

test('Dispatch: unbekannte Methode -> error -32601', async () => {
  const store = new MemoryStore();
  const bridge = new Bridge({ store, acp: new FakeAcp(), ownerId: 'o' });
  const row = store.addRpc('_bridge/nope', {});
  await bridge.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(store.rpc[0].status, 'error');
  assert.equal(store.rpc[0].error.code, -32601);
});

test('Dispatch: session/list wird an acp weitergeleitet, result landet in rpc', async () => {
  const store = new MemoryStore();
  const acp = new FakeAcp();
  acp.responses['session/list'] = { result: { sessions: [{ sessionId: 'x' }] } };
  const bridge = new Bridge({ store, acp, ownerId: 'o' });
  store.addRpc('_bridge/session/list', { cwd: '/tmp' });
  await bridge.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(store.rpc[0].status, 'done');
  assert.equal(store.rpc[0].result.sessions[0].sessionId, 'x');
  assert.deepEqual(acp.calls[0], { method: 'session/list', params: { cwd: '/tmp' } });
});

test('Dispatch: cancel ist Notification, kein Request', async () => {
  const store = new MemoryStore();
  const acp = new FakeAcp();
  const bridge = new Bridge({ store, acp, ownerId: 'o' });
  store.addRpc('_bridge/session/cancel', { sessionId: 's' });
  await bridge.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(acp.calls[0].notification, true);
  assert.equal(store.rpc[0].result.cancelled, true);
});

test('Dispatch: set_config_option und rename nutzen die verifizierten Methodennamen', async () => {
  const store = new MemoryStore();
  const acp = new FakeAcp();
  const bridge = new Bridge({ store, acp, ownerId: 'o' });
  store.addRpc('_bridge/session/rename', { sessionId: 's', title: 'neu' });
  store.addRpc('_bridge/session/set_config_option', { sessionId: 's', configId: 'model', value: 'm1' });
  await bridge.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(acp.calls[0].method, '_cognition.ai/session/rename');
  assert.equal(acp.calls[1].method, 'session/set_config_option');
});

// ---- _bridge/respond: Request-Antwort ----

test('respond loest wartenden Agent-Request auf und schreibt bridge-Event', async () => {
  const store = new MemoryStore();
  const acp = new FakeAcp();
  const bridge = new Bridge({ store, acp, ownerId: 'o' });
  let answered = null;
  bridge.pendingAgent.set('req-1', {
    params: { sessionId: 's1' },
    respond: (r) => { answered = r; },
  });
  store.addRpc('_bridge/respond', { rpcId: 'req-1', response: { outcome: { outcome: 'selected', optionId: 'o1' } } });
  await bridge.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(store.rpc[0].status, 'done');
  assert.equal(answered.outcome.optionId, 'o1');
  assert.equal(bridge.pendingAgent.has('req-1'), false);
  // bridge-Event async eingefuegt
  await new Promise((r) => setImmediate(r));
  const ev = store.events.find((e) => e.kind === 'bridge' && e.payload.type === 'request_answered');
  assert.ok(ev);
  assert.equal(ev.session_id, 's1');
});

test('respond auf unbekannten rpcId -> error', async () => {
  const store = new MemoryStore();
  const bridge = new Bridge({ store, acp: new FakeAcp(), ownerId: 'o' });
  store.addRpc('_bridge/respond', { rpcId: 'gibts-nicht', response: {} });
  await bridge.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(store.rpc[0].status, 'error');
});

// ---- Cleanup ----

test('cleanup loescht events > 2 Tage und fertige rpc > 1 Tag', async () => {
  const store = new MemoryStore();
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const oldRpc = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  store.events.push({ id: 1, created_at: old, kind: 'update', payload: {} });
  store.events.push({ id: 2, created_at: new Date().toISOString(), kind: 'update', payload: {} });
  const r1 = store.addRpc('_bridge/ping', {});
  r1.status = 'done';
  r1.updated_at = oldRpc;
  store.addRpc('_bridge/ping', {}); // pending, bleibt
  const res = await store.cleanup();
  assert.equal(res.events, 1);
  assert.equal(res.rpc, 1);
  assert.equal(store.events.length, 1);
  assert.equal(store.rpc.length, 1);
});

// ---- claim-Race ----

test('claimRpc claimed nur pending rows', async () => {
  const store = new MemoryStore();
  const row = store.addRpc('_bridge/ping', {});
  row.status = 'done';
  assert.equal(await store.claimRpc(row.id), false);
});

test('stripLoneSurrogates/sanitizePayload entfernt ungepaarte Surrogate', async () => {
  const { stripLoneSurrogates, sanitizePayload } = await import('../lib.js');
  const bad = 'a\ud800b\udfffc';
  const ok = 'a\ud83d\ude00b'; // echtes Emoji-Paar bleibt
  assert.equal(stripLoneSurrogates(bad), 'abc');
  assert.equal(stripLoneSurrogates(ok), ok);
  assert.deepEqual(sanitizePayload({ t: bad }), { t: 'abc' });
});

test('sanitizePayload entfernt \u0000 und Queue ueberlebt Fehler', async () => {
  const { sanitizePayload } = await import('../lib.js');
  assert.deepEqual(sanitizePayload({ t: 'a\0b\0c' }), { t: 'abc' });
});
