import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectWorkflowRuns, latestPullRequestRuns } from "../.github/actions/approve-copilot-workflow-runs/workflow-runs.mjs";

function workflowRun(id, overrides = {}) {
  return {
    id, workflow_id: 100, head_sha: "head", event: "pull_request",
    created_at: `2026-10-02T10:${String(id).padStart(2, "0")}:00Z`,
    status: "completed", conclusion: "action_required", run_attempt: 1,
    pull_requests: [{ number: 8 }], ...overrides,
  };
}

test("newer ready-for-review events supersede older draft events on the same head", () => {
  const draft = workflowRun(1, { run_attempt: 7, updated_at: "2026-10-02T12:00:00Z" });
  const ready = workflowRun(2, { conclusion: "cancelled" });
  assert.deepEqual(latestPullRequestRuns([draft, ready], 8, "head"), [ready]);
  assert.deepEqual(latestPullRequestRuns([ready, draft], 8, "head"), [ready]);
});

test("newer queued, running, completed and cancelled runs all supersede old pending approval", () => {
  for (const [status, conclusion] of [
    ["queued", null], ["in_progress", null], ["completed", "success"],
    ["completed", "cancelled"], ["completed", "skipped"], ["completed", "failure"],
  ]) {
    const newer = workflowRun(2, { status, conclusion });
    assert.deepEqual(latestPullRequestRuns([workflowRun(1), newer], 8, "head"), [newer]);
  }
});

test("selection is per workflow, excludes other heads and PRs, and ignores non-PR events", () => {
  const build = workflowRun(2);
  const quality = workflowRun(3, { workflow_id: 200 });
  const unrelated = [
    workflowRun(4, { head_sha: "old-head" }),
    workflowRun(5, { pull_requests: [{ number: 9 }] }),
    workflowRun(6, { event: "push" }),
    workflowRun(7, { event: "pull_request_target" }),
  ];
  assert.deepEqual(latestPullRequestRuns([workflowRun(1), build, quality, ...unrelated], 8, "head"),
    [build, quality]);
});

test("original event timestamp and ID break ties, never rerun-attempt timestamps", () => {
  const older = workflowRun(1, { run_started_at: "2026-10-02T12:00:00Z" });
  const newer = workflowRun(2, { created_at: older.created_at });
  assert.deepEqual(latestPullRequestRuns([newer, older], 8, "head"), [newer]);
});

test("complete run paging is required, including matching counts and no duplicated IDs", () => {
  const a = workflowRun(1);
  const b = workflowRun(2);
  assert.deepEqual(collectWorkflowRuns([
    { total_count: 2, workflow_runs: [a] }, { total_count: 2, workflow_runs: [b] },
  ]), [a, b]);
  assert.deepEqual(collectWorkflowRuns([{ total_count: 0, workflow_runs: [] }]), []);
  assert.throws(() => collectWorkflowRuns([{ total_count: 2, workflow_runs: [a] }]), /Incomplete/);
  assert.throws(() => collectWorkflowRuns([
    { total_count: 2, workflow_runs: [a] }, { total_count: 3, workflow_runs: [b] },
  ]), /changing/);
  assert.throws(() => collectWorkflowRuns([{ total_count: 2, workflow_runs: [a, a] }]), /duplicate/);
  assert.throws(() => collectWorkflowRuns([null]), /Invalid/);
  assert.throws(() => latestPullRequestRuns([workflowRun(1, { workflow_id: null })], 8, "head"), /metadata/);
  assert.throws(() => latestPullRequestRuns([workflowRun(1, { created_at: "bad" })], 8, "head"), /metadata/);
});

test("the approval composite's selector CLI emits only latest IDs and rejects truncated history", () => {
  const script = fileURLToPath(new URL("../.github/actions/approve-copilot-workflow-runs/workflow-runs.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "8", "head"], {
    input: JSON.stringify([{ total_count: 2, workflow_runs: [workflowRun(1), workflowRun(2)] }]),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "2");
  const incomplete = spawnSync(process.execPath, [script, "8", "head"], {
    input: JSON.stringify([{ total_count: 2, workflow_runs: [workflowRun(1)] }]), encoding: "utf8",
  });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /Incomplete/);
});
