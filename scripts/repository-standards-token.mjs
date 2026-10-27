import { createPrivateKey, createSign } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const OWNER = /^[A-Za-z0-9-]{1,100}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const NUMERIC_ID = /^[1-9]\d{0,19}$/;
const TOKEN = /^[A-Za-z0-9_.=-]{20,2000}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export function determineWriteMode({ eventName, inputDryRun = "", enabled = "" }) {
  requireThat(["workflow_dispatch", "schedule"].includes(eventName), "Unsupported workflow event");
  if (eventName === "workflow_dispatch") return inputDryRun === "false";
  return enabled === "true";
}

export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  requireThat(typeof appId === "string" && NUMERIC_ID.test(appId), "Invalid GitHub App ID");
  requireThat(typeof privateKey === "string" && privateKey.length >= 100 &&
    privateKey.length <= 64 * 1024 && !privateKey.includes("\0"), "Invalid GitHub App private key");
  const key = createPrivateKey(privateKey);
  requireThat(key.asymmetricKeyType === "rsa", "GitHub App key must be RSA");
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(key).toString("base64url")}`;
}

function validatePermissions(actual, expected) {
  requireThat(actual && typeof actual === "object" && !Array.isArray(actual),
    "Invalid installation token permissions");
  const allowed = new Set([...Object.keys(expected), "metadata"]);
  requireThat(Object.entries(actual).every(([name, value]) =>
    allowed.has(name) && (name === "metadata" ? value === "read" : value === expected[name])),
  "Installation token returned unexpected permissions");
  for (const [name, value] of Object.entries(expected)) {
    requireThat(actual[name] === value, "Installation token is missing an exact permission");
  }
}

export async function issueRepositoryToken({
  api,
  owner,
  repository,
  appId,
  installationId,
  writeMode,
  now = Date.now(),
}) {
  requireThat(OWNER.test(owner) && REPOSITORY.test(repository), "Invalid repository identity");
  requireThat(typeof appId === "string" && NUMERIC_ID.test(appId) &&
    typeof installationId === "string" && NUMERIC_ID.test(installationId),
  "Invalid GitHub App or installation ID");
  requireThat(typeof writeMode === "boolean", "Invalid write mode");
  const app = await api.getApp();
  requireThat(Number.isSafeInteger(app?.id) && String(app.id) === appId &&
    typeof app.slug === "string" && SLUG.test(app.slug), "GitHub App identity mismatch");
  const level = writeMode ? "write" : "read";
  const permissions = { contents: level, pull_requests: level };
  const response = await api.createInstallationToken(installationId, {
    repositories: [repository],
    permissions,
  });
  requireThat(response && typeof response === "object" && TOKEN.test(response.token),
    "Invalid installation token response");
  const expiresAt = Date.parse(response.expires_at);
  requireThat(Number.isFinite(expiresAt) && expiresAt > now + 60_000 &&
    expiresAt <= now + 65 * 60_000, "Installation token expiry is invalid");
  requireThat(response.repository_selection === "selected" &&
    Array.isArray(response.repositories) && response.repositories.length === 1 &&
    response.repositories[0]?.full_name === `${owner}/${repository}`,
  "Installation token repository scope mismatch");
  validatePermissions(response.permissions, permissions);
  return { token: response.token, appBot: `${app.slug}[bot]`, dryRun: !writeMode };
}

export class GitHubAppApi {
  constructor(jwt) {
    requireThat(typeof jwt === "string" && jwt.split(".").length === 3, "GitHub App JWT is required");
    this.jwt = jwt;
  }
  async request(method, endpoint, payload) {
    requireThat(endpoint.startsWith("/") && !endpoint.startsWith("//"), "Invalid GitHub App endpoint");
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`GitHub App ${method} failed (${response.status})`);
    }
    return boundedJson(response);
  }
  getApp() { return this.request("GET", "/app"); }
  createInstallationToken(installationId, payload) {
    return this.request("POST", `/app/installations/${installationId}/access_tokens`, payload);
  }
}

async function boundedJson(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    requireThat(size <= MAX_RESPONSE_BYTES, "GitHub App response exceeds byte bound");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("GitHub App returned invalid JSON");
  }
}

export async function runTokenIssuer({
  env,
  now = Date.now(),
  apiFactory = (jwt) => new GitHubAppApi(jwt),
  mask = (value) => process.stdout.write(`::add-mask::${value}\n`),
  appendOutput = (value) => appendFile(env.GITHUB_OUTPUT, value),
}) {
  const writeMode = determineWriteMode({
    eventName: env.EVENT_NAME,
    inputDryRun: env.INPUT_DRY_RUN ?? "",
    enabled: env.REPOSITORY_STANDARDS_ENABLED ?? "",
  });
  const jwt = createAppJwt({ appId: env.GH_APP_ID, privateKey: env.GH_APP_PEM, now });
  const result = await issueRepositoryToken({
    api: apiFactory(jwt),
    owner: env.OWNER,
    repository: env.REPOSITORY,
    appId: env.GH_APP_ID,
    installationId: env.GH_APP_INSTALLATION_ID,
    writeMode,
    now,
  });
  mask(result.token);
  await appendOutput(`token=${result.token}\napp-bot=${result.appBot}\ndry-run=${result.dryRun}\n`);
  return result;
}

async function main() {
  await runTokenIssuer({ env: process.env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Repository standards token issuance failed: ${error.message}`);
    process.exitCode = 1;
  });
}
