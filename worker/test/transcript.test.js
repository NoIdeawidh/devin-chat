import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCache, entryHash } from '../transcript.js';

const upd = (sessionUpdate, extra = {}) => ({ update: { sessionUpdate, ...extra } });
const chunk = (kind, text) => upd(`${kind}_chunk`, { content: { text } });

test('entryHash: Test-Vektor stimmt mit docs/app.js msgHash ueberein', () => {
  assert.equal(entryHash({ role: 'agent', text: 'ok' }), 'e940603c');
  assert.equal(entryHash({ role: 'user', text: 'hallo' }), '9783be46');
});

test('Chunks gleicher Rolle mergen, Rollenwechsel erzeugt neuen Eintrag', () => {
  const c = new SessionCache('s');
  c.applyUpdate(chunk('user_message', 'ha'));
  c.applyUpdate(chunk('user_message', 'llo'));
  c.applyUpdate(chunk('agent_message', 'ok'));
  c.applyUpdate(chunk('agent_message', '.'));
  assert.equal(c.entries.length, 2);
  assert.equal(c.entries[0].text, 'hallo');
  assert.equal(c.entries[0].role, 'user');
  assert.equal(c.entries[1].text, 'ok.');
  assert.equal(c.entries[1].i, 1);
});

test('Tool-Call beendet laufende Agent-Nachricht (Grenze)', () => {
  const c = new SessionCache('s');
  c.applyUpdate(chunk('agent_message', 'erste'));
  c.applyUpdate(upd('tool_call', { toolCallId: 't1', title: 'Datei lesen' }));
  c.applyUpdate(chunk('agent_message', 'zweite'));
  assert.equal(c.entries.length, 3);
  assert.deepEqual(c.entries.map((e) => e.role), ['agent', 'steps', 'agent']);
  assert.equal(c.entries[2].text, 'zweite');
});

test('Tool-Calls sammeln sich in steps-Eintraegen (n + titles)', () => {
  const c = new SessionCache('s');
  c.applyUpdate(upd('tool_call', { toolCallId: 't1', title: 'ls' }));
  c.applyUpdate(upd('tool_call', { toolCallId: 't2', title: 'cat' }));
  assert.equal(c.entries.length, 1);
  assert.equal(c.entries[0].n, 2);
  assert.deepEqual(c.entries[0].titles, ['ls', 'cat']);
  // tool_call_update ersetzt Titel ueber toolCallId
  c.applyUpdate(upd('tool_call_update', { toolCallId: 't2', title: 'cat datei.txt' }));
  assert.deepEqual(c.entries[0].titles, ['ls', 'cat datei.txt']);
  assert.equal(c.stepsSinceUser, 2);
});

test('stepsSinceUser wird bei user_chunk zurueckgesetzt', () => {
  const c = new SessionCache('s');
  c.applyUpdate(upd('tool_call', { title: 'x' }));
  assert.equal(c.stepsSinceUser, 1);
  c.applyUpdate(chunk('user_message', 'hi'));
  assert.equal(c.stepsSinceUser, 0);
});

test('plan: statusOp enthaelt in_progress-Eintrag', () => {
  const c = new SessionCache('s');
  const ops = c.applyUpdate(upd('plan', { entries: [{ content: 'fertig', status: 'completed' }, { content: 'laeuft', status: 'in_progress' }] }));
  assert.equal(c.currentPlan(), 'laeuft');
  assert.equal(ops[0].type, 'status');
  assert.equal(ops[0].plan, 'laeuft');
});

test('view(detail): thoughts + step-Titel nur bei detail', () => {
  const c = new SessionCache('s');
  c.applyUpdate(chunk('agent_message', 'a'));
  c.applyUpdate(chunk('agent_thought', 'denke'));
  c.applyUpdate(upd('tool_call', { title: 'ls' }));
  const plain = c.view(false);
  assert.equal(plain.length, 2);
  assert.equal(plain[0].role, 'agent');
  assert.deepEqual(plain[1], { i: 2, role: 'steps', n: 1 }); // Index-Luecke i=1 bleibt
  const full = c.view(true);
  assert.equal(full.length, 3);
  assert.deepEqual(full[2].titles, ['ls']);
});

test('matchSince: Hash des letzten Eintrags -> true, sonst false', () => {
  const c = new SessionCache('s');
  c.applyUpdate(chunk('user_message', 'hi'));
  c.applyUpdate(chunk('agent_message', 'ok'));
  assert.equal(c.matchSince({ count: 2, hash: entryHash({ role: 'agent', text: 'ok' }) }), true);
  assert.equal(c.matchSince({ count: 2, hash: 'deadbeef' }), false);
  assert.equal(c.matchSince({ count: 99, hash: entryHash({ role: 'agent', text: 'ok' }) }), false);
  assert.equal(c.matchSince(null), false);
});

test('fromIndex liefert Delta ab letztem Eintrag inkl.', () => {
  const c = new SessionCache('s');
  c.applyUpdate(chunk('user_message', '1'));
  c.applyUpdate(chunk('agent_message', '2'));
  c.applyUpdate(chunk('user_message', '3'));
  const d = c.fromIndex(1, false);
  assert.deepEqual(d.map((e) => e.i), [1, 2]);
});

test('history: Seite vor `before` + hasMore, Indices stabil', () => {
  const c = new SessionCache('s');
  for (let i = 0; i < 10; i++) c.applyUpdate(chunk('agent_message', `m${i}-`)); // merged -> 1 Eintrag
  c.applyUpdate(chunk('user_message', 'u')); // i=1
  for (let i = 0; i < 5; i++) {
    c.applyUpdate(chunk('agent_message', 'x'));
    c.applyUpdate(upd('tool_call', { title: 't' }));
  }
  const h1 = c.history(10, 3, true);
  assert.deepEqual(h1.messages.map((e) => e.i), [7, 8, 9]);
  assert.equal(h1.hasMore, true);
  const h2 = c.history(7, 30, true);
  assert.deepEqual(h2.messages.map((e) => e.i), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(h2.hasMore, false);
});

test('tail: letzte limit Eintraege der gefilterten Sicht', () => {
  const c = new SessionCache('s');
  for (let i = 0; i < 5; i++) {
    c.applyUpdate(chunk('user_message', `u${i}`));
    c.applyUpdate(chunk('agent_message', `a${i}`));
  }
  const t = c.tail(2, false);
  assert.deepEqual(t.map((e) => e.text), ['u4', 'a4']);
  assert.equal(t[0].i, 8);
});

test('applyLoadResult uebernimmt modes/config/meta', () => {
  const c = new SessionCache('s');
  c.applyLoadResult({ modes: { currentModeId: 'smart' }, configOptions: [{ id: 'model' }], _meta: { 'cognition.ai/planFilePath': 'x' } });
  assert.equal(c.modes.currentModeId, 'smart');
  assert.equal(c.configOptions[0].id, 'model');
});

test('Notifications: agent_stopped -> status, mcp -> note', () => {
  const c = new SessionCache('s');
  assert.deepEqual(c.applyNotification('_cognition.ai/agent_stopped'), []);
  c.setRunning(true);
  const ops = c.applyNotification('_cognition.ai/agent_stopped');
  assert.equal(ops[0].type, 'status');
  assert.equal(ops[0].running, false);
  const mcp = c.applyNotification('_cognition.ai/mcp/authorizationRequired', { url: 'https://x' });
  assert.equal(mcp[0].type, 'note');
});
