#!/usr/bin/env node
/**
 * npm-release-flow CLI entry point: `prepare`, `tag`, and `check` with
 * dry-run default, `--execute` mutation, and exit codes 0/1/2.
 * Argument parsing via `node:util` `parseArgs`; usage + exit 1 for a missing
 * or unknown subcommand or an unknown flag.
 */

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { CliError, ExitCode } from "../src/lib/errors.mjs";
import { prepare } from "../src/commands/prepare.mjs";
import { tag } from "../src/commands/tag.mjs";
import { check } from "../src/commands/check.mjs";

const SUBCOMMANDS = ["prepare", "tag", "check"];

/**
 * @returns {string}
 */
function usageText() {
  return [
    "usage: npm-release-flow <prepare|tag|check> [--execute] [--version X.Y.Z]",
    "",
    "Commands:",
    "  prepare  Cut a release branch and open the release PR (--version required)",
    "  tag      Create and push the signed release tag on the release merge (--version required)",
    "  check    Validate the release prerequisites (non-mutating)",
    "",
    "Options:",
    "  --execute    Perform mutations (dry-run is the default)",
    "  --version X  Stable version to release (prepare/tag)",
    "  -h, --help   Show this help",
    "",
  ].join("\n");
}

/**
 * @typedef {object} MainOptions
 * @property {string} [cwd] Repository root the commands operate on.
 * @property {NodeJS.ProcessEnv} [env] Environment for the commands.
 * @property {(line: string) => void} [log] Plan-line sink.
 */

/**
 * Run the CLI and return the exit code.
 *
 * @param {string[]} [argv]
 * @param {MainOptions} [options]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        version: { type: "string" },
        execute: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    console.error(
      `npm-release-flow: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(usageText());
    return ExitCode.ERROR;
  }

  if (values.help) {
    console.log(usageText());
    return ExitCode.SUCCESS;
  }
  const subcommand = positionals[0];
  if (subcommand === undefined) {
    console.error(
      "npm-release-flow: missing subcommand (expected prepare, tag, or check)",
    );
    console.error(usageText());
    return ExitCode.ERROR;
  }
  if (!SUBCOMMANDS.includes(subcommand)) {
    console.error(
      `npm-release-flow: unknown subcommand ${JSON.stringify(subcommand)} (expected prepare, tag, or check)`,
    );
    console.error(usageText());
    return ExitCode.ERROR;
  }
  if (positionals.length > 1) {
    console.error(
      `npm-release-flow: unexpected extra argument(s): ${positionals.slice(1).join(" ")}`,
    );
    console.error(usageText());
    return ExitCode.ERROR;
  }
  if ((subcommand === "prepare" || subcommand === "tag") && !values.version) {
    console.error(
      `npm-release-flow: --version X.Y.Z is required for ${subcommand}`,
    );
    console.error(usageText());
    return ExitCode.ERROR;
  }

  const runOptions = {
    cwd: options.cwd,
    env: options.env,
    log: options.log,
  };
  try {
    if (subcommand === "prepare") {
      return await prepare(
        {
          version: /** @type {string} */ (values.version),
          execute: values.execute ?? false,
        },
        runOptions,
      );
    }
    if (subcommand === "tag") {
      return await tag(
        {
          version: /** @type {string} */ (values.version),
          execute: values.execute ?? false,
        },
        runOptions,
      );
    }
    return await check({ execute: values.execute ?? false }, runOptions);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(err.message);
      return err.exitCode;
    }
    console.error(
      `npm-release-flow: ${err instanceof Error ? err.message : String(err)}`,
    );
    return ExitCode.ERROR;
  }
}

// Run the CLI only when invoked directly; importing the bin for tests or for
// the programmatic surface must not execute it.
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().then((code) => {
    process.exitCode = code;
  });
}
