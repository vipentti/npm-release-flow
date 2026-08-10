import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createAppJwt, mintAppToken } from "../src/lib/app-token.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

test("createAppJwt produces a structurally valid RS256 JWT", () => {
  const jwt = createAppJwt({
    appId: "12345",
    privateKey,
    now: 1_700_000_000,
  });
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(
    Buffer.from(parts[0], "base64url").toString("utf8"),
  );
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  );
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, 1_700_000_000);
  assert.equal(payload.exp, 1_700_000_600);
  // The signature verifies against the public key.
  const verified = createVerify("RSA-SHA256")
    .update(`${parts[0]}.${parts[1]}`)
    .verify(publicKey, Buffer.from(parts[2], "base64url"));
  assert.equal(verified, true);
});

test("createAppJwt rejects a malformed private key", () => {
  assert.throws(
    () => createAppJwt({ appId: "1", privateKey: "not-a-key" }),
    /could not sign the App JWT with the private key/,
  );
});

/**
 * Stub globalThis.fetch for the token exchange.
 *
 * @param {{ installation?: boolean, token?: boolean }} [fail]
 * @returns {() => void} Restore function.
 */
function stubFetch({ installation = true, token = true } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/installation")) {
      if (!installation)
        return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: 9876 }) };
    }
    if (u.endsWith("/access_tokens")) {
      if (!token) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: "fixture-app-token" }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return () => {
    globalThis.fetch = original;
  };
}

test("mintAppToken resolves the installation and returns the token", async () => {
  const restore = stubFetch();
  try {
    const token = await mintAppToken({
      appId: "12345",
      privateKey,
      owner: "example",
      repo: "fixture-consumer",
    });
    assert.equal(token, "fixture-app-token");
  } finally {
    restore();
  }
});

test("mintAppToken refuses when the installation cannot be resolved", async () => {
  const restore = stubFetch({ installation: false });
  try {
    await assert.rejects(
      mintAppToken({
        appId: "12345",
        privateKey,
        owner: "example",
        repo: "fixture-consumer",
      }),
      /API returned 404; is the App installed on the repository\?/,
    );
  } finally {
    restore();
  }
});

test("mintAppToken refuses when the token exchange fails", async () => {
  const restore = stubFetch({ token: false });
  try {
    await assert.rejects(
      mintAppToken({
        appId: "12345",
        privateKey,
        owner: "example",
        repo: "fixture-consumer",
      }),
      /API returned 500/,
    );
  } finally {
    restore();
  }
});

test("mintAppToken refuses a malformed private key", async () => {
  const restore = stubFetch();
  try {
    await assert.rejects(
      mintAppToken({
        appId: "12345",
        privateKey: "garbage",
        owner: "example",
        repo: "fixture-consumer",
      }),
      /could not sign the App JWT/,
    );
  } finally {
    restore();
  }
});

test("mintAppToken refuses a network failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  try {
    await assert.rejects(
      mintAppToken({
        appId: "12345",
        privateKey,
        owner: "example",
        repo: "fixture-consumer",
      }),
      /could not resolve the App installation/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
