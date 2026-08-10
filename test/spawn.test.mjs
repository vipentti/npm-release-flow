import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../src/lib/errors.mjs";
import {
  runAsync,
  runSync,
  refProbeSync,
  win32CommandLine,
  win32Shell,
} from "../src/lib/spawn.mjs";

const node = process.execPath;
const code = (src) => ["-e", src];

test("runSync succeeds and captures stdout", () => {
  const result = runSync(node, code("console.log('hello')"));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.equal(result.signal, null);
});

test("runSync throws CommandError on non-zero exit", () => {
  assert.throws(
    () => runSync(node, code("process.exit(3)")),
    (err) => err instanceof CommandError && err.status === 3,
  );
});

test("runSync captures stderr on failure", () => {
  assert.throws(
    () => runSync(node, code("process.stderr.write('boom'); process.exit(1)")),
    (err) =>
      err instanceof CommandError && err.stderr === "boom" && err.status === 1,
  );
});

test("exit status 2 and another non-zero status survive and are distinguishable", () => {
  let status2 = null;
  try {
    runSync(node, code("process.exit(2)"));
  } catch (err) {
    status2 = err;
  }
  let status7 = null;
  try {
    runSync(node, code("process.exit(7)"));
  } catch (err) {
    status7 = err;
  }
  assert.ok(status2 instanceof CommandError);
  assert.ok(status7 instanceof CommandError);
  assert.equal(status2.status, 2);
  assert.equal(status7.status, 7);
  assert.notEqual(status2.status, status7.status);
});

test(
  "signal is captured when the process is terminated",
  {
    skip:
      process.platform === "win32" && "signals do not propagate through cmd",
  },
  () => {
    assert.throws(
      () =>
        runSync(node, code("setInterval(() => {}, 1000)"), { timeout: 200 }),
      (err) =>
        err instanceof CommandError &&
        err.signal === "SIGTERM" &&
        err.status === null,
    );
  },
);

test(
  "win32: timeout termination is reported without leaking the grandchild",
  { skip: process.platform !== "win32" },
  () => {
    // The timeout kills the cmd wrapper; the grandchild node process must
    // exit on its own (bounded lifetime) to avoid a leak.
    assert.throws(
      () =>
        runSync(
          node,
          code(
            "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 1500)",
          ),
          { timeout: 200 },
        ),
      (err) =>
        err instanceof CommandError && err.signal !== null && err.status !== 0,
    );
  },
);

test("refProbeSync: status 0 is present, status 2 is absent, other non-zero is an error", () => {
  const present = refProbeSync(node, code("process.exit(0)"));
  assert.equal(present.present, true);

  const absent = refProbeSync(node, code("process.exit(2)"));
  assert.equal(absent.present, false);

  assert.throws(
    () => refProbeSync(node, code("process.exit(128)")),
    (err) => err instanceof CommandError && err.status === 128,
  );
});

test("win32Shell: win32 spawns through the shell, POSIX spawns argv directly", () => {
  assert.equal(win32Shell("win32"), true);
  assert.equal(win32Shell("linux"), false);
  assert.equal(win32Shell("darwin"), false);
});

test("win32CommandLine quotes arguments with spaces or metacharacters", () => {
  // No quoting needed.
  assert.equal(
    win32CommandLine("git", ["status", "--porcelain"]),
    '"git status --porcelain"',
  );
  // Space-containing argument is quoted so it survives the shell.
  assert.equal(
    win32CommandLine("git", ["commit", "-m", "release: 1.2.3"]),
    '"git commit -m "release: 1.2.3""',
  );
  // Command path with spaces is quoted.
  assert.equal(
    win32CommandLine("C:\\path with space\\node.exe", ["-v"]),
    '""C:\\path with space\\node.exe" -v"',
  );
  // Metacharacters force quoting; embedded quotes are doubled.
  assert.equal(
    win32CommandLine("echo", ["a&b", 'say "hi"', ""]),
    '"echo "a&b" "say ""hi""" """',
  );
  // cmd treats , ; = as argument separators outside quotes.
  assert.equal(
    win32CommandLine("gh", ["--json", "number,state,url"]),
    '"gh --json "number,state,url""',
  );
});

test("runAsync resolves with captured output", async () => {
  const result = await runAsync(node, code("console.log('async-out')"));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "async-out\n");
});

test("runAsync rejects with CommandError carrying status and stderr", async () => {
  await assert.rejects(
    runAsync(node, code("process.stderr.write('async-err'); process.exit(4)")),
    (err) =>
      err instanceof CommandError &&
      err.status === 4 &&
      err.stderr === "async-err",
  );
});

test("runSync writes input to the child's stdin", () => {
  const result = runSync(
    node,
    code(
      "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => { console.log('got:' + d); });",
    ),
    {
      input: "hello stdin",
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "got:hello stdin\n");
});

test(
  "win32 .cmd stub resolves through the helper (win32 only)",
  { skip: process.platform !== "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "npmrf-spawn-"));
    try {
      writeFileSync(
        join(dir, "stub-probe.cmd"),
        "@echo off\r\necho stub-ok\r\n",
      );
      const env = { ...process.env, PATH: dir + ";" + process.env.PATH };
      const result = runSync("stub-probe", [], { env });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /stub-ok/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "POSIX spawns argv directly (no-extension executable resolves)",
  { skip: process.platform === "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "npmrf-spawn-"));
    try {
      const script = join(dir, "stub-probe");
      writeFileSync(script, "#!/bin/sh\necho posix-ok\n");
      chmodSync(script, 0o755);
      const env = { ...process.env, PATH: dir + ":" + process.env.PATH };
      const result = runSync("stub-probe", [], { env });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /posix-ok/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
