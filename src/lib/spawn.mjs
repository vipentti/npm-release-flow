/**
 * The single subprocess helper: sync and async variants that
 * capture stdout/stderr, resolve Windows `.cmd` wrappers here once (win32
 * spawns through the shell per PATHEXT, POSIX spawns argv directly), and raise
 * a typed `CommandError` carrying stdout/stderr plus the numeric exit status
 * and the terminating signal when applicable. No other module in the kit
 * spawns a subprocess.
 *
 * Win32 note: Node's `shell: true` concatenates arguments unquoted (DEP0190),
 * which corrupts any argument containing spaces (e.g. `git commit -m
 * "release: 1.2.3"`). Instead the helper builds a properly quoted command
 * line and spawns `cmd.exe /d /s /c` with `windowsVerbatimArguments`, so
 * `.cmd` wrappers still resolve through PATHEXT while every argument reaches
 * the child verbatim.
 */

import { spawn, spawnSync } from "node:child_process";
import { CommandError } from "./errors.mjs";

/**
 * Whether subprocesses must be spawned through the shell.
 *
 * On Windows, commands without an executable extension (e.g. `gh`) resolve
 * through PATHEXT, so `.cmd` wrappers are reachable only via a shell. POSIX
 * spawns the argv directly to keep arguments verbatim.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function win32Shell(platform = process.platform) {
  return platform === "win32";
}

/**
 * Convert a native Windows absolute path to the MSYS2/POSIX form the
 * Git-bundled MSYS2 tools (gpg, tar) read correctly, e.g.
 * `C:\foo\bar` -> `/c/foo/bar`. Passed a native path, those binaries
 * misread it as cwd-relative on win32 (`gpg: keyblock resource
 * '<cwd>/C:\...' No such file or directory`), so every path handed to a
 * MSYS2 tool is converted here. No-op on POSIX and for non-drive-letter
 * paths, so CI and the kit behavior are unchanged.
 *
 * @param {string} path
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function msysPath(path, platform = process.platform) {
  if (platform !== "win32") return path;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (match === null) return path;
  return `/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

/**
 * Quote a single argument for cmd.exe: wrap in double quotes when it is empty
 * or contains whitespace or a cmd metacharacter (`&|<>()^"` separators, `,;=`
 * argument separators, `%!` variable syntax), doubling embedded quotes. `%`
 * is not neutralized (cmd expands variables even inside quotes); the kit
 * never passes arguments containing `%`.
 *
 * @param {string} arg
 * @returns {string}
 */
function cmdQuote(arg) {
  if (arg === "") return '""';
  if (/[ \t\n&|<>()^"%!,;=]/.test(arg)) {
    return '"' + arg.replace(/"/g, '""') + '"';
  }
  return arg;
}

/**
 * Build the command line passed to `cmd.exe /d /s /c` for a win32 spawn.
 *
 * The whole line is wrapped in an outer quote pair so `/S` strips exactly
 * that pair and executes the inner command line (the canonical cmd form).
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
export function win32CommandLine(command, args) {
  return `"${[command, ...args].map(cmdQuote).join(" ")}"`;
}

/**
 * @typedef {object} SpawnOptions
 * @property {string} [cwd] Working directory for the child.
 * @property {NodeJS.ProcessEnv} [env] Environment for the child.
 * @property {number} [maxBuffer] Largest amount of captured output in bytes.
 * @property {number} [timeout] Milliseconds before the child is killed.
 * @property {string | Buffer | null} [input] Data written to the child's
 *   stdin (sync variant only).
 */

/**
 * @typedef {object} SpawnResult
 * @property {number|null} status Numeric exit status, or null when the child
 *   was terminated by a signal.
 * @property {string} stdout Captured standard output.
 * @property {string} stderr Captured standard error.
 * @property {string|null} signal Terminating signal, or null when the child
 *   exited normally.
 */

/**
 * Resolve the spawn vector: win32 spawns `cmd.exe` with the quoted command
 * line (PATHEXT resolution happens here, once); POSIX spawns the argv
 * directly.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {{ file: string, args: string[], windowsVerbatimArguments: boolean }}
 */
function spawnVector(command, args) {
  if (win32Shell()) {
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", win32CommandLine(command, args)],
      windowsVerbatimArguments: true,
    };
  }
  return { file: command, args, windowsVerbatimArguments: false };
}

/**
 * Run a command synchronously and capture stdout/stderr.
 *
 * Resolves to a `SpawnResult` on exit status 0. Any other outcome raises a
 * `CommandError` carrying the captured output, the numeric exit status, and
 * the terminating signal when applicable.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {SpawnOptions} [options]
 * @returns {SpawnResult}
 */
export function runSync(command, args = [], options = {}) {
  const vector = spawnVector(command, args);
  const result = spawnSync(vector.file, vector.args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    input: options.input ?? undefined,
    windowsVerbatimArguments: vector.windowsVerbatimArguments,
    encoding: "utf8",
  });
  const summary = {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    signal: result.signal,
  };
  if (result.error) {
    throw new CommandError(
      `Failed to spawn ${command}: ${result.error.message}`,
      summary,
    );
  }
  if (result.status !== 0) {
    const why = result.signal
      ? `terminated by signal ${result.signal}`
      : `exited with status ${String(result.status)}`;
    throw new CommandError(`${command} ${why}`, summary);
  }
  return summary;
}

/**
 * Run a command asynchronously and capture stdout/stderr.
 *
 * Resolves to a `SpawnResult` on exit status 0 and rejects with a
 * `CommandError` otherwise (same payload as `runSync`).
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {SpawnOptions} [options]
 * @returns {Promise<SpawnResult>}
 */
export function runAsync(command, args = [], options = {}) {
  /** @type {Promise<SpawnResult>} */
  const promise = new Promise((resolve, reject) => {
    const vector = spawnVector(command, args);
    const child =
      /** @type {import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>} */ (
        spawn(vector.file, vector.args, {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeout,
          windowsVerbatimArguments: vector.windowsVerbatimArguments,
          stdio: ["ignore", "pipe", "pipe"],
        })
      );
    let stdout = "";
    let stderr = "";
    const out = child.stdout;
    const errOut = child.stderr;
    if (out) {
      out.setEncoding("utf8");
      out.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (errOut) {
      errOut.setEncoding("utf8");
      errOut.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", (err) => {
      reject(
        new CommandError(`Failed to spawn ${command}: ${err.message}`, {
          stdout,
          stderr,
          status: null,
          signal: null,
        }),
      );
    });
    child.on("close", (code, signal) => {
      const summary = { status: code, stdout, stderr, signal };
      if (code !== 0) {
        const why = signal
          ? `terminated by signal ${signal}`
          : code === null
            ? "terminated"
            : `exited with status ${String(code)}`;
        reject(new CommandError(`${command} ${why}`, summary));
      } else {
        resolve(summary);
      }
    });
  });
  return promise;
}

/**
 * Ref-probe semantics for `git ls-remote --exit-code` style probes
 * (T3/T4/T9): only exit status 2 means "ref absent"; every other non-zero
 * status (auth/network failures) propagates as a `CommandError`, never as
 * absent.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {SpawnOptions} [options]
 * @returns {{ present: boolean, stdout: string, stderr: string }}
 */
export function refProbeSync(command, args = [], options = {}) {
  try {
    const result = runSync(command, args, options);
    return { present: true, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    if (err instanceof CommandError && err.status === 2) {
      return { present: false, stdout: err.stdout, stderr: err.stderr };
    }
    throw err;
  }
}
