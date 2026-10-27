import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  createAppJwt,
  determineWriteMode,
  issueRepositoryToken,
  runTokenIssuer,
} from "./repository-standards-token.mjs";

const now = Date.parse("2026-10-27T21:00:00Z");
const appId = "123456";
const installationId = "654321";
const owner = "owner";
const repository = "target";
const token = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function response(writeMode = false, overrides = {}) {
  const level = writeMode ? "write" : "read";
  return {
    token,
    expires_at: new Date(now + 60 * 60_000).toISOString(),
    repository_selection: "selected",
    repositories: [{ full_name: `${owner}/${repository}` }],
    permissions: {
      contents: level,
      pull_requests: level,
      metadata: "read",
    },
    ...overrides,
  };
}

function api(writeMode = false, overrides = {}) {
  const calls = [];
  return {
    calls,
    async getApp() {
      calls.push({ method: "GET", endpoint: "/app" });
      if (overrides.getAppError) throw new Error("GitHub App GET failed (503)");
      return overrides.app ?? { id: Number(appId), slug: "repository-standards" };
    },
    async createInstallationToken(id, payload) {
      calls.push({ method: "POST", id, payload });
      if (overrides.tokenError) throw new Error("GitHub App POST failed (403)");
      return overrides.response ?? response(writeMode);
    },
  };
}

test("write mode is exact and case-sensitive for manual and scheduled runs", () => {
  assert.equal(determineWriteMode({ eventName: "workflow_dispatch", inputDryRun: "false" }), true);
  for (const value of ["true", "False", " false", "false ", "", "0"]) {
    assert.equal(determineWriteMode({ eventName: "workflow_dispatch", inputDryRun: value }), false);
  }
  assert.equal(determineWriteMode({ eventName: "schedule", enabled: "true" }), true);
  for (const value of ["TRUE", "True", " true", "true ", "\ttrue", "", "1"]) {
    assert.equal(determineWriteMode({ eventName: "schedule", enabled: value }), false);
  }
  assert.throws(() => determineWriteMode({ eventName: "push", enabled: "true" }), /Unsupported/);
});

test("creates a bounded RS256 GitHub App JWT without exposing key material", () => {
  const jwt = createAppJwt({ appId, privateKey, now });
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(headerPart, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payloadPart, "base64url")), {
    iat: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 540,
    iss: appId,
  });
  assert.equal(verify("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), publicKey,
    Buffer.from(signaturePart, "base64url")), true);
  assert.doesNotMatch(jwt, /BEGIN|PRIVATE/);
  assert.throws(() => createAppJwt({ appId: "not-an-id", privateKey, now }), /App ID/);
  assert.throws(() => createAppJwt({ appId, privateKey: "not a key", now }), /private key/);
});

test("requests an exact read-only repository token for dry runs", async () => {
  const fake = api(false);
  const result = await issueRepositoryToken({
    api: fake, owner, repository, appId, installationId, writeMode: false, now,
  });
  assert.deepEqual(result, { token, appBot: "repository-standards[bot]", dryRun: true });
  assert.deepEqual(fake.calls, [
    { method: "GET", endpoint: "/app" },
    {
      method: "POST",
      id: installationId,
      payload: {
        repositories: [repository],
        permissions: { contents: "read", pull_requests: "read" },
      },
    },
  ]);
});

test("requests exact write permissions only in trusted write mode", async () => {
  const fake = api(true);
  const result = await issueRepositoryToken({
    api: fake, owner, repository, appId, installationId, writeMode: true, now,
  });
  assert.equal(result.dryRun, false);
  assert.deepEqual(fake.calls[1].payload, {
    repositories: [repository],
    permissions: { contents: "write", pull_requests: "write" },
  });
});

test("validates App identity, repository scope, permissions, expiry and API failures", async () => {
  const inputs = { owner, repository, appId, installationId, writeMode: false, now };
  await assert.rejects(issueRepositoryToken({
    api: api(false, { app: { id: 999, slug: "repository-standards" } }), ...inputs,
  }), /identity mismatch/);
  await assert.rejects(issueRepositoryToken({
    api: api(false, { response: response(false, { repositories: [{ full_name: "owner/other" }] }) }), ...inputs,
  }), /scope mismatch/);
  await assert.rejects(issueRepositoryToken({
    api: api(false, { response: response(false, {
      permissions: { contents: "write", pull_requests: "read" },
    }) }), ...inputs,
  }), /unexpected permissions/);
  await assert.rejects(issueRepositoryToken({
    api: api(false, { response: response(false, {
      permissions: { contents: "read", pull_requests: "read", variables: "read" },
    }) }), ...inputs,
  }), /unexpected permissions/);
  await assert.rejects(issueRepositoryToken({
    api: api(false, { response: response(false, {
      expires_at: new Date(now + 70 * 60_000).toISOString(),
    }) }), ...inputs,
  }), /expiry/);
  await assert.rejects(issueRepositoryToken({
    api: api(false, { getAppError: true }), ...inputs,
  }), /GET failed/);
  await assert.rejects(issueRepositoryToken({
    api: api(false, { tokenError: true }), ...inputs,
  }), /POST failed/);
});

test("masks the token before writing outputs and emits only bounded workflow values", async () => {
  const events = [];
  let capturedJwt;
  const env = {
    EVENT_NAME: "schedule",
    INPUT_DRY_RUN: "",
    REPOSITORY_STANDARDS_ENABLED: "TRUE",
    OWNER: owner,
    REPOSITORY: repository,
    GH_APP_ID: appId,
    GH_APP_INSTALLATION_ID: installationId,
    GH_APP_PEM: privateKey,
    GITHUB_OUTPUT: "unused",
  };
  const result = await runTokenIssuer({
    env,
    now,
    apiFactory(jwt) {
      capturedJwt = jwt;
      return api(false);
    },
    mask(value) { events.push({ type: "mask", value }); },
    async appendOutput(value) { events.push({ type: "output", value }); },
  });
  assert.equal(result.dryRun, true);
  assert.equal(events[0].type, "mask");
  assert.equal(events[0].value, token);
  assert.equal(events[1].type, "output");
  assert.equal(events[1].value,
    `token=${token}\napp-bot=repository-standards[bot]\ndry-run=true\n`);
  assert.doesNotMatch(events[1].value, new RegExp(capturedJwt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(events[1].value, /PRIVATE KEY/);
});
