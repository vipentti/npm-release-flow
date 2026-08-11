import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommandError,
  CliError,
  ExitCode,
  describeFailure,
} from "../src/lib/errors.mjs";

test("ExitCode taxonomy is 0 success / 1 error / 2 no-op", () => {
  assert.equal(ExitCode.SUCCESS, 0);
  assert.equal(ExitCode.ERROR, 1);
  assert.equal(ExitCode.NOOP, 2);
});

test("CommandError carries stdout/stderr/status/signal with defaults", () => {
  const err = new CommandError("boom");
  assert.equal(err.name, "CommandError");
  assert.equal(err.stdout, "");
  assert.equal(err.stderr, "");
  assert.equal(err.status, null);
  assert.equal(err.signal, null);

  const detailed = new CommandError("boom", {
    stdout: "out",
    stderr: "err",
    status: 2,
    signal: "SIGTERM",
  });
  assert.equal(detailed.stdout, "out");
  assert.equal(detailed.stderr, "err");
  assert.equal(detailed.status, 2);
  assert.equal(detailed.signal, "SIGTERM");
});

test("CliError maps to an exit code, error by default", () => {
  assert.equal(new CliError("x").exitCode, ExitCode.ERROR);
  assert.equal(
    new CliError("x", { exitCode: ExitCode.NOOP }).exitCode,
    ExitCode.NOOP,
  );
});

test("describeFailure states checked/found/correction", () => {
  const msg = describeFailure({
    checked: "the remote tag v1.2.3",
    found: "no such ref",
    correction: "create it or pick another version",
  });
  assert.match(msg, /Checked: the remote tag v1\.2\.3\./);
  assert.match(msg, /Found: no such ref\./);
  assert.match(msg, /Correction: create it or pick another version\./);
});
