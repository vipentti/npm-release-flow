/**
 * Release job mutation orchestration (§9 boundaries 4-6, T10). Env-driven:
 * `VERSION` from detect, `TAG_EXISTS` from the tag-probe step output (used
 * as-is; no pre-mutation re-probe), `GITHUB_SHA`, `GITHUB_REPOSITORY`,
 * `GNUPGHOME` and `PACKAGE_TARBALL` inherited through `$GITHUB_ENV`,
 * `NPM_RELEASE_FLOW_GPG_FINGERPRINT` from the repository variable,
 * `NPM_RELEASE_FLOW_APP_TOKEN` from the App-token step (only when
 * `tag-exists=false`), `GH_TOKEN` from `github.token`. None of the inputs
 * are guessed at runtime.
 *
 * Boundary 4: tag push (create-then-verify-then-push with the App token;
 * tag present -> fetch + verify-only, private material never loaded;
 * divergent -> hard fail), plus the GitHub API signature-verification poll.
 * Boundary 5: publish (verify-or-idempotent, registry pinned to npmjs.com).
 * Boundary 6: GitHub Release (create or edit, idempotent).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  describeFailure,
  CliError,
  CommandError,
  ExitCode,
} from "./lib/errors.mjs";
import { git, gh } from "./lib/repo-state.mjs";
import { runSync } from "./lib/spawn.mjs";
import { parseStableVersion } from "./lib/versions.mjs";
import { releaseNotes } from "./lib/changelog.mjs";
import { integrityOfFile } from "./lib/pack-contract.mjs";

const NPM_REGISTRY = "https://registry.npmjs.org";
const shaPattern = /^[0-9a-f]{40}$/;
const fingerprintPattern = /^[0-9a-fA-F]{40}$/;

/**
 * @typedef {Object} ReleaseOptions
 * @property {string} [cwd] Repository root (the consumer workspace).
 * @property {NodeJS.ProcessEnv} [env] Environment.
 * @property {(line: string) => void} [log] Output sink.
 */

/**
 * @param {string} line
 * @returns {void}
 */
function consoleLog(line) {
  console.log(line);
}

/**
 * Sleep helper (kept tiny so tests can override timing if needed).
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Fully verify the local annotated tag against the triggering SHA: annotated
 * object, target, subject `Release v<version>`, exactly one VALIDSIG whose
 * primary fingerprint equals the configured fingerprint.
 *
 * @param {{ version: string, targetSha: string, fingerprint: string, cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {string} The tag object SHA.
 */
export function verifyTagObject({ version, targetSha, fingerprint, cwd, env }) {
  const ctx = { cwd, env };
  const tagRef = `refs/tags/v${version}`;
  const type = git(["cat-file", "-t", tagRef], ctx).stdout.trim();
  if (type !== "tag") {
    throw new CliError(
      describeFailure({
        checked: `that v${version} is an annotated tag object`,
        found: `it is a ${type} object`,
        correction: "the tag must be annotated and signed",
      }),
    );
  }
  const target = git(["rev-parse", `${tagRef}^{commit}`], ctx).stdout.trim();
  if (target !== targetSha) {
    throw new CliError(
      describeFailure({
        checked: `that v${version} points at the triggering commit`,
        found: `the tag points at ${target.slice(0, 8)}, not ${targetSha.slice(0, 8)}`,
        correction: "the tag must point at the release commit",
      }),
    );
  }
  const tagBody = git(["cat-file", "tag", tagRef], ctx).stdout;
  if (!tagBody.includes(`\n\nRelease v${version}\n`)) {
    throw new CliError(
      describeFailure({
        checked: `that the tag subject is "Release v${version}"`,
        found: "the tag message differs",
        correction: "recreate the tag with the subject 'Release v<version>'",
      }),
    );
  }
  const raw = git(["verify-tag", "--raw", tagRef], ctx).stderr;
  const validsigs = [...raw.matchAll(/\[GNUPG:\] VALIDSIG ([0-9A-Fa-f]{40})/g)];
  if (validsigs.length !== 1) {
    throw new CliError(
      describeFailure({
        checked: `that v${version} has exactly one valid GPG signature`,
        found: `${validsigs.length} VALIDSIG line(s)`,
        correction: "the tag must be signed by exactly one key",
      }),
    );
  }
  if (validsigs[0][1].toLowerCase() !== fingerprint) {
    throw new CliError(
      describeFailure({
        checked: "that the signature's primary fingerprint matches NPM_RELEASE_FLOW_GPG_FINGERPRINT",
        found: validsigs[0][1],
        correction: "the tag must be signed with the configured release key",
      }),
    );
  }
  // The tag object SHA (without dereferencing) is what GitHub's API verifies.
  return git(["rev-parse", tagRef], ctx).stdout.trim();
}

/**
 * Boundary 4, tag-creation path: create the annotated signed tag on the
 * triggering SHA (create-then-verify-then-push — no partial-mutation
 * window), push App-token-authenticated, and verify the remote object
 * equals the local one. The push is the final tag check: a divergent remote
 * tag rejects the push (hard fail), an identical tag is an idempotent no-op.
 *
 * @param {{ version: string, targetSha: string, fingerprint: string, appToken: string, cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {string} The tag object SHA.
 */
export function createAndPushTag({
  version,
  targetSha,
  fingerprint,
  appToken,
  cwd,
  env,
}) {
  const ctx = { cwd, env };
  const tagRef = `refs/tags/v${version}`;
  runSync(
    "git",
    [
      "tag",
      "-a",
      "-s",
      "-u",
      fingerprint,
      "-m",
      `Release v${version}`,
      `v${version}`,
      targetSha,
    ],
    ctx,
  );
  const tagObject = verifyTagObject({
    version,
    targetSha,
    fingerprint,
    cwd,
    env,
  });
  runSync(
    "git",
    [
      "-c",
      `http.extraheader=Authorization: Bearer ${appToken}`,
      "push",
      "origin",
      tagRef,
    ],
    ctx,
  );
  const verified = git(["ls-remote", "origin", tagRef], ctx)
    .stdout.trim()
    .split(/\s+/)[0];
  if (!shaPattern.test(verified ?? "") || verified !== tagObject) {
    throw new CliError(
      describeFailure({
        checked: "that the remote tag object equals the local tag object",
        found:
          !shaPattern.test(verified ?? "")
            ? "the remote tag is absent"
            : `remote ${verified.slice(0, 8)} != local ${tagObject.slice(0, 8)}`,
        correction:
          "resolve the remote tag state manually (a divergent remote tag rejects the push)",
      }),
    );
  }
  return tagObject;
}

/**
 * Boundary 4, verify-only path (rerun with the tag present): fetch the
 * remote tag and fully verify it. Private material is never loaded on this
 * path (the job loads only the public key), so no App token is involved.
 *
 * @param {{ version: string, targetSha: string, fingerprint: string, cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {string} The verified tag object SHA.
 */
export function verifyOnlyTag({ version, targetSha, fingerprint, cwd, env }) {
  const ctx = { cwd, env };
  const tagRef = `refs/tags/v${version}`;
  // Explicit refspec (destination written): a lightweight remote tag would
  // not create a local ref with the implicit `fetch origin <ref>` form.
  runSync("git", ["fetch", "origin", `+${tagRef}:${tagRef}`], ctx);
  return verifyTagObject({ version, targetSha, fingerprint, cwd, env });
}

/**
 * GitHub API signature-verification poll (§9 boundary 4): the annotated tag
 * object's `.verification.verified` must become true (polled). The API
 * verification is the workflow-side proof that GitHub itself validates the
 * signature.
 *
 * @param {{ owner: string, repo: string, tagObject: string, cwd: string, env: NodeJS.ProcessEnv, attempts?: number, delayMs?: number }} ctx
 * @returns {Promise<void>}
 */
export async function pollGithubSignatureVerification({
  owner,
  repo,
  tagObject,
  cwd,
  env,
  attempts = 30,
  delayMs = 2000,
}) {
  const ctx = { cwd, env };
  for (let i = 0; i < attempts; i++) {
    let verified;
    try {
      const result = gh(
        [
          "api",
          `repos/${owner}/${repo}/git/tags/${tagObject}`,
          "--jq",
          ".verification.verified",
        ],
        ctx,
      );
      verified = result.stdout.trim();
    } catch (err) {
      const detail =
        err instanceof CommandError ? err.stderr.trim() : String(err);
      throw new CliError(
        describeFailure({
          checked: `GitHub's signature verification for the tag object ${tagObject.slice(0, 8)}`,
          found: detail || "gh api failed",
          correction: "check the tag object exists and is signed",
        }),
      );
    }
    if (verified === "true") {
      return;
    }
    if (verified !== "false" && verified !== "null") {
      throw new CliError(
        describeFailure({
          checked: `GitHub's signature verification for the tag object ${tagObject.slice(0, 8)}`,
          found: `unexpected verification state ${JSON.stringify(verified)}`,
          correction: "inspect the tag object via the API",
        }),
      );
    }
    await sleep(delayMs);
  }
  throw new CliError(
    describeFailure({
      checked: `that GitHub reports the tag signature verified`,
      found: `verification did not become true within ${attempts} polls`,
      correction: "re-run the job; the tag may still be propagating",
    }),
  );
}

/**
 * Parse the consumer's package name from the workspace manifest.
 *
 * @param {string} cwd
 * @returns {{ name: string, version: string, repositoryUrl: string | null }}
 */
function readWorkspaceManifest(cwd) {
  const manifest = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
  const name =
    typeof manifest.name === "string" && manifest.name !== ""
      ? manifest.name
      : null;
  if (name === null) {
    throw new CliError(
      describeFailure({
        checked: "package.json.name",
        found: "the manifest name is missing or empty",
        correction: "the consumer must declare a package name",
      }),
    );
  }
  const version =
    typeof manifest.version === "string" ? manifest.version : null;
  if (version === null) {
    throw new CliError(
      describeFailure({
        checked: "package.json.version",
        found: "the manifest version is missing",
        correction: "the release commit must carry the version",
      }),
    );
  }
  const repositoryUrl =
    typeof manifest.repository?.url === "string"
      ? manifest.repository.url
      : null;
  return { name, version, repositoryUrl };
}

/**
 * `npm view <name>@<version> --registry` result, or null when the version is
 * not on the registry. Registry is pinned explicitly on every call so a
 * consumer `.npmrc` cannot redirect the check.
 *
 * @param {{ name: string, version: string, cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {Record<string, any> | null}
 */
export function viewPublishedVersion({ name, version, cwd, env }) {
  let result;
  try {
    result = runSync(
      "npm",
      ["view", `${name}@${version}`, "--json", "--registry", NPM_REGISTRY],
      { cwd, env },
    );
  } catch (err) {
    if (err instanceof CommandError && err.status === 1) {
      return null;
    }
    throw err;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CliError(
      describeFailure({
        checked: `the published ${name}@${version} manifest`,
        found: "npm view returned malformed JSON",
        correction: "inspect the registry state manually",
      }),
    );
  }
}

/**
 * Whether a newer stable version of the package exists on the registry.
 *
 * @param {{ name: string, current: string, cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {boolean}
 */
export function newerStableExists({ name, current, cwd, env }) {
  const currentParts = parseStableVersion(current);
  if (currentParts === null) return false;
  const result = runSync(
    "npm",
    ["view", name, "versions", "--json", "--registry", NPM_REGISTRY],
    { cwd, env },
  );
  const versions = JSON.parse(result.stdout);
  const newer = (Array.isArray(versions) ? versions : []).filter((v) => {
    const parts = parseStableVersion(v);
    if (parts === null) return false;
    for (let i = 0; i < 3; i++) {
      if (parts[i] !== currentParts[i]) return parts[i] > currentParts[i];
    }
    return false;
  });
  return newer.length > 0;
}

/**
 * Boundary 5 identity/integrity verify of a published version against the
 * workspace manifest and the verified tarball. `gitHead` is checked only
 * when present (tarball-path publishes may omit it; integrity + provenance
 * already bind the published artifact).
 *
 * @param {{ published: Record<string, any>, name: string, version: string, repositoryUrl: string | null, gitHead: string | null, tarballPath: string }} ctx
 * @returns {string[]} Problems (empty when the published artifact matches).
 */
export function publishedIdentityProblems({
  published,
  name,
  version,
  repositoryUrl,
  gitHead,
  tarballPath,
}) {
  const problems = [];
  if (published.name !== name) {
    problems.push(
      `published name ${JSON.stringify(published.name)} does not match ${JSON.stringify(name)}`,
    );
  }
  if (published.version !== version) {
    problems.push(
      `published version ${JSON.stringify(published.version)} does not match ${JSON.stringify(version)}`,
    );
  }
  const publishedRepo = published.repository?.url ?? null;
  if (repositoryUrl !== null && publishedRepo !== repositoryUrl) {
    problems.push(
      `published repository ${JSON.stringify(publishedRepo)} does not match the source ${JSON.stringify(repositoryUrl)}`,
    );
  }
  const packedIntegrity = integrityOfFile(tarballPath);
  if (published.dist?.integrity !== packedIntegrity) {
    problems.push(
      `published dist.integrity does not equal the packed integrity (${packedIntegrity.slice(0, 24)}...)`,
    );
  }
  if (gitHead !== null && published.gitHead !== undefined && published.gitHead !== gitHead) {
    problems.push(
      `published gitHead ${JSON.stringify(published.gitHead)} does not match the triggering commit ${JSON.stringify(gitHead)}`,
    );
  }
  return problems;
}

/**
 * Boundary 5: publish the verified tarball, verify-or-idempotent.
 * Present -> identity/integrity verify. Absent -> refuse if a newer stable
 * version exists on the registry, else publish with the registry pinned and
 * provenance, wait for packument visibility, then apply the same verify.
 *
 * @param {{ version: string, name: string, repositoryUrl: string | null, gitHead: string, tarballPath: string, cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {Promise<void>}
 */
export async function publishRelease({
  version,
  name,
  repositoryUrl,
  gitHead,
  tarballPath,
  cwd,
  env,
}) {
  /**
   * @param {Record<string, any>} published
   * @returns {void}
   */
  const verify = (published) => {
    const problems = publishedIdentityProblems({
      published,
      name,
      version,
      repositoryUrl,
      gitHead,
      tarballPath,
    });
    if (problems.length > 0) {
      throw new CliError(
        describeFailure({
          checked: `the published ${name}@${version}`,
          found: problems.join("; "),
          correction:
            "resolve the registry state manually; never publish a second tarball over it",
        }),
      );
    }
  };

  const existing = viewPublishedVersion({ name, version, cwd, env });
  if (existing !== null) {
    verify(existing);
    return;
  }
  if (newerStableExists({ name, current: version, cwd, env })) {
    throw new CliError(
      describeFailure({
        checked: `whether a newer stable version of ${name} exists on the registry`,
        found: "a newer stable version is already published",
        correction:
          "resolve the registry state manually; refusing to publish over a newer version",
      }),
    );
  }
  runSync(
    "npm",
    [
      "publish",
      tarballPath,
      "--ignore-scripts",
      "--access",
      "public",
      "--provenance",
      "--registry",
      NPM_REGISTRY,
    ],
    { cwd, env },
  );
  // Wait for packument visibility (npm publish is eventually consistent).
  for (let i = 0; i < 30; i++) {
    const visible = viewPublishedVersion({ name, version, cwd, env });
    if (visible !== null) {
      verify(visible);
      return;
    }
    await sleep(2000);
  }
  throw new CliError(
    describeFailure({
      checked: "that the published version is visible in the packument",
      found: `${name}@${version} did not appear within the visibility wait`,
      correction: "inspect the registry state manually",
    }),
  );
}

/**
 * Boundary 6: ensure the GitHub Release exists, verify-or-idempotent.
 * Present -> edit (title + notes, repairs broken notes); absent -> create
 * with `--verify-tag` (the last mutation; nothing follows it but key
 * teardown).
 *
 * @param {{ version: string, notes: string, cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {Promise<void>}
 */
export async function ensureGithubRelease({ version, notes, cwd, env }) {
  const ctx = { cwd, env };
  const title = `Release v${version}`;
  let present = false;
  try {
    gh(["release", "view", `v${version}`], ctx);
    present = true;
  } catch (err) {
    if (err instanceof CommandError && err.status === 1) {
      present = false;
    } else {
      const detail =
        err instanceof CommandError ? err.stderr.trim() : String(err);
      throw new CliError(
        describeFailure({
          checked: `whether the release v${version} exists`,
          found: detail || "gh release view failed",
          correction: "check gh permissions on the repository",
        }),
      );
    }
  }
  if (present) {
    runSync(
      "gh",
      ["release", "edit", `v${version}`, "--title", title, "--notes", notes],
      ctx,
    );
  } else {
    runSync(
      "gh",
      [
        "release",
        "create",
        `v${version}`,
        "--title",
        title,
        "--notes",
        notes,
        "--verify-tag",
      ],
      ctx,
    );
  }
}

/**
 * Run the release job script.
 *
 * @param {ReleaseOptions} [options]
 * @returns {Promise<number>} 0 on success, 1 on hard fail (CliError carries
 *   the error-content message).
 */
export async function release(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? consoleLog;
  try {
    const version = env.VERSION ?? "";
    if (parseStableVersion(version) === null) {
      throw new CliError(
        describeFailure({
          checked: "VERSION",
          found:
            version === ""
              ? "the environment variable is not set"
              : `${JSON.stringify(version)} is not a stable X.Y.Z version`,
          correction: "wire VERSION from the detect job's version output",
        }),
      );
    }
    const targetSha = env.GITHUB_SHA ?? "";
    if (!shaPattern.test(targetSha)) {
      throw new CliError(
        describeFailure({
          checked: "GITHUB_SHA",
          found:
            targetSha === ""
              ? "the environment variable is not set"
              : `${JSON.stringify(targetSha)} is not a 40-character SHA`,
          correction: "run in the GitHub Actions workflow context",
        }),
      );
    }
    const repository = env.GITHUB_REPOSITORY ?? "";
    if (!/^[^/]+\/[^/]+$/.test(repository)) {
      throw new CliError(
        describeFailure({
          checked: "GITHUB_REPOSITORY",
          found: JSON.stringify(repository),
          correction: "the workflow must run in the consumer repository",
        }),
      );
    }
    const [owner, repo] = repository.split("/");
    const fingerprintRaw = env.NPM_RELEASE_FLOW_GPG_FINGERPRINT ?? "";
    if (!fingerprintPattern.test(fingerprintRaw)) {
      throw new CliError(
        describeFailure({
          checked: "NPM_RELEASE_FLOW_GPG_FINGERPRINT",
          found:
            fingerprintRaw === ""
              ? "the environment variable is not set"
              : `${JSON.stringify(fingerprintRaw)} is not 40 hex characters`,
          correction: "declare the fingerprint as a repository variable",
        }),
      );
    }
    const fingerprint = fingerprintRaw.toLowerCase();

    const tagExists = (env.TAG_EXISTS ?? "").trim() === "true";
    const manifest = readWorkspaceManifest(cwd);
    if (manifest.version !== version) {
      throw new CliError(
        describeFailure({
          checked: "that the workspace manifest version equals the release version",
          found: `package.json.version is ${JSON.stringify(manifest.version)}, expected ${JSON.stringify(version)}`,
          correction: "the release commit must carry the released version",
        }),
      );
    }

    log(`[release] version ${version} at ${targetSha.slice(0, 8)} (tag-exists=${tagExists})`);

    // --- Boundary 4: tag push or verify-only ---

    let tagObject;
    if (tagExists) {
      // Verify-only path: private material never loaded, no App token.
      tagObject = verifyOnlyTag({
        version,
        targetSha,
        fingerprint,
        cwd,
        env,
      });
      log(`[release] tag v${version} verified (verify-only path)`);
    } else {
      const appToken = env.NPM_RELEASE_FLOW_APP_TOKEN ?? "";
      if (appToken === "") {
        throw new CliError(
          describeFailure({
            checked: "NPM_RELEASE_FLOW_APP_TOKEN",
            found: "the environment variable is not set or empty",
            correction:
              "wire the token from the App-token step (the tag push must authenticate as the release App)",
          }),
        );
      }
      tagObject = createAndPushTag({
        version,
        targetSha,
        fingerprint,
        appToken,
        cwd,
        env,
      });
      log(`[release] tag v${version} created, verified, and pushed`);
    }
    await pollGithubSignatureVerification({
      owner,
      repo,
      tagObject,
      cwd,
      env,
    });
    log(`[release] GitHub reports the tag signature verified`);

    // --- Boundary 5: publish ---

    const tarballPath = env.PACKAGE_TARBALL ?? "";
    if (tarballPath === "") {
      throw new CliError(
        describeFailure({
          checked: "PACKAGE_TARBALL",
          found: "the environment variable is not set",
          correction: "wire it from the artifact-validation step's GITHUB_ENV write",
        }),
      );
    }
    await publishRelease({
      version,
      name: manifest.name,
      repositoryUrl: manifest.repositoryUrl,
      gitHead: targetSha,
      tarballPath,
      cwd,
      env,
    });
    log(`[release] ${manifest.name}@${version} published (or verified)`);

    // --- Boundary 6: GitHub Release ---

    const changelog = readFileSync(resolve(cwd, "CHANGELOG.md"), "utf8");
    const notes = releaseNotes(changelog, version);
    if (notes === null) {
      throw new CliError(
        describeFailure({
          checked: `the [${version}] changelog section for release notes`,
          found: "no such section in CHANGELOG.md",
          correction: "the release commit must carry the released changelog section",
        }),
      );
    }
    await ensureGithubRelease({ version, notes, cwd, env });
    log(`[release] GitHub Release v${version} ensured`);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      log(err.message);
      return err.exitCode === ExitCode.NOOP ? ExitCode.NOOP : 1;
    }
    log(
      describeFailure({
        checked: "the release mutation sequence",
        found: err instanceof Error ? err.message : String(err),
        correction: "inspect the repository and registry state, then re-run",
      }),
    );
    return 1;
  }
}
