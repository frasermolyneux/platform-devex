import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const directory = process.env.PUBLICATION_ORIGIN_DIRECTORY;

test("immutable shared helper admits genuine humans and holds automation, unknowns and unproved lineage", {
  skip: directory ? false : "Set PUBLICATION_ORIGIN_DIRECTORY to the verified fetch-helper output",
}, async () => {
  const hashes = {
    "origin.mjs": "5227ca43c3b26b42101dff2e5f5617f020074f64012cbfa8c90af95bce43f21d",
    "action.yml": "bb0e16af3027c1f9cf3681852dffa6b377f09d7a010e94fd6253a275588e32a6",
  };
  for (const [filename, hash] of Object.entries(hashes)) {
    assert.equal(createHash("sha256").update(await readFile(path.join(directory, filename))).digest("hex"), hash);
  }
  const { decideOrigin, prepare } = await import(pathToFileURL(path.resolve(directory, "origin.mjs")).href);
  const repository = { id: 100, full_name: "owner/target", private: true, visibility: "private",
    default_branch: "main", archived: false, fork: false };
  const human = { id: 1, login: "owner", type: "User" };
  const app = { id: 2, login: "app[bot]", type: "Bot" };
  const actions = { id: 3, login: "github-actions[bot]", type: "Bot" };
  const dependabot = { id: 4, login: "dependabot[bot]", type: "Bot" };
  const policy = { appId: 50, allowAppAuthoredMerges: false, trustedProducers: [] };
  const run = { id: 10, run_attempt: 1, repository: { id: 100 }, head_repository: { id: 100 },
    head_sha: "a".repeat(40), head_branch: "main", actor: human, event: "push",
    path: ".github/workflows/deploy.yml", status: "in_progress", conclusion: null };
  const pr = { merged: true, merge_commit_sha: run.head_sha, base: { repo: { id: 100 } },
    head: { repo: { id: 100 } }, user: dependabot, merged_by: app };
  const input = { repository, run, policy, pullRequests: [],
    identities: { app: { id: 50, actorId: app.id }, actions, dependabot }, permission: "write" };
  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    assert.equal(decideOrigin({ ...input, run: { ...run, event } }).allowed, true);
  }
  // The original human push actor is sufficient; PR merger identity is not a second human gate.
  assert.equal(decideOrigin({ ...input, pullRequests: [pr] }).allowed, true);
  for (const actor of [app, actions, { ...app, id: 999 }]) {
    assert.equal(decideOrigin({ ...input, run: { ...run, actor, triggering_actor: human },
      pullRequests: [{ ...pr, merged_by: actor }] }).allowed, false);
  }
  for (const event of ["pull_request", "workflow_run", "workflow_dispatch", "schedule"]) {
    assert.equal(decideOrigin({ ...input, run: { ...run, actor: app, event } }).allowed, false);
  }
  assert.equal(decideOrigin({ ...input, permission: "read" }).allowed, false);
  assert.equal(decideOrigin({ ...input, run: { ...run, head_repository: { id: 999 } } }).allowed, false);
  const source = { ...run, id: 11, event: "workflow_run", path: ".github/workflows/relay.yml",
    status: "completed", conclusion: "success" };
  const api = { async get(endpoint) {
    if (endpoint === "/repos/owner/target") return repository;
    if (endpoint.endsWith("/10")) return { ...run, event: "workflow_run" };
    if (endpoint.endsWith("/11")) return source;
    throw new Error("Unexpected fixture metadata request");
  } };
  const result = await prepare({ api, repositoryName: repository.full_name, repositoryId: 100,
    runId: 10, runAttempt: 1, eventName: "workflow_run", expectedSha: run.head_sha,
    workflowSha: run.head_sha, event: { workflow_run: source }, policy, engineDigest: "b".repeat(64) });
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.origin, "untrusted-producer");
  const unreviewedRoot = { ...source, event: "push", path: ".github/workflows/unreviewed-root.yml" };
  const directApi = {
    async get(endpoint) {
      if (endpoint === "/repos/owner/target") return repository;
      if (endpoint.endsWith("/10")) return { ...run, event: "workflow_run" };
      if (endpoint.endsWith("/11")) return unreviewedRoot;
      if (endpoint.includes("/collaborators/")) return { user: human, permission: "write" };
      throw new Error("Unexpected fixture metadata request");
    },
    async pages() { return []; },
  };
  const direct = await prepare({ api: directApi, repositoryName: repository.full_name, repositoryId: 100,
    runId: 10, runAttempt: 1, eventName: "workflow_run", expectedSha: run.head_sha,
    workflowSha: run.head_sha, event: { workflow_run: unreviewedRoot }, policy, engineDigest: "b".repeat(64) });
  // This observed released-helper gap is why the installer refuses every workflow_run edge.
  assert.equal(direct.decision.allowed, true);
  assert.equal(policy.trustedProducers.length, 0);
});
