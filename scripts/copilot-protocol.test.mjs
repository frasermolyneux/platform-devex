import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { parseObjectResponse, ResponseError, runReadOnlyAnalysis } from "./copilot-analysis.mjs";
import {
  EVIDENCE_TAG, agentEvidenceCandidate, evidenceReport, marker, normalizeAgentEvidence,
  publishEvidenceBody, structuredAgentEvidence, validateNormalizedEvidence, verifyReviewThreads,
} from "./review-lifecycle.mjs";
import { reviewRisk, validRiskDecision } from "../.github/actions/approve-copilot-workflow-runs/risk-review.mjs";
import {
  previousRiskBlock, refreshCompletedAudits, updatedAuditBody, upsertAudit,
} from "../.github/actions/approve-copilot-workflow-runs/approval-audit.mjs";

const approved = { verdict: "approve", touches_ci: false, reason: "Ordinary bounded source/test fix" };
const report = {
  sha: "abcd", testPaths: ["src/a.test.js"],
  commands: [{ command: "node --test src/a.test.js", outcome: "passed", details: "1 test passed" }],
  layers: { unit: "Focused assertions", integration: "No external boundary", playwright: "Backend-only" },
  threads: [],
};
const comment = { id: 1, user: { login: "Copilot" }, html_url: "https://github.com/owner/repo/pull/8#issuecomment-1",
  body: marker(EVIDENCE_TAG, report) };

test("approval's deterministic denylist blocks analyzer/build suppression configuration before SDK approval", async () => {
  const action = await readFile(new URL("../.github/actions/approve-copilot-workflow-runs/action.yml", import.meta.url), "utf8");
  const pattern = action.match(/DENY_REGEX='([^']+)'/)?.[1];
  assert.ok(pattern, "approval must define its deterministic denylist");
  const denied = new RegExp(pattern);
  for (const path of [".editorconfig", "src/.editorconfig", "src/analyzers.ruleset",
    "sonar-project.properties", "scripts/sonar-policy.mjs", "Directory.Build.props", "src/Directory.Build.targets",
    ".github/workflows/verify.yml", ".github/actions/test/action.yml", "Dockerfile"]) {
    assert.equal(denied.test(path), true, path);
  }
  for (const path of ["src/Tests/Fixture.cs", "src/Production.cs", "README.md"]) {
    assert.equal(denied.test(path), false, path);
  }
});

test("known factual report shapes inside an evidence marker adapt without inventing execution or treating historical CI status as a command", () => {
  const payload = {
    sha: "abcd", commit_sha: "abcd", testPaths: ["src/a.test.js"],
    tests: [{ path: "src", command: 'node --test --test-name-pattern="specific regression" src/a.test.js',
      result: "passed: 1 test, 0 failed" }],
    coverage: report.layers, ci: { status: "action_required", jobs: 0 },
    threads: [{ id: 123, status: "addressed", evidence: "Owner comment, not a review-thread ID" }],
  };
  const source = { ...comment, body: `> Earlier request for old commit\n\n${marker(EVIDENCE_TAG, payload)}` };
  assert.equal(agentEvidenceCandidate([source], "abcd"), source);
  const adapted = evidenceReport([source], "abcd", "owner");
  assert.deepEqual(adapted.report.testPaths, ["src/a.test.js"]);
  assert.deepEqual(adapted.report.commands, [{
    command: payload.tests[0].command, outcome: "passed", details: payload.tests[0].result,
  }]);
  assert.deepEqual(adapted.report.threads, []);
  assert.equal(adapted.comment, source);
  for (const contradictory of [
    { ...payload, commit_sha: "old" },
    { ...payload, commands: [{ command: "node --test", outcome: "failed", details: "1 failed" }] },
  ]) {
    const invalid = { ...source, body: marker(EVIDENCE_TAG, contradictory) };
    assert.throws(() => evidenceReport([invalid], "abcd", "owner"), /(?:Invalid|Conflicting) current-head test evidence/);
  }
});

test("authored reports may contain one JSON fence and explicit multi-file/format-scope descriptors, without relaxing SDK business JSON", () => {
  const payload = {
    commit_sha: "abcd", coverage: report.layers,
    tests: [
      { path: "src/a.test.js; src/a.js", command: "node --test src/a.test.js", result: "PASS: 1 passed, 0 failed" },
      { path: "src/project.slnx (limited to a.test.js)", command: "dotnet format src/project.slnx", result: "PASS" },
    ],
  };
  const source = { ...comment, body: `> old request\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`` };
  assert.equal(agentEvidenceCandidate([source], "abcd"), source);
  const adapted = structuredAgentEvidence(source, "abcd", ["src/a.test.js", "src/a.js"]);
  assert.deepEqual(adapted.report.testPaths, ["src/a.test.js", "src/a.js", "src/project.slnx"]);
  assert.deepEqual(adapted.report.commands.map((command) => command.command), payload.tests.map((test) => test.command));
  assert.throws(() => parseObjectResponse(source.body), ResponseError);
  const malformed = { ...source, body: `${source.body}\n\`\`\`json\n{"commit_sha":"abcd"}\n\`\`\`` };
  assert.equal(agentEvidenceCandidate([malformed], "abcd"), null);
});

test("explicitly uncommitted experiments cannot replace genuine current-head execution evidence", async () => {
  const actual = { ...comment, id: 10 };
  for (const dirty of [{ patch_committed: false }, { worktree_dirty: true }]) {
    const experiment = { ...comment, id: 11, body: marker(EVIDENCE_TAG, {
      ...report, ...dirty, commands: [{ command: "node --test", outcome: "failed", details: "Uncommitted experiment failed" }],
    }) };
    assert.equal(evidenceReport([actual, experiment], "abcd", "owner").comment, actual);
    assert.equal(agentEvidenceCandidate([experiment], "abcd"), null);
    const legacy = { ...experiment, body: JSON.stringify({
      commit_sha: "abcd", ...dirty, coverage: report.layers,
      tests: [{ path: "src/a.test.js", command: "node --test", result: "failed: 1 failed" }],
    }) };
    assert.equal(structuredAgentEvidence(legacy, "abcd", ["src/a.test.js"]), null);
    assert.throws(() => validateNormalizedEvidence(report, legacy, "abcd"), /Uncommitted experiment/);
    await assert.rejects(() => normalizeAgentEvidence(legacy, "abcd", ["src/a.test.js"],
      async () => assert.fail("Do not call the model for explicitly uncommitted experiments")), /Uncommitted experiment/);
  }
  const genuinelyFailed = { ...comment, body: marker(EVIDENCE_TAG, {
    ...report, commands: [{ command: "node --test", outcome: "failed", details: "Committed tree failed" }],
  }) };
  assert.equal(evidenceReport([genuinelyFailed], "abcd", "owner").report.commands[0].outcome, "failed");
});

test("business JSON framing rejects prose, fences, multiple values, wrong types and duplicate/escaped keys", () => {
  for (const text of ["", "  ", "SECRET_PRIVATE prose", "```json\n{}\n```", "{}\n{}", "[]", "null",
    JSON.stringify({ ...approved, touches_ci: "false" }), JSON.stringify({ ...approved, extra: true }),
    JSON.stringify({ ...approved, reason: "" }), JSON.stringify({ ...approved, reason: "line\nbreak" }),
    '{"verdict":"block","verdict":"approve","touches_ci":false,"reason":"ok"}',
    String.raw`{"verdict":"block","ver\u0064ict":"approve","touches_ci":false,"reason":"ok"}`]) {
    assert.throws(() => parseObjectResponse(text, validRiskDecision), (error) =>
      error instanceof ResponseError && !error.message.includes("SECRET_PRIVATE"));
  }
  assert.deepEqual(parseObjectResponse(` \n${JSON.stringify(approved)}\n`, validRiskDecision), approved);
  assert.deepEqual(parseObjectResponse('{"x":["{","a:b"],"y":{"v":1}}'), { x: ["{", "a:b"], y: { v: 1 } });
  assert.throws(() => parseObjectResponse('{"x":{"v":1,"v":2}}'), /duplicate_key/);
});

test("risk protocol retries malformed output once, but valid block or touches_ci never rerolls", async () => {
  let calls = 0;
  const recovered = await reviewRisk("review", async (prompt) => {
    calls++;
    if (calls === 1) return "```json\n{}\n```";
    assert.match(prompt, /previous response failed/);
    return JSON.stringify(approved);
  });
  assert.equal(recovered.verdict, "approve");
  assert.equal(calls, 2);
  for (const decision of [{ ...approved, verdict: "block" }, { ...approved, touches_ci: true }]) {
    calls = 0;
    const blocked = await reviewRisk("review", async () => { calls++; return JSON.stringify(decision); });
    assert.equal(calls, 1);
    assert.equal(blocked.diagnostics.category, "valid");
  }
});

test("exhausted/changed-state/SDK failures stay closed with safe diagnostics and no raw payload", async () => {
  const failed = await reviewRisk("review", async () => "SECRET_PRIVATE malformed");
  assert.equal(failed.verdict, "block");
  assert.equal(failed.diagnostics.attempts, 2);
  assert.equal(failed.diagnostics.category, "invalid_json");
  assert.equal(JSON.stringify(failed).includes("SECRET_PRIVATE"), false);
  let calls = 0;
  const changed = await reviewRisk("review", async () => { calls++; return "{}"; }, {}, async () => false);
  assert.equal(calls, 1);
  assert.equal(changed.diagnostics.category, "state_changed");
  const sdk = await reviewRisk("review", async () => { throw new Error("SECRET_PRIVATE token/diff"); });
  assert.equal(sdk.diagnostics.category, "sdk_failure");
  assert.equal(sdk.diagnostics.attempts, 1);
  assert.equal(JSON.stringify(sdk).includes("SECRET_PRIVATE"), false);
});

test("restricted SDK isolation strips credentials and cleans its temporary directory even when stop fails", async () => {
  let directory;
  await assert.rejects(runReadOnlyAnalysis("data", { token: "test-human", createClient: async (options) => {
    directory = options.baseDirectory;
    assert.equal(options.mode, "empty");
    assert.equal(options.useLoggedInUser, false);
    assert.equal(options.env.COPILOT_AGENT_PAT, undefined);
    return {
      createSession: async (config) => {
        assert.deepEqual(config.availableTools, []);
        assert.equal(config.gitHubToken, "test-human");
        assert.equal(config.skipCustomInstructions, true);
        assert.equal(config.onPermissionRequest().kind, "reject");
        return { sendAndWait: async () => ({ data: { content: "{}" } }) };
      },
      stop: async () => { throw new Error("stop failed"); },
    };
  } }), /Copilot SDK analysis failed/);
  await assert.rejects(access(directory), { code: "ENOENT" });
  await assert.rejects(runReadOnlyAnalysis("data", { token: "test-human",
    createClient: async () => { throw new Error("SECRET_PRIVATE transport details"); } }), (error) =>
      error.message.includes("credentials withheld") && !error.message.includes("SECRET_PRIVATE"));
});

test("evidence is current-head and trusted-author only, preserves description content and validates real outcome types", () => {
  assert.equal(evidenceReport([{ ...comment, user: { login: "third-party" } }], "abcd", "owner"), null);
  assert.equal(evidenceReport([comment], "new", "owner"), null);
  const evidence = evidenceReport([comment], "abcd", "owner");
  const body = publishEvidenceBody("Human summary\nRefs #7", evidence);
  assert.match(body, /^Human summary\nRefs #7/);
  assert.match(body, /reported test results, not independent execution/);
  assert.equal(publishEvidenceBody(body, evidence), body);
  for (const broken of [{ ...report, testPaths: ["../secret"] }, { ...report, commands: [null] },
    { ...report, threads: [null] }, { ...report, layers: {} }]) {
    assert.throws(() => evidenceReport([{ ...comment, body: marker(EVIDENCE_TAG, broken) }], "abcd", "owner"),
      /Invalid current-head test evidence/);
  }
  assert.throws(() => publishEvidenceBody(`${body}\n${body}`, evidence), /Multiple controller/);
});

test("agent completion reports are normalized without accepting quoted requests, invented commands or rewritten results", async () => {
  const source = { ...comment, body: `> requested abcd\n\n${JSON.stringify({
    commit_sha: "abcd", tests: [{ path: "/home/repo/src/a.test.js", command: report.commands[0].command,
      result: report.commands[0].details }],
  })}` };
  assert.equal(agentEvidenceCandidate([{ ...source, body: "> requested abcd\nold report" }], "abcd"), null);
  assert.equal(agentEvidenceCandidate([{ ...source, user: { login: "attacker" } }], "abcd"), null);
  assert.equal(agentEvidenceCandidate([{ ...source, body: '{"commit_sha":"old","ci":"requested abcd"}' }], "abcd"), null);
  assert.equal(agentEvidenceCandidate([{ ...source, body: "HEAD abcd; tests passed" }], "abcd").id, source.id);
  const result = await normalizeAgentEvidence(source, "abcd", ["src/a.js"], async (prompt) => {
    assert.match(prompt, /Copy commands\/results verbatim/);
    return JSON.stringify(report);
  });

  test("known coding-agent report shapes are adapted deterministically without rerolling model output or inventing results", () => {
    const data = { commit_sha: "abcd", tests: [{ path: "/home/repo/src/a.test.js",
      command: report.commands[0].command, result: "PASS: 1 passed, 0 failed" }],
      coverage: { unit: { result: "PASS", evidence: "Actual caller assertion" },
        integration: { reason: "Local stream only" }, playwright: { reason: "Backend only" } } };
    const source = { ...comment, body: `> quoted request\n${JSON.stringify(data)}` };
    const normalized = structuredAgentEvidence(source, "abcd", ["src/a.test.js"]);
    assert.deepEqual(normalized.report.testPaths, ["src/a.test.js"]);
    assert.equal(normalized.report.commands[0].details, data.tests[0].result);
    assert.equal(normalized.report.commands[0].outcome, "passed");
    assert.equal(structuredAgentEvidence(source, "new", ["src/a.test.js"]), null);
    assert.equal(structuredAgentEvidence({ ...source, body: JSON.stringify({ ...data, coverage: null }) },
      "abcd", ["src/a.test.js"]), null);
    data.tests[0].result = "PASS: 1 passed, 2 failed";
    assert.equal(structuredAgentEvidence({ ...source, body: JSON.stringify(data) },
      "abcd", ["src/a.test.js"]).report.commands[0].outcome, "failed");
    const matrix = { commit_sha: "abcd", tests: { path: "src/a.test.js",
      focused_command: "node --test src/a.test.js", focused_result: "passed: 1/1",
      full_command: "node --test", full_result: "passed: 2/2", coverage: "Actual boundary/error assertions" },
      integration_tests: "Not run: no changed external boundary", playwright: "Backend-only, not applicable" };
    const normalizedMatrix = structuredAgentEvidence({ ...source, body: JSON.stringify(matrix) }, "abcd", ["src/a.test.js"]);
    assert.deepEqual(normalizedMatrix.report.commands.map((command) => command.details), ["passed: 1/1", "passed: 2/2"]);
    assert.equal(normalizedMatrix.report.layers.integration, matrix.integration_tests);
  });
  assert.equal(result.comment.id, source.id);
  assert.deepEqual(result.report, report);
  assert.throws(() => validateNormalizedEvidence({ ...report,
    commands: [{ ...report.commands[0], details: "999 tests passed" }] }, source, "abcd"), /invented/);
  assert.throws(() => validateNormalizedEvidence({ ...report, sha: "old" }, source, "abcd"), /wrong commit/);
});

test("thread verification requires complete per-ID decisions and affirmative coverage even with zero conversations", async () => {
  const context = { threads: [{ id: "ONE" }, { id: "TWO" }] };
  const valid = { coverage: { decision: "verified", reason: "Actual caller and assertions exercised" },
    threads: context.threads.map((thread) => ({ id: thread.id, decision: "resolve", reason: "Specific assertion proves fix" })) };
  assert.deepEqual(await verifyReviewThreads(context, async () => JSON.stringify(valid)), valid);
  for (const invalid of [{ ...valid, threads: [valid.threads[0]] },
    { ...valid, threads: [valid.threads[0], valid.threads[0]] }, { ...valid, coverage: null },
    { ...valid, threads: [null, null] }, { ...valid, sha: "forged" }]) {
    await assert.rejects(verifyReviewThreads(context, async () => JSON.stringify(invalid)), /invalid_schema/);
  }
  await assert.rejects(verifyReviewThreads({ threads: [] }, async () => '{"threads":[]}'), /invalid_schema/);
});

test("review verification diagnoses schema fields safely, bounds prose, and retries only invalid protocol on unchanged state", async () => {
  let calls = 0;
  const valid = { coverage: { decision: "verified", reason: "Specific discoverable assertion" }, threads: [] };
  const recovered = await verifyReviewThreads({ threads: [] }, async (prompt) => {
    calls++;
    assert.match(prompt, /hard maximum 1000/);
    return JSON.stringify(calls === 1 ? { ...valid, coverage: { ...valid.coverage, reason: "x".repeat(1001) } } : valid);
  });
  assert.deepEqual(recovered, valid);
  assert.equal(calls, 2);
  await assert.rejects(verifyReviewThreads({ threads: [] }, async () =>
    JSON.stringify({ ...valid, coverage: { decision: "verified", reason: "" } })), /invalid_schema_coverage_reason/);
  calls = 0;
  await assert.rejects(verifyReviewThreads({ threads: [] }, async () => { calls++; return "{}"; },
    async () => false), /state_changed/);
  assert.equal(calls, 1);
  calls = 0;
  const human = { ...valid, coverage: { decision: "human", reason: "Actual testing blocker" } };
  assert.deepEqual(await verifyReviewThreads({ threads: [] }, async () => { calls++; return JSON.stringify(human); }), human);
  assert.equal(calls, 1);
});

function auditFixture() {
  const tag = "<!-- devex-copilot-approve --><!-- sha:abcd:bace -->";
  const pr = { number: 8, state: "open", draft: false, user: { login: "Copilot" },
    head: { sha: "abcd", ref: "copilot/fix", repo: { id: 1, full_name: "owner/repo" } },
    base: { sha: "bace", ref: "main", repo: { id: 1, full_name: "owner/repo" } } };
  const comments = [{ id: 42, user: { login: "app[bot]" }, updated_at: "2026-10-03T10:00:00Z",
    body: `${tag}\nLeft workflow run(s) for this commit pending manual approval after an automated risk review: invalid_json` }];
  const runs = [{
    id: 10, workflow_id: 100, event: "pull_request", head_sha: "abcd", pull_requests: [{ number: 8 }],
    created_at: "2026-10-03T10:00:00Z", status: "completed", conclusion: "action_required", run_attempt: 1,
  }, {
    id: 11, workflow_id: 100, event: "pull_request", head_sha: "abcd", pull_requests: [{ number: 8 }],
    created_at: "2026-10-03T11:00:00Z", status: "completed", conclusion: "success", run_attempt: 2,
    triggering_actor: { login: "app[bot]" },
  }];
  const writes = [];
  const api = {
    pages: async (path) => path.includes("/pulls?") ? [pr] : comments,
    workflowRuns: async () => runs,
    request: async (path, options) => {
      if (!options) return pr;
      writes.push({ path, ...options });
      if (options.method === "PATCH") comments.find((comment) => path.endsWith(`/${comment.id}`)).body = options.body.body;
      return {};
    },
  };
  return { tag, pr, comments, runs, writes, api };
}

test("approval transitions update the owned comment, preserve history and deduplicate unchanged outcomes", async () => {
  const { api, tag, comments, writes } = auditFixture();
  comments.unshift({ id: 99, user: { login: "other[bot]" }, body: `${tag}\nforged decision` });
  const approvedBody = `${tag}\nAuto-approved after validated risk review`;
  assert.equal(await upsertAudit(api, "owner/repo", 8, "app[bot]", "abcd", "bace", approvedBody), "updated");
  assert.equal(writes[0].path, "/repos/owner/repo/issues/comments/42");
  assert.match(writes[0].body.body, /Previous decision/);
  assert.match(writes[0].body.body, /invalid_json/);
  assert.equal(await upsertAudit(api, "owner/repo", 8, "app[bot]", "abcd", "bace", approvedBody), "unchanged");
  assert.equal(writes.length, 1);
  assert.equal(updatedAuditBody(approvedBody, approvedBody, "now"), null);
  await assert.rejects(upsertAudit(api, "owner/repo", 8, "", "abcd", "bace", approvedBody), /exact App bot/);
});

test("validated risk blocks persist across sweeps only for the same authenticated head/base, not protocol errors", async () => {
  const { api, tag, comments } = auditFixture();
  assert.equal(await previousRiskBlock(api, "owner/repo", 8, "app[bot]", "abcd", "bace"), null);
  comments.push({ id: 43, user: { login: "app[bot]" }, body: `${tag}\n${marker("devex-copilot-risk-decision", {
    sha: "abcd", base: "bace", verdict: "block", touches_ci: false, reason: "Unsafe change",
  })}` });
  assert.equal((await previousRiskBlock(api, "owner/repo", 8, "app[bot]", "abcd", "bace")).verdict, "block");
  assert.equal(await previousRiskBlock(api, "owner/repo", 8, "app[bot]", "new", "bace"), null);
  assert.equal(await previousRiskBlock(api, "owner/repo", 8, "app[bot]", "abcd", "new"), null);
  assert.equal(await previousRiskBlock(api, "owner/repo", 8, "other[bot]", "abcd", "bace"), null);
  comments.at(-1).body = `${tag}\n${marker("devex-copilot-risk-decision", {
    sha: "abcd", base: "bace", verdict: "block", touches_ci: "false", reason: "Invalid",
  })}`;
  await assert.rejects(previousRiskBlock(api, "owner/repo", 8, "app[bot]", "abcd", "bace"), /Malformed trusted/);
});

test("stale approval warnings recover from actual latest successful events without releasing obsolete draft runs", async () => {
  const { api, comments, writes } = auditFixture();
  assert.equal(await refreshCompletedAudits(api, "owner/repo", "app[bot]", true), 0);
  assert.equal(writes.length, 0);
  assert.equal(await refreshCompletedAudits(api, "owner/repo", "app[bot]"), 1);
  assert.match(comments[0].body, /latest eligible workflow runs/);
  assert.match(comments[0].body, /not a new model approval/);
  assert.equal(writes.every((write) => write.method === "PATCH"), true);
  assert.equal(await refreshCompletedAudits(api, "owner/repo", "app[bot]"), 0);
});

test("audit recovery cannot hide newer failures/pending runs, foreign releases, human PRs or changed heads", async () => {
  for (const failure of ["failure", "pending", "foreign", "human", "fork"]) {
    const { api, pr, runs, writes } = auditFixture();
    if (failure === "failure") runs[1].conclusion = "failure";
    if (failure === "pending") runs[1].status = "queued";
    if (failure === "foreign") runs[1].triggering_actor.login = "other[bot]";
    if (failure === "human") pr.user.login = "owner";
    if (failure === "fork") pr.head.repo = { id: 2, full_name: "outsider/repo" };
    assert.equal(await refreshCompletedAudits(api, "owner/repo", "app[bot]"), 0);
    assert.equal(writes.length, 0);
  }
});
