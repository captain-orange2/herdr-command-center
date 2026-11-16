import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPopup } from '../bin/popup.mjs';
import { fuzzyScore, rankCommands } from '../src/palette.mjs';
import { renderLines, textCursor } from '../src/render.mjs';
import { ConfigError, normalizeConfig, SLOT_KEYS } from '../src/schema.mjs';
import { renderConfigToml } from '../src/toml-config.mjs';
import { loadUsage, recordUsage } from '../src/usage.mjs';
import { createView, paletteResults, reduceKey } from '../src/view.mjs';
import { createFakeProcess, createFakeStderr, createFakeStdin, createFakeStdout } from './helpers/fake-tty.mjs';

const NOW = Date.UTC(2026, 10, 16);
const DAY = 86_400_000;

function cmd(id, label, description = '', index = 0) {
  return { id, slot: SLOT_KEYS[index], label, type: 'shell', command: `run-${id}`, cwd: 'focused', description };
}

function paletteDoc(commands) {
  return { schema_version: 1, view: 'palette', editor: ['code'], commands };
}

const COMMANDS = [
  cmd('code', 'Open in VS Code', "Open the focused pane's directory", 0),
  cmd('gh', 'Open repo on GitHub', 'Open the current repository in the browser', 1),
  cmd('move', 'Move pane to tab', 'Move the focused pane into a tab of any workspace', 2),
];

function press(view, ...keys) {
  return keys.reduce((current, key) => reduceKey(current, key), view);
}

test('fuzzyScore prefers exact and word-start hits and rejects non-subsequences', () => {
  assert.equal(fuzzyScore('xyz', 'Open in VS Code'), null);
  assert.ok(fuzzyScore('code', 'Open in VS Code') > fuzzyScore('oivc', 'Open in VS Code'));
  assert.ok(fuzzyScore('open', 'Open repo') > fuzzyScore('pen', 'Open repo'));
  assert.ok(fuzzyScore('ovs', 'Open in VS Code') !== null);
});

test('rankCommands with no query orders by last use, then config order', () => {
  const usage = { gh: NOW - DAY, move: NOW - 60_000 };
  assert.deepEqual(rankCommands(COMMANDS, '', usage, NOW).map((c) => c.id), ['move', 'gh', 'code']);
  assert.deepEqual(rankCommands(COMMANDS, '', {}, NOW).map((c) => c.id), ['code', 'gh', 'move']);
});

test('rankCommands searches label and description, every token must match', () => {
  assert.deepEqual(rankCommands(COMMANDS, 'browser', {}, NOW).map((c) => c.id), ['gh']);
  assert.deepEqual(rankCommands(COMMANDS, 'focused pane', {}, NOW).map((c) => c.id).sort(), ['code', 'move']);
  assert.deepEqual(rankCommands(COMMANDS, 'open nothing-here', {}, NOW), []);
});

test('rankCommands lets recency reorder comparable matches but not beat a much better one', () => {
  // "open" is an exact word-start hit in both labels: the recently used one wins.
  assert.equal(rankCommands(COMMANDS, 'open', { gh: NOW - 1000 }, NOW)[0].id, 'gh');
  // A label hit beats a description-only hit even when that one was just used.
  assert.equal(rankCommands(COMMANDS, 'pane', { code: NOW - 1000 }, NOW)[0].id, 'move');
});

test('view must be grid or palette and defaults to grid', () => {
  assert.equal(normalizeConfig({}).view, 'grid');
  assert.equal(normalizeConfig({ view: 'palette' }).view, 'palette');
  assert.throws(() => normalizeConfig({ view: 'tiles' }), ConfigError);
});

test('a palette config opens in the palette and every sub-screen returns to it', () => {
  const view = createView({ doc: paletteDoc(COMMANDS) });
  assert.equal(view.mode, 'palette');
  const grid = press(view, 'tab');
  assert.equal(grid.mode, 'list');
  assert.equal(press(grid, 'tab').mode, 'palette');
  assert.equal(press(grid, 'A', 'escape').mode, 'palette');
  assert.equal(createView({ doc: { ...paletteDoc(COMMANDS), view: 'grid' } }).mode, 'list');
});

test('typing filters, arrows move, enter runs the highlighted result', () => {
  const view = press(createView({ doc: paletteDoc(COMMANDS) }), 'o', 'p', 'e', 'n');
  assert.equal(view.query, 'open');
  // Both labels start with "open"; "move" only matches it scattered through its description.
  assert.deepEqual(paletteResults(view).map((c) => c.id), ['code', 'gh', 'move']);
  const ran = press(view, 'down', 'enter');
  assert.deepEqual(ran.effect, { type: 'run', command: COMMANDS[1] });
  // Letters that are slot keys or actions in the grid only type here.
  assert.equal(press(view, 'A').effect, null);
});

test('backspace edits the query; esc clears it first, then closes', () => {
  let view = press(createView({ doc: paletteDoc(COMMANDS) }), 'm', 'v', 'backspace', 'space');
  assert.equal(view.query, 'm ');
  view = press(view, 'escape');
  assert.equal(view.query, '');
  assert.equal(view.effect, null);
  assert.deepEqual(press(view, 'escape').effect, { type: 'close' });
  assert.equal(press(createView({ doc: paletteDoc([]) }), 'enter').effect, null);
});

test('the palette renders the search line, results, and parks the caret on the query', () => {
  const size = { columns: 78, rows: 20 };
  const view = press(createView({ doc: paletteDoc(COMMANDS) }), 'm', 'o', 'v');
  const lines = renderLines(view, size);
  assert.equal(lines.length, 20);
  assert.match(lines[3], /› mov$/u);
  assert.ok(lines.some((line) => /› Move pane to tab {3}Move the focused/u.test(line)));
  assert.ok(lines.some((line) => /shell · run-move/u.test(line)));
  assert.deepEqual(textCursor(view, size), { row: 3, column: 7 });
  const empty = renderLines(press(view, 'q', 'q'), size).join('\n');
  assert.match(empty, /No command matches/u);
});

test('usage survives a corrupt file and records the last run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-usage-'));
  const file = join(dir, 'state', 'usage.json');
  assert.deepEqual(await loadUsage(file), {});
  const next = await recordUsage(file, { a: 1 }, 'b', 5);
  assert.deepEqual(next, { a: 1, b: 5 });
  assert.deepEqual(await loadUsage(file), { a: 1, b: 5 });
  await writeFile(file, '{ broken', 'utf8');
  assert.deepEqual(await loadUsage(file), {});
});

test('the popup opens the palette, runs a search hit, and records its use', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-palette-'));
  await writeFile(join(dir, 'commands.toml'), renderConfigToml(normalizeConfig(paletteDoc(COMMANDS))), 'utf8');
  const spawns = [];
  const stdout = createFakeStdout();
  const code = await runPopup({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state'), TERM: 'xterm-256color', COMMAND_CENTER_ASCII_INPUT: '0' },
    stdin: createFakeStdin(['g', 'h', '\r']),
    stdout,
    stderr: createFakeStderr(),
    processRef: createFakeProcess(4242),
    execPath: '/usr/local/bin/node',
    spawn: (file, args, options) => { spawns.push(options); return { unref: () => {} }; },
    execFile: async () => { throw new Error('unexpected execFile'); },
  });
  assert.equal(code, 0);
  assert.match(stdout.frames[0], /Command Center · 3\/3 commands/u);
  assert.equal(JSON.parse(spawns[0].env.COMMAND_CENTER_TASK_JSON).command.id, 'gh');
  const usage = JSON.parse(await readFile(join(dir, 'state', 'usage.json'), 'utf8'));
  assert.deepEqual(Object.keys(usage), ['gh']);
});

test('a popup save keeps view = "palette" and the rest of the hand-written file', async () => {
  const { saveStore, loadStore } = await import('../src/store.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'cc-palette-save-'));
  const file = join(dir, 'commands.toml');
  const raw = '# mine\nschema_version = 1\nview = "palette"\neditor = ["code"]\n';
  await writeFile(file, raw, 'utf8');
  const { doc } = await loadStore(file);
  await saveStore(file, { ...doc, commands: [cmd('new', 'New one')] }, { expectedRaw: raw });
  const saved = await readFile(file, 'utf8');
  assert.match(saved, /^# mine\nschema_version = 1\nview = "palette"\n/u);
  assert.equal((await loadStore(file)).doc.view, 'palette');
});
