import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../acp.js';
import { Bridge } from '../bridge.js';
import { MemoryStore } from '../store.js';

const DEVIN =
  process.env.DEVIN_BIN ||
  'C:\\Users\\HenriB\\AppData\\Local\\Programs\\Devin\\resources\\app\\extensions\\windsurf\\devin\\bin\\devin.exe';
const PROBE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'probe');
const LIVE = existsSync(DEVIN) && existsSync(PROBE_DIR) && !process.env.SKIP_LIVE;

test('live: Bridge gegen echtes devin acp (MemoryStore)', { timeout: 240000, skip: !LIVE }, async () => {
  const store = new MemoryStore();
  const acp = new AcpClient({ bin: DEVIN, cwd: PROBE_DIR });
  const bridge = new Bridge({ store, acp, ownerId: 'test', log: () => {} });
  await acp.start();
  const runRpc = async (method, params) => {
    const row = store.addRpc(method, params);
    await bridge.tick();
    for (let i = 0; i < 300 && store.rpc.find((r) => r.id === row.id).status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = store.rpc.find((r) => r.id === row.id);
    assert.equal(done.status, 'done', `${method}: ${JSON.stringify(done.error)}`);
    return done.result;
  };

  const ping = await runRpc('_bridge/ping', {});
  assert.equal(ping.pong, true);
  assert.equal(ping.daemon_ok, true);

  const list = await runRpc('_bridge/session/list', { cwd: PROBE_DIR });
  assert.ok(Array.isArray(list.sessions));

  const nw = await runRpc('_bridge/session/new', { cwd: PROBE_DIR });
  const sid = nw.sessionId;
  assert.ok(sid);
  assert.ok(nw.configOptions.length >= 2);
  assert.equal(nw.modes.availableModes.length, 5);

  const cfg = await runRpc('_bridge/session/set_config_option', {
    sessionId: sid, configId: 'model', value: 'swe-2-flash-medium',
  });
  assert.equal(cfg.configOptions.find((o) => o.id === 'model').currentValue, 'swe-2-flash-medium');

  await runRpc('_bridge/session/set_mode', { sessionId: sid, modeId: 'ask' });
  await runRpc('_bridge/session/rename', { sessionId: sid, title: 'live-bridge-test' });

  const op = await runRpc('_bridge/session/open', { sessionId: sid, cwd: PROBE_DIR });
  assert.equal(op.reset, true);
  assert.equal(op.modes.currentModeId, 'ask');

  const pr = runRpc('_bridge/session/prompt', {
    sessionId: sid, prompt: [{ type: 'text', text: 'Antworte nur: ok' }],
  });
  await new Promise((r) => setTimeout(r, 500));
  store.addRpc('_bridge/session/cancel', { sessionId: sid });
  await bridge.tick();
  await new Promise((r) => setTimeout(r, 300));
  const pres = await pr;
  assert.ok(['end_turn', 'cancelled'].includes(pres.stopReason));

  await bridge.flush();
  await new Promise((r) => setTimeout(r, 100));
  // kompakter Live-Strom statt roher Updates
  const upd = store.events.filter((e) => e.kind === 'live' && e.session_id === sid);
  assert.ok(upd.length >= 1);
  assert.ok(upd[0].payload.ops.length >= 1);
  // Kein rohes update-Event mehr
  assert.equal(store.events.filter((e) => e.kind === 'update').length, 0);

  await runRpc('_bridge/session/close', { sessionId: sid });
  await runRpc('_bridge/session/delete', { sessionId: sid });
  const after = await runRpc('_bridge/session/list', { cwd: PROBE_DIR });
  assert.ok(!after.sessions.find((s) => s.sessionId === sid));

  acp.kill();
});
