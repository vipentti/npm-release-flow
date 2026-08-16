import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommandError,
  CliError,
  ExitCode,
  describeFailure,
  commandFailureDetail,
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

test("commandFailureDetail: stderr-only returns trimmed stderr", () => {
  const err = new CommandError("fail", { stdout: "", stderr: "  oops\n" });
  assert.equal(commandFailureDetail(err), "oops");
});

test("commandFailureDetail: stdout-only returns trimmed stdout", () => {
  const err = new CommandError("fail", {
    stdout: "  hello stdout  \n",
    stderr: "",
  });
  assert.equal(commandFailureDetail(err), "hello stdout");
});

test("commandFailureDetail: both streams returns stderr and drops stdout", () => {
  const err = new CommandError("fail", {
    stdout: "stdout-detail",
    stderr: "  stderr-detail  ",
  });
  assert.equal(commandFailureDetail(err), "stderr-detail");
});

test("commandFailureDetail: whitespace-only stderr falls back to stdout", () => {
  const err = new CommandError("fail", {
    stdout: "fallback",
    stderr: "   \n  ",
  });
  assert.equal(commandFailureDetail(err), "fallback");
});

test("commandFailureDetail: empty both streams returns empty string", () => {
  const err = new CommandError("fail", { stdout: "", stderr: "" });
  assert.equal(commandFailureDetail(err), "");
  const whitespace = new CommandError("fail", {
    stdout: "   ",
    stderr: " \n ",
  });
  assert.equal(commandFailureDetail(whitespace), "");
});

test("commandFailureDetail: non-CommandError returns String(err)", () => {
  assert.equal(commandFailureDetail(new Error("plain error")), "Error: plain error");
  assert.equal(commandFailureDetail("string oops"), "string oops");
  assert.equal(commandFailureDetail(42), "42");
});

test("commandFailureDetail: selected detail longer than limit is truncated to 8192 with marker", () => {
  const long = "a".repeat(9000);
  const err = new CommandError("fail", { stdout: "", stderr: long });
  const detail = commandFailureDetail(err);
  assert.equal(detail.length, 8192);
  assert.ok(detail.endsWith("\n...[truncated]"));
  assert.equal(detail.slice(0, 8192 - "\n...[truncated]".length), "a".repeat(8192 - "\n...[truncated]".length));
});

test("commandFailureDetail: long stdout plus non-empty stderr selects stderr and caps it", () => {
  const longStdout = "x".repeat(9000);
  const longStderr = "y".repeat(9000);
  const err = new CommandError("fail", {
    stdout: longStdout,
    stderr: longStderr,
  });
  const detail = commandFailureDetail(err);
  assert.equal(detail.length, 8192);
  assert.ok(detail.endsWith("\n...[truncated]"));
  assert.ok(detail.startsWith("y"));
  assert.ok(!detail.includes("x"));
});

test("commandFailureDetail: long stdout-only is capped with marker", () => {
  const long = "z".repeat(9000);
  const err = new CommandError("fail", { stdout: long, stderr: "" });
  const detail = commandFailureDetail(err);
  assert.equal(detail.length, 8192);
  assert.ok(detail.endsWith("\n...[truncated]"));
});

test("commandFailureDetail: non-CommandError long string is capped", () => {
  const long = "q".repeat(9000);
  const detail = commandFailureDetail(long);
  assert.equal(detail.length, 8192);
  assert.ok(detail.endsWith("\n...[truncated]"));
});
