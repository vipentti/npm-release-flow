/**
 * GitHub App installation-token minting (T11): the same JWT + API exchange
 * the pinned `actions/create-github-app-token` action performs. Used by the
 * local `tag` command to authenticate the tag push as the release GitHub App
 * (the only actor allowed to create `refs/tags/v*` under the ruleset).
 */

import { createSign } from "node:crypto";

/**
 * Create a signed RS256 JWT for a GitHub App (10-minute lifetime, GitHub's
 * limit for app JWTs).
 *
 * @param {{ appId: string, privateKey: string, now?: number }} options
 * @returns {string}
 */
export function createAppJwt({ appId, privateKey, now }) {
  const nowSeconds = now ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds,
    exp: nowSeconds + 600,
    iss: String(appId),
  };
  /**
   * @param {Record<string, unknown>} value
   * @returns {string}
   */
  const base64Url = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${base64Url(header)}.${base64Url(payload)}`;
  let signature;
  try {
    signature = createSign("RSA-SHA256")
      .update(signingInput)
      .sign(privateKey)
      .toString("base64url");
  } catch (err) {
    throw new Error(
      `could not sign the App JWT with the private key: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return `${signingInput}.${signature}`;
}

/**
 * App-authenticated request headers (a signed App JWT; user access tokens
 * cannot authenticate the App-only installation endpoint).
 *
 * @param {string} appId
 * @param {string} privateKey
 * @returns {Record<string, string>}
 */
function appHeaders(appId, privateKey) {
  return {
    Authorization: `Bearer ${createAppJwt({ appId, privateKey })}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * @typedef {object} InstallLookupOptions
 * @property {string} appId The GitHub App ID.
 * @property {string} privateKey The App's PEM private key.
 * @property {string} owner Repository owner.
 * @property {string} repo Repository name.
 * @property {typeof fetch} [fetchImpl] Fetch implementation (stubbed in
 *   tests); defaults to the global fetch.
 * @property {string} [apiUrl] API base URL (defaults to api.github.com).
 */

/**
 * Resolve the App installation for a repository with App-JWT
 * authentication. `GET /repos/{owner}/{repo}/installation` is documented
 * as App-JWT-only: user access tokens, installation access tokens, and
 * fine-grained PATs cannot read it. Shared by `mintAppToken` (the token
 * exchange) and the `check` command's installation readiness probe. The
 * full installation record is returned (including the granted repository
 * permissions) so callers can verify readiness, not just existence.
 *
 * @typedef {object} InstallationRecord
 * @property {number} id The installation ID.
 * @property {Record<string, string>} [permissions] Granted repository
 *   permissions (e.g. `contents: "write"`).
 *
 * @param {InstallLookupOptions} options
 * @returns {Promise<InstallationRecord>} The installation record.
 */
export async function resolveInstallation({
  appId,
  privateKey,
  owner,
  repo,
  fetchImpl,
  apiUrl = "https://api.github.com",
}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const headers = appHeaders(appId, privateKey);
  let installResponse;
  try {
    installResponse = await doFetch(
      `${apiUrl}/repos/${owner}/${repo}/installation`,
      { headers },
    );
  } catch (err) {
    throw new Error(
      `could not resolve the App installation for ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!installResponse.ok) {
    throw new Error(
      `could not resolve the App installation for ${owner}/${repo}: API returned ${installResponse.status}; is the App installed on the repository?`,
    );
  }
  return /** @type {InstallationRecord} */ (await installResponse.json());
}

/**
 * @typedef {object} MintOptions
 * @property {string} appId The GitHub App ID (from the repository variable).
 * @property {string} privateKey The App's PEM private key.
 * @property {string} owner Repository owner.
 * @property {string} repo Repository name.
 * @property {typeof fetch} [fetchImpl] Fetch implementation (stubbed in
 *   tests); defaults to the global fetch.
 * @property {string} [apiUrl] API base URL (defaults to api.github.com).
 */

/**
 * Mint an installation access token for the App on the given repository.
 *
 * @param {MintOptions} options
 * @returns {Promise<string>} The installation access token.
 */
export async function mintAppToken({
  appId,
  privateKey,
  owner,
  repo,
  fetchImpl,
  apiUrl = "https://api.github.com",
}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const installation = await resolveInstallation({
    appId,
    privateKey,
    owner,
    repo,
    fetchImpl,
    apiUrl,
  });
  const headers = appHeaders(appId, privateKey);

  let tokenResponse;
  try {
    tokenResponse = await doFetch(
      `${apiUrl}/app/installations/${installation.id}/access_tokens`,
      { method: "POST", headers },
    );
  } catch (err) {
    throw new Error(
      `could not mint the installation token: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!tokenResponse.ok) {
    throw new Error(
      `could not mint the installation token: API returned ${tokenResponse.status}`,
    );
  }
  const data = /** @type {{ token?: string }} */ (await tokenResponse.json());
  if (typeof data.token !== "string" || data.token === "") {
    throw new Error("the installation token response did not contain a token");
  }
  return data.token;
}
