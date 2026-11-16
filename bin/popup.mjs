#!/usr/bin/env node

// The interactive half of Command Center. It reads keys, renders frames, and
// persists commands.toml — but it never runs a command. On a run/open-config
// effect it spawns bin/run.mjs detached and returns; its own exit is what closes
// the herdr popup, which is precisely the ordering the runner then depends on.

import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isLightTerminal } from '../src/appearance.mjs';
import { readContext, resolveCwd } from '../src/context.mjs';
import { buildShellSpawn, shellQuote } from '../src/executor.mjs';
import { guardAsciiInput } from '../src/input-source.mjs';
import { resolveEditors } from '../src/editor.mjs';
import { herdrConfigPath, readImportable } from '../src/herdr-config.mjs';
import { createKeyDecoder } from '../src/keys.mjs';
import { commandsPath, resolveConfigDir, resolveStateDir, runLogPath, usagePath } from '../src/paths.mjs';
import { pluginsJsonPath, readInstalledPluginGroups } from '../src/plugin-actions.mjs';
import { gridColumns, renderView, textCursor } from '../src/render.mjs';
import { ConfigError } from '../src/schema.mjs';
import { ensureStore, saveStore } from '../src/store.mjs';
import { loadUsage, recordUsage } from '../src/usage.mjs';
import { beginEditorPick, beginImport, createView, reduceKey } from '../src/view.mjs';

const execFileAsync = promisify(execFileCallback);

const CLEAR_SCREEN = '\u001b[2J\u001b[H';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
// DECSCUSR: a blinking bar reads as a text caret, which is the point.
const BLINKING_BAR = '\u001b[5 q';
const DEFAULT_CURSOR_SHAPE = '\u001b[0 q';
const RUNNER_URL = new URL('./run.mjs', import.meta.url);
const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
  SIGQUIT: 131,
});

function diagnostic(stderr, message) {
  try {
    stderr.write(`command-center: ${message}\n`);
  } catch {
    // Never let a diagnostic keep the terminal in raw mode.
  }
}

const MAX_PICK_BYTES = 64_000;

// Runs a command's pick step on the popup's own terminal: stdin and stderr stay
// on the tty (fzf draws on /dev/tty anyway), stdout is captured. Resolves to the
// first output line, or null when the step was cancelled, failed or printed nothing.
export function runPick(command, { spawn, env, context }) {
  const { file, args, options } = buildShellSpawn(
    { command: command.pick },
    { cwd: resolveCwd(command, context), shell: env.SHELL },
  );
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        shell: false,
        stdio: ['inherit', 'pipe', 'inherit'],
        // The popup itself is the focused pane now, so the step is told which pane it was opened over.
        env: { ...env, COMMAND_CENTER_PANE_ID: context?.focusedPaneId ?? '' },
      });
    } catch {
      resolve(null);
      return;
    }
    let output = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      if (output.length < MAX_PICK_BYTES) output += chunk;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const value = output.split('\n', 1)[0].trim();
      resolve(code === 0 && value.length > 0 ? value : null);
    });
  });
}

function screenSize(stdout, color, light) {
  return {
    columns: Number.isFinite(stdout.columns) ? stdout.columns : 78,
    rows: Number.isFinite(stdout.rows) ? stdout.rows : 24,
    color,
    light,
  };
}

export async function runPopup({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  processRef = process,
  spawn = spawnChild,
  execFile = execFileAsync,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY || typeof stdin.setRawMode !== 'function') {
    diagnostic(stderr, 'an interactive terminal is required');
    return 2;
  }

  let configDir;
  try {
    configDir = await resolveConfigDir(env, execFile);
  } catch (error) {
    diagnostic(stderr, error?.message ?? 'the plugin config directory could not be resolved');
    return 2;
  }
  const commandsFile = commandsPath(configDir);
  const stateDir = resolveStateDir(configDir, env);
  const logFile = runLogPath(stateDir);
  const usageFile = usagePath(stateDir);
  const usage = await loadUsage(usageFile);
  const context = readContext(env);
  const useColor = !env.NO_COLOR && env.TERM !== 'dumb';
  const light = isLightTerminal(env);

  let view;
  let raw = null;
  try {
    const loaded = await ensureStore(commandsFile);
    view = createView({ doc: loaded.doc, usage });
    raw = loaded.raw;
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      diagnostic(stderr, 'commands.toml could not be opened');
      return 1;
    }
    // A broken config must still give the user a way to fix it, so keep a
    // minimal usable doc (for `editor`) and show the reason.
    view = createView({
      doc: { schema_version: 1, editor: [], commands: [] },
      error: error.message,
    });
  }

  let rawMode = false;
  // Driven by hand rather than by for-await: leaving a for-await destroys stdin,
  // and a cancelled pick step has to come back to the list on the same stream.
  let keys = null;
  let stopCode = null;
  const restoreRaw = () => {
    if (!rawMode) return;
    rawMode = false;
    try {
      stdin.setRawMode(false);
    } catch {
      // The terminal may already be detached.
    }
  };
  const draw = () => {
    try {
      const size = screenSize(stdout, useColor, light);
      const cursor = textCursor(view, size);
      // Hide first so the cursor does not visibly skate across the repaint, then
      // park it on the edit point when a text field has focus.
      const frame = `${HIDE_CURSOR}${CLEAR_SCREEN}${renderView(view, size)}`;
      stdout.write(cursor
        ? `${frame}\u001b[${cursor.row + 1};${cursor.column + 1}H${BLINKING_BAR}${SHOW_CURSOR}`
        : `${frame}${DEFAULT_CURSOR_SHAPE}`);
    } catch {
      requestStop(1);
    }
  };
  function requestStop(code) {
    if (stopCode !== null) return;
    stopCode = code;
    restoreRaw();
    try {
      stdin.destroy?.();
    } catch {
      // The iterator will finish on its own.
    }
  }
  const signalHandlers = Object.entries(SIGNAL_EXIT_CODES)
    .map(([signal, code]) => [signal, () => requestStop(code)]);
  const onResize = () => draw();
  const onStreamError = () => requestStop(1);

  const spawnRunner = (task) => {
    const child = spawn(execPath, [fileURLToPath(RUNNER_URL)], {
      detached: true,
      stdio: 'ignore',
      shell: false,
      env: {
        ...env,
        COMMAND_CENTER_TASK_JSON: JSON.stringify({
          ...task,
          context,
          commandsPath: commandsFile,
          logPath: logFile,
        }),
        COMMAND_CENTER_POPUP_PID: String(processRef.pid),
      },
    });
    child?.unref?.();
  };

  try {
    for (const [signal, handler] of signalHandlers) processRef.once(signal, handler);
    processRef.on('SIGWINCH', onResize);
    stdout.on?.('resize', onResize);
    stdin.on?.('error', onStreamError);
    stdout.on?.('error', onStreamError);
    stdin.setRawMode(true);
    rawMode = true;

    const decoder = createKeyDecoder();
    // Runs a pick step on this terminal and comes back to the list afterwards.
    // pause() is what stops this process reading the tty, so the step gets every
    // keystroke instead of racing us for them.
    const pickOnThisTerminal = async (command) => {
      processRef.removeListener?.('SIGWINCH', onResize);
      stdout.removeListener?.('resize', onResize);
      restoreRaw();
      stdin.pause?.();
      stdout.write(`${CLEAR_SCREEN}${DEFAULT_CURSOR_SHAPE}${SHOW_CURSOR}`);
      try {
        return await runPick(command, { spawn, env, context });
      } finally {
        if (stopCode === null) {
          stdin.setRawMode(true);
          rawMode = true;
          processRef.on('SIGWINCH', onResize);
          stdout.on?.('resize', onResize);
        }
      }
    };
    draw();
    // After the first paint, not before: hopping the input source costs an
    // osascript launch, and the popup must not wait on it to appear. The
    // restore is owned by a detached watchdog keyed on this pid, so it fires
    // however the popup ends.
    void guardAsciiInput({ env, platform, execFile, spawn, execPath, pid: processRef.pid });

    keys = stdin[Symbol.asyncIterator]();
    for (;;) {
      const { value: chunk, done } = await keys.next();
      if (done || stopCode !== null) break;
      for (const key of decoder.push(chunk)) {
        view = reduceKey(view, key, { columns: gridColumns(view, screenSize(stdout, useColor, light)) });
        const { effect } = view;
        if (!effect) {
          draw();
          continue;
        }
        if (effect.type === 'close') return 0;
        if (effect.type === 'run') {
          if (effect.command.pick) {
            const value = await pickOnThisTerminal(effect.command);
            if (stopCode !== null) return stopCode;
            // Cancelled, failed or printed nothing: back to the list, as if enter was never pressed.
            if (value === null) {
              draw();
              continue;
            }
            await recordUsage(usageFile, usage, effect.command.id);
            // Dropped, not just ignored: with {} filled in, the runner's re-validation would reject a leftover pick.
            const { pick: _done, ...rest } = effect.command;
            spawnRunner({ kind: 'run', command: { ...rest, command: rest.command.replaceAll('{}', shellQuote(value)) } });
            return 0;
          }
          // Recorded from either view, so switching to the palette starts with real history.
          await recordUsage(usageFile, usage, effect.command.id);
          spawnRunner({ kind: 'run', command: effect.command });
          return 0;
        }
        if (effect.type === 'open-config') {
          const candidates = resolveEditors(view.doc, { env });
          // Ask only when the config names editors and more than one of them is
          // actually here — trimming the list to one is how the user says "stop
          // asking". When nothing is configured we are guessing from
          // $VISUAL/$EDITOR/PATH, and a guess should not become a question every
          // single time the config file is opened.
          const asks = (view.doc.editor ?? []).length > 0 && candidates.length > 1;
          const editor = effect.editor ?? (asks ? null : candidates[0] ?? null);
          if (editor) {
            spawnRunner({ kind: 'open-config', editor });
            return 0;
          }
          if (candidates.length === 0) {
            view = createView({
              doc: view.doc,
              usage,
              error: 'no editor found; set editor = ["your-editor"] in commands.toml, or $EDITOR',
            });
            draw();
            continue;
          }
          view = beginEditorPick(view, candidates);
          draw();
          continue;
        }
        if (effect.type === 'load-import') {
          const [commands, pluginGroups] = await Promise.all([
            readImportable(herdrConfigPath(env)),
            readInstalledPluginGroups(pluginsJsonPath(env)),
          ]);
          view = beginImport(view, [...commands, ...pluginGroups]);
          draw();
          continue;
        }
        if (effect.type === 'save') {
          try {
            const saved = await saveStore(commandsFile, effect.doc, { expectedRaw: raw });
            raw = saved.raw;
            view = createView({ doc: effect.doc, cursor: effect.cursor, usage });
          } catch (error) {
            if (!(error instanceof ConfigError)) throw error;
            view = createView({ doc: effect.doc, error: error.message });
          }
          draw();
        }
      }
    }
    if (stopCode !== null) return stopCode;
    diagnostic(stderr, 'terminal input ended before a command was chosen');
    return 1;
  } catch {
    diagnostic(stderr, 'the popup closed after an internal failure');
    return stopCode ?? 1;
  } finally {
    try {
      stdout.write(`${DEFAULT_CURSOR_SHAPE}${SHOW_CURSOR}`);
    } catch {
      // The pane is going away regardless; never mask the real exit code.
    }
    restoreRaw();
    // What leaving the for-await used to do: end the stream so the process can exit.
    try {
      await keys?.return?.();
    } catch {
      // Already ended.
    }
    for (const [signal, handler] of signalHandlers) processRef.removeListener?.(signal, handler);
    processRef.removeListener?.('SIGWINCH', onResize);
    stdout.removeListener?.('resize', onResize);
    stdin.removeListener?.('error', onStreamError);
    stdout.removeListener?.('error', onStreamError);
  }
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedAsMain()) {
  process.exitCode = await runPopup();
}
