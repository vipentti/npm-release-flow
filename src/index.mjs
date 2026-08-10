/**
 * Programmatic entry point: the package is both the CLI and the workflow's
 * logic. Re-exports the CLI `main` plus the shared libs so consumers and the
 * job scripts import the same code.
 */

export { main } from "../bin/npm-release-flow.mjs";
export { prepare } from "./commands/prepare.mjs";
export { tag } from "./commands/tag.mjs";
export { check } from "./commands/check.mjs";
export * from "./lib/errors.mjs";
export * from "./lib/spawn.mjs";
export * from "./lib/versions.mjs";
export * from "./lib/changelog.mjs";
export * from "./lib/control-files.mjs";
export * from "./lib/release-state.mjs";
export * from "./lib/tag-verify.mjs";
export * from "./lib/app-token.mjs";
export * from "./lib/repo-state.mjs";
