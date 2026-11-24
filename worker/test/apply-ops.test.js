import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMsgOp } from '../../docs/apply.js';
import { SessionCache } from '../transcript.js';

const chunk = (kind, text) => ({ update: { sessionUpdate: `${kind}_chunk`, content: { text } } });

test('applyMsgOp: neue Eintraege + fortlaufende Appends', () => {
  const entries = [];
  const c = new SessionCache('s');
  const feed = (u) => c.applyUpdate(u).forEach((op) => { if (op.type === 'msg') applyMsgOp(entries, op); });
  feed(chunk('user_message', 'ha'));
  feed(chunk('agent_message', 'An'));
  feed(chunk('agent_message', 'twort'));
  assert.deepEqual(entries.map((e) => `${e.i}:${e.role}:${e.text}`), ['0:user:ha', '1:agent:Antwort']);
});

test('applyMsgOp: Duplikate werden uebersprungen (Backlog-Replay)', () => {
  const entries = [{ i: 0, role: 'agent', text: 'Antwort' }];
  // gleiche Op nochmal (Backlog nach open/since)
  assert.equal(applyMsgOp(entries, { type: 'msg', i: 0, role: 'agent', at: 0, append: 'Antwort' }), 'skipped');
  assert.equal(applyMsgOp(entries, { type: 'msg', i: 0, role: 'agent', at: 3, append: 'wort' }), 'skipped');
  assert.equal(entries[0].text, 'Antwort'); // kein doppeltes Anhaengen
});

test('applyMsgOp: Luecke (at > len) -> resync', () => {
  const entries = [{ i: 0, role: 'agent', text: 'Ant' }];
  assert.equal(applyMsgOp(entries, { type: 'msg', i: 0, role: 'agent', at: 10, append: 'x' }), 'resync');
});

test('applyMsgOp: Op fuer Loch < maxI -> resync (verpasster Eintrag)', () => {
  const entries = [{ i: 0, role: 'user', text: 'a' }, { i: 5, role: 'agent', text: 'b' }];
  // i=3 existiert nicht (unterdrueckter thought kaeme nie als Op) -> verpasster Eintrag
  assert.equal(applyMsgOp(entries, { type: 'msg', i: 3, role: 'agent', at: 0, append: 'x' }), 'resync');
});

test('applyMsgOp: neuer Eintrag mit at>0 -> resync (Anfang fehlt)', () => {
  const entries = [{ i: 0, role: 'user', text: 'a' }];
  assert.equal(applyMsgOp(entries, { type: 'msg', i: 2, role: 'agent', at: 5, append: 'x' }), 'resync');
});

test('applyMsgOp: i > maxI mit at=0 -> neuer Eintrag (i-Luecke = unterdrueckte thoughts ok)', () => {
  const entries = [{ i: 0, role: 'user', text: 'a' }];
  assert.equal(applyMsgOp(entries, { type: 'msg', i: 4, role: 'agent', at: 0, append: 'hi' }), 'applied');
  assert.equal(entries[1].i, 4);
  assert.equal(entries[1].text, 'hi');
});

test('applyMsgOp: steps-Ops ersetzen n/titles idempotent', () => {
  const entries = [];
  applyMsgOp(entries, { type: 'msg', i: 1, role: 'steps', n: 1, titles: ['ls'] });
  assert.equal(applyMsgOp(entries, { type: 'msg', i: 1, role: 'steps', n: 2, titles: ['ls', 'cat'] }), 'applied');
  assert.equal(entries[0].n, 2);
  assert.deepEqual(entries[0].titles, ['ls', 'cat']);
});
