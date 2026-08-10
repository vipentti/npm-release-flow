/**
 * Exit-code taxonomy and error types for the npm-release-flow CLI.
 *
 * Exit codes are the programmatic contract (blueprint §8): 0 = success,
 * 1 = error, 2 = no-op / already done. Failures are distinguishable
 * programmatically, not only by message.
 *
 * Error-content contract (blueprint §8): every failure message must state,
 * always, what was checked, what state was actually found, and the correction
 * action. `describeFailure` composes that triple consistently; command-level
 * messages use it so the contract holds everywhere.
 */

/**
 * Exit-code taxonomy (blueprint §8).
 * @type {{ readonly SUCCESS: 0, readonly ERROR: 1, readonly NOOP: 2 }}
 */
export const ExitCode = Object.freeze({
  /** Success. */
  SUCCESS: 0,
  /** Error; the failure message carries the error-content contract. */
  ERROR: 1,
  /** No-op / already done (e.g. a release PR already exists). */
  NOOP: 2,
});

/**
 * Typed error raised by the spawn helper when a subprocess fails.
 *
 * Carries the captured stdout/stderr plus the numeric exit status and the
 * terminating signal when applicable, so callers can distinguish exit status 2
 * (ref absent in `git ls-remote --exit-code` probes) from every other
 * non-zero outcome (auth/network failures), which propagate as errors and are
 * never treated as absent.
 */
export class CommandError extends Error {
  /**
   * @param {string} message
   * @param {{ stdout?: string, stderr?: string, status?: number|null, signal?: string|null }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "CommandError";
    /** @type {string} */
    this.stdout = details.stdout ?? "";
    /** @type {string} */
    this.stderr = details.stderr ?? "";
    /** @type {number|null} */
    this.status = details.status ?? null;
    /** @type {string|null} */
    this.signal = details.signal ?? null;
  }
}

/**
 * Error that maps to a CLI exit code (blueprint §8).
 */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "CliError";
    /** @type {number} */
    this.exitCode = options.exitCode ?? ExitCode.ERROR;
  }
}

/**
 * Compose a failure message honoring the error-content contract: what was
 * checked, what state was actually found, and the correction action.
 *
 * @param {{ checked: string, found: string, correction: string }} parts
 * @returns {string}
 */
export function describeFailure({ checked, found, correction }) {
  return `Checked: ${checked}. Found: ${found}. Correction: ${correction}.`;
}
