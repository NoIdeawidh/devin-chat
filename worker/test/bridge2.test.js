import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../bridge.js';
import { MemoryStore } from '../store.js';
import { entryHash } from '../transcript.js';

class FakeAcp extends EventEmitter {
  constructor() { super(); this.calls = []; this.responses = {}; }
  async request(m, p) { this.calls.push({ method: m, params: p }); return this.responses[m] || { result: {} }; }
  notify(m, p) { this.calls.push({ method: m, params: p, notification: true }); }
  get alive() { return true; }
}

const mk = (extra = {}) => {
  const store = new MemoryStore();
  const acp = new FakeAcp();
  const bridge = new Bridge({ store, acp, ownerId: 'o', ...extra });
  return { store, acp, bridge };
};
const openRpc = (store, params) => store.addRpc('_bridge/session/open', params);
const run = async (bridge) => { await bridge.tick(); await new Promise((r) => setImmediate(r)); };
const liveEvents = (store, sid) => store.events.filter((e) => e.kind === 'live' && e.session_id === sid);
const loadResult = {
  modes: { currentModeId: 'smart', availableModes: [{ id: 'smart', name: 'Smart' }] },
  configOptions: [{ id: 'model', currentValue: 'm1', options: [] }],
  _meta: { 'cognition.ai/planFilePath': 'p' },
};

test('open: laedt in Cache, liefert reset+tail, watcht die Sitzung', async () => {
  const { store, acp, bridge } = mk();
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x', limit: 5 });
  await run(bridge);
  const row = store.rpc[0];
  assert.equal(row.status, 'done');
  assert.equal(row.result.reset, true);
  assert.equal(row.result.total, 0);
  assert.equal(row.result.modes.currentModeId, 'smart');
  assert.deepEqual(acp.calls[0].params, { sessionId: 's1', cwd: 'C:\\x', mcpServers: [] });
  assert.equal(bridge.watched.has('s1'), true);
});

test('open zweiter Aufruf ohne force laedt NICHT erneut; since liefert Delta', async () => {
  const { store, acp, bridge } = mk();
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x' });
  await run(bridge);
  assert.equal(acp.calls.filter((c) => c.method === 'session/load').length, 1);
  // Live-Updates in den Cache
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'user_message_chunk', content: { text: 'hi' } } });
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } } });
  const last = bridge.caches.get('s1').entries.at(-1);
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x', since: { count: last.i + 1, hash: entryHash(last) } });
  await run(bridge);
  const r = store.rpc[1].result;
  assert.equal(r.reset, false);
  assert.deepEqual(r.messages.map((e) => e.i), [1]); // nur letzte Nachricht erneut
  assert.equal(acp.calls.filter((c) => c.method === 'session/load').length, 1);
});

test('open mit falschem since-Hash -> reset + letzte limit Eintraege', async () => {
  const { store, acp, bridge } = mk();
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x', limit: 2 });
  await run(bridge);
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'user_message_chunk', content: { text: 'a' } } });
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'b' } } });
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'c' } } });
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x', since: { count: 1, hash: 'deadbeef' }, limit: 2 });
  await run(bridge);
  const r = store.rpc[1].result;
  assert.equal(r.reset, true);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages.at(-1).text, 'bc'); // Merge auf Cache-Ebene
});

test('live-Ops nur fuer watched Sitzungen, gebundelt als kind=live', async () => {
  const { store, acp, bridge } = mk({ bundlerOpts: { windowMs: 1 } });
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x' });
  await run(bridge);
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x' } } });
  acp.emit('update', { sessionId: 's2', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'y' } } });
  await bridge.flush();
  const evs = liveEvents(store, 's1');
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].payload.ops, [{ type: 'msg', i: 0, role: 'agent', at: 0, append: 'x' }]);
  assert.equal(liveEvents(store, 's2').length, 0); // s2 nicht geladen/watched
});

test('unwatch stoppt live-Ops; detail:false filtert thoughts', async () => {
  const { store, acp, bridge } = mk({ bundlerOpts: { windowMs: 1 } });
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x', detail: false });
  await run(bridge);
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'denk' } } });
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'a' } } });
  await bridge.flush();
  const ops = liveEvents(store, 's1').flatMap((e) => e.payload.ops);
  assert.equal(ops.some((o) => o.role === 'thought'), false); // gecached aber nicht gesendet
  assert.equal(bridge.caches.get('s1').entries.some((e) => e.role === 'thought'), true);
  store.addRpc('_bridge/session/unwatch', { sessionId: 's1' });
  await run(bridge);
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'b' } } });
  await bridge.flush();
  const n = liveEvents(store, 's1').flatMap((e) => e.payload.ops).filter((o) => o.append === 'b').length;
  assert.equal(n, 0);
  assert.equal(bridge.caches.get('s1').entries.at(-1).text, 'ab'); // Cache waechst weiter
});

test('detail:true sendet thought-Ops live', async () => {
  const { store, acp, bridge } = mk({ bundlerOpts: { windowMs: 1 } });
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x', detail: true });
  await run(bridge);
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'denk' } } });
  await bridge.flush();
  const ops = liveEvents(store, 's1').flatMap((e) => e.payload.ops);
  assert.deepEqual(ops[0], { type: 'msg', i: 0, role: 'thought', at: 0, append: 'denk' });
});

test('tool_call in watched non-detail Sitzung -> steps-Op ohne Titel (kein Crash)', async () => {
  const { store, acp, bridge } = mk({ bundlerOpts: { windowMs: 1 } });
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x', detail: false });
  await run(bridge);
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Datei lesen' } });
  acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Datei schreiben' } });
  await bridge.flush();
  const ops = liveEvents(store, 's1').flatMap((e) => e.payload.ops);
  const steps = ops.filter((o) => o.role === 'steps');
  assert.equal(steps.length, 2); // zwei tool_calls -> zwei Updates auf demselben steps-Eintrag
  assert.deepEqual(steps.at(-1), { type: 'msg', i: 0, role: 'steps', n: 2 }); // ohne titles
  // Cache hat die Titel trotzdem
  assert.deepEqual(bridge.caches.get('s1').entries[0].titles, ['Datei lesen', 'Datei schreiben']);
});

test('watch-TTL: 30 min ohne RPC -> unwatch; busy bleibt', async () => {
  let now = 0;
  const { store, acp, bridge } = mk({ now: () => now });
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x' });
  openRpc(store, { sessionId: 's2', cwd: 'C:\\x' });
  await run(bridge);
  bridge.busy.add('s2'); // Remote-Prompt laeuft
  now = 31 * 60 * 1000;
  bridge.pruneWatched();
  assert.equal(bridge.watched.has('s1'), false);
  assert.equal(bridge.watched.has('s2'), true);
});

test('history: paginiert ueber den Cache', async () => {
  const { store, acp, bridge } = mk();
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x' });
  await run(bridge);
  for (let i = 0; i < 6; i++) {
    acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'user_message_chunk', content: { text: `u${i}` } } });
    acp.emit('update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { text: `a${i}` } } });
  }
  store.addRpc('_bridge/session/history', { sessionId: 's1', before: 10, limit: 3 });
  await run(bridge);
  const r = store.rpc.at(-1).result;
  assert.deepEqual(r.messages.map((e) => e.i), [7, 8, 9]);
  assert.equal(r.hasMore, true);
});

test('fs/list: Roots ohne path; Filter mit temp dir', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fslist-'));
  mkdirSync(join(home, 'Desktop'));
  mkdirSync(join(home, 'Projects'));
  mkdirSync(join(home, 'sub'));
  mkdirSync(join(home, '.hidden'));
  mkdirSync(join(home, '$sys'));
  mkdirSync(join(home, 'System Volume Information'));
  writeFileSync(join(home, 'datei.txt'), 'x');
  const { store, bridge } = mk({ fsHome: home });
  store.addRpc('_bridge/fs/list', {});
  store.addRpc('_bridge/fs/list', { path: home });
  await run(bridge);
  const roots = store.rpc[0].result;
  assert.equal(roots.path, null);
  assert.ok(roots.dirs.includes(home));
  assert.ok(roots.dirs.includes(join(home, 'Projects')));
  const list = store.rpc[1].result;
  assert.deepEqual(list.dirs, ['Desktop', 'Projects', 'sub']); // versteckt/System/Dateien weg
  assert.equal(list.truncated, false);
  store.addRpc('_bridge/fs/list', { path: 'relativ/pfad' });
  store.addRpc('_bridge/fs/list', { path: join(home, 'gibts-nicht') });
  await run(bridge);
  assert.equal(store.rpc[2].status, 'error');
  assert.match(store.rpc[2].error.message, /absolut/);
  assert.equal(store.rpc[3].status, 'error');
  assert.match(store.rpc[3].error.message, /existiert nicht/);
});

test('tick: false bei Poll-Fehler, true sonst', async () => {
  const store = new MemoryStore();
  const bridge = new Bridge({ store, acp: new FakeAcp(), ownerId: 'o' });
  assert.equal(await bridge.tick(), true);
  store.pollPendingRpc = () => Promise.reject(new Error('netz weg'));
  assert.equal(await bridge.tick(), false);
});

test('parallele opens auf ungeladene Sitzung teilen sich ein session/load', async () => {
  const store = new MemoryStore();
  const acp = new FakeAcp();
  let resolveLoad;
  const gate = new Promise((r) => (resolveLoad = r));
  acp.request = async (m, p) => {
    acp.calls.push({ method: m, params: p });
    if (m === 'session/load') return gate; // haengt bis wir loesen
    return { result: {} };
  };
  const bridge = new Bridge({ store, acp, ownerId: 'o' });
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x' });
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x', since: { count: 1, hash: 'x' } });
  await bridge.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(acp.calls.filter((c) => c.method === 'session/load').length, 1);
  resolveLoad({ result: loadResult });
  for (let i = 0; i < 50 && store.rpc.some((r) => r.status === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(store.rpc[0].status, 'done');
  assert.equal(store.rpc[1].status, 'done'); // zweites open wartet auf dasselbe load
  assert.equal(store.rpc[1].result.reset, true); // Cache war bis dahin leer -> reset
});

test('acp exit verwirft Caches + Watches', async () => {
  const { store, acp, bridge } = mk();
  acp.responses['session/load'] = { result: loadResult };
  openRpc(store, { sessionId: 's1', cwd: 'C:\\x' });
  await run(bridge);
  acp.emit('exit', { code: 1 });
  assert.equal(bridge.caches.size, 0);
  assert.equal(bridge.watched.size, 0);
});
