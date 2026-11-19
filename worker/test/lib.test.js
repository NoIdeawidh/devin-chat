import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREAMBLE,
  buildSpawnEnv,
  parseModels,
  cleanAnswer,
  buildTranscript,
  buildPrompt,
  tail,
} from '../lib.js';

const MODELS_SAMPLE = `Available models (54 families)

Adaptive (adaptive)
  adaptive                                   Adaptive  [$0.5 / 1M Input · $0.1 / 1M Cached input · $2 / 1M Output]

SWE-2 (swe-2)
  aliases: swe
  swe-2-high                                 SWE-2 High  [262K context, Free]
  swe-2-medium                               SWE-2 Medium  [262K context, Free]

Claude Fable 5.2 (claude-fable-5.2)
  claude-fable-5-2-medium                    Claude Fable 5.2 Medium  [1M context, $8 / 1M Input · $0.2 / 1M Cached input · $40 / 1M Output]
`;

test('parseModels parses headers, aliases and spaced labels', () => {
  const models = parseModels(MODELS_SAMPLE);
  assert.equal(models.length, 4);
  assert.deepEqual(models[0], {
    id: 'adaptive',
    label: 'Adaptive',
    family: 'Adaptive',
    info: '$0.5 / 1M Input · $0.1 / 1M Cached input · $2 / 1M Output',
    sort: 0,
  });
  assert.equal(models[1].id, 'swe-2-high');
  assert.equal(models[1].family, 'SWE-2');
  assert.equal(models[1].info, '262K context, Free');
  // label containing spaces
  assert.equal(models[3].label, 'Claude Fable 5.2 Medium');
  assert.equal(models[3].family, 'Claude Fable 5.2');
  // sort is running index in output order
  assert.deepEqual(models.map((m) => m.sort), [0, 1, 2, 3]);
});

test('parseModels returns empty array on garbage', () => {
  assert.deepEqual(parseModels(''), []);
  assert.deepEqual(parseModels('Not logged in\n'), []);
});

test('buildSpawnEnv keeps whitelist case-insensitively and drops the rest', () => {
  const env = buildSpawnEnv({
    PATH: 'C:\\Windows',
    pathext: '.EXE',
    USERPROFILE: 'C:\\Users\\HenriB',
    WINDSURF_X: '1',
    VSCODE_PID: '42',
    DEVIN_TELEMETRY: 'on',
  });
  assert.equal(env.PATH, 'C:\\Windows');
  assert.equal(env.pathext, '.EXE');
  assert.equal(env.USERPROFILE, 'C:\\Users\\HenriB');
  assert.equal(env.WINDSURF_X, undefined);
  assert.equal(env.VSCODE_PID, undefined);
  assert.equal(env.DEVIN_TELEMETRY, undefined);
});

test('cleanAnswer strips ANSI escapes and rejected-tool-call warnings', () => {
  const stdout = '\x1b[32mHallo\x1b[0m Welt\nwarning: rejected a tool call (write_file): blocked\n\nAntwort hier.';
  assert.equal(cleanAnswer(stdout), 'Hallo Welt\n\nAntwort hier.');
});

test('cleanAnswer reads stdout only', () => {
  const out = 'erste Zeile\nwarning: rejected a tool call (run_command)\nletzte Zeile\n';
  assert.equal(cleanAnswer(out), 'erste Zeile\nletzte Zeile');
  assert.equal(cleanAnswer(''), '');
  assert.equal(cleanAnswer(undefined), '');
});

test('buildPrompt fresh = preamble + blank + user text', () => {
  const p = buildPrompt('fresh', 'Hallo');
  assert.equal(p, `${PREAMBLE}\n\nHallo`);
});

test('buildPrompt continue = user text only', () => {
  assert.equal(buildPrompt('continue', 'Hallo'), 'Hallo');
});

test('buildPrompt fallback prepends transcript and re-labels user text', () => {
  const transcript = buildTranscript([
    { role: 'user', content: 'Frage eins' },
    { role: 'assistant', content: 'Antwort eins' },
  ]);
  assert.equal(transcript, 'Nutzer: Frage eins\n\nAssistent: Antwort eins');
  const p = buildPrompt('fallback', 'Frage zwei', transcript);
  assert.ok(p.startsWith(PREAMBLE));
  assert.ok(p.includes('Nutzer: Frage eins'));
  assert.ok(p.includes('Assistent: Antwort eins'));
  assert.ok(p.endsWith('Nutzer: Frage zwei'));
});

test('tail returns last n chars', () => {
  assert.equal(tail('abcdef', 3), 'def');
  assert.equal(tail('abc', 10), 'abc');
  assert.equal(tail(null), '');
});
