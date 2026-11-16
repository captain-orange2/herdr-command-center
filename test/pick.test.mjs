import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runPopup } from '../bin/popup.mjs';
import { loadStore, saveStore } from '../src/store.mjs';
import { ConfigError, normalizeCommand, normalizeConfig } from '../src/schema.mjs';
import { renderConfigToml } from '../src/toml-config.mjs';
import { createView, reduceKey } from '../src/view.mjs';
import { createFakeProcess, createFakeStderr, createFakeStdin, createFakeStdout } from './helpers/fake-tty.mjs';

const MOVE = {
  id: 'move', slot: '4', label: 'Move pane', type: 'shell',
  command: 'herdr-move-pane --apply {}', pick: 'herdr-move-pane --choose "$COMMAND_CENTER_PANE_ID"',
};

test('pick is optional, single-line, shell/pane only, and needs {} in the command', () => {
  assert.equal('pick' in normalizeCommand({ label: 'a', type: 'shell', command: 'ls' }), false);
  assert.equal(normalizeCommand(MOVE).pick, MOVE.pick);
  assert.throws(() => normalizeCommand({ ...MOVE, command: 'no placeholder' }), ConfigError);
  assert.throws(() => normalizeCommand({ ...MOVE, pick: 'a\nb' }), ConfigError);
  assert.throws(() => normalizeCommand({ ...MOVE, type: 'plugin_action', command: 'x.{}' }), ConfigError);
});

test('pick round-trips through the file and survives an edit in the form', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-pick-'));
  const file = join(dir, 'commands.toml');
  const raw = renderConfigToml(normalizeConfig({ commands: [MOVE] }));
  await writeFile(file, raw, 'utf8');
  const { doc } = await loadStore(file);
  assert.equal(doc.commands[0].pick, MOVE.pick);
  // Edit the label via the grid form: E, then type, then save.
  let view = createView({ doc, cursor: 3 });
  for (const key of ['E', '!', 'enter']) view = reduceKey(view, key);
  assert.equal(view.effect.type, 'save');
  await saveStore(file, view.effect.doc, { expectedRaw: raw });
  const saved = (await loadStore(file)).doc.commands[0];
  assert.equal(saved.label, 'Move pane!');
  assert.equal(saved.pick, MOVE.pick);
});

// A fake child for the pick step: prints `output` and exits with `code`.
function fakeSpawn(spawns, { output = '', code = 0 } = {}) {
  return (file, args, options) => {
    spawns.push({ file, args, options });
    if (!options.stdio) return { unref: () => {} }; // the detached runner
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    setImmediate(() => {
      child.stdout.end(output);
      child.stdout.on('end', () => child.emit('close', code));
      child.stdout.resume();
    });
    return child;
  };
}

async function popupWithPick(dir, spawnOptions, keys = ['\r']) {
  await writeFile(join(dir, 'commands.toml'), renderConfigToml(normalizeConfig({ view: 'palette', commands: [MOVE] })), 'utf8');
  const spawns = [];
  const stdout = createFakeStdout();
  const stdin = createFakeStdin(keys, { endAfterQueue: keys.length > 1 });
  const code = await runPopup({
    env: {
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_PLUGIN_STATE_DIR: join(dir, 'state'),
      COMMAND_CENTER_CONTEXT_JSON: JSON.stringify({ focusedPaneId: 'w1:p2', focusedPaneCwd: '/tmp' }),
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      COMMAND_CENTER_ASCII_INPUT: '0',
    },
    stdin,
    stdout,
    stderr: createFakeStderr(),
    processRef: createFakeProcess(4242),
    execPath: '/usr/local/bin/node',
    spawn: fakeSpawn(spawns, spawnOptions),
    execFile: async () => { throw new Error('unexpected execFile'); },
  });
  return { code, spawns, stdin, stdout };
}

test('the popup runs pick on its own tty and fills {} with the shell-quoted result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-pick-run-'));
  const { code, spawns } = await popupWithPick(dir, { output: "w1:p2\u001ftab:w1:t3\u001fit's\nignored\n" });
  assert.equal(code, 0);
  const [pick, runner] = spawns;
  assert.deepEqual([pick.file, ...pick.args], ['/bin/zsh', '-lc', MOVE.pick]);
  assert.deepEqual(pick.options.stdio, ['inherit', 'pipe', 'inherit']);
  assert.equal(pick.options.env.COMMAND_CENTER_PANE_ID, 'w1:p2');
  const task = JSON.parse(runner.options.env.COMMAND_CENTER_TASK_JSON);
  assert.equal(task.command.command, "herdr-move-pane --apply 'w1:p2\u001ftab:w1:t3\u001fit'\\''s'");
  assert.equal('pick' in task.command, false);
  assert.ok(JSON.parse(await readFile(join(dir, 'state', 'usage.json'), 'utf8')).move > 0);
});

test('a cancelled or empty pick returns to the list without running anything', async () => {
  for (const options of [{ output: 'chosen\n', code: 130 }, { output: '', code: 0 }]) {
    const dir = await mkdtemp(join(tmpdir(), 'cc-pick-cancel-'));
    // enter runs the pick step; after it is cancelled, esc closes the list it came back to.
    const { code, spawns, stdin, stdout } = await popupWithPick(dir, options, ['\r', '\u001b']);
    assert.equal(code, 0);
    assert.equal(spawns.length, 1, 'only the pick step was spawned');
    assert.deepEqual(stdin.rawModeHistory, [true, false, true, false], 'raw mode comes back for the list');
    assert.match(stdout.lastFrame, /Move pane/u, 'the list was drawn again');
  }
});
