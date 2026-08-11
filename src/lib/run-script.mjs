/**
 * CLI entry-point wiring for modules invoked directly as scripts
 * (`node <path>`): the workflow runs `node .npm-release-flow/src/<name>.mjs`
 * and the bin runs the CLI, while imports (tests, programmatic use) must
 * stay side-effect free. `runAsScript` is the single implementation of the
 * "run the main only when executed directly" concern.
 *
 * `import.meta.main` (Node 22.18.0) is newer than the package's runtime
 * floor (Node 22.14.0), so direct invocation is detected by comparing
 * `import.meta.url` with the resolved `process.argv[1]`.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Run an async main as a CLI entry point when the calling module is the
 * executed script (`process.argv[1]`). Imports are unaffected.
 *
 * @param {string} importMetaUrl `import.meta.url` of the calling module.
 * @param {() => Promise<number>} main The module's main function (the
 *   process exit code).
 * @returns {void}
 */
export function runAsScript(importMetaUrl, main) {
  if (process.argv[1] === undefined) return;
  let argvPath;
  try {
    argvPath = realpathSync(process.argv[1]);
  } catch {
    argvPath = process.argv[1];
  }
  const invoked = importMetaUrl === pathToFileURL(argvPath).href;
  if (!invoked) return;
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
