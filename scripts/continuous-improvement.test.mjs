import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EVIDENCE_TAG, marker, publishEvidenceBody } from "./review-lifecycle.mjs";
import { sonarPolicyMarker, SONAR_POLICY_VERSION } from "./sonar-policy.mjs";
import { CHANGE_SCOPE_VERSION, changeScopeMarker } from "./change-scope.mjs";
import {
  addContext,
  analyze,
  activeEscalation,
  checkState,
  diffRisk,
  ensureBatchLabel,
  improvementTask,
  main,
  parseAllowlist,
  parseBatch,
  scanAlerts,
  selectCandidates,
  selectRepositories,
  validateProposal,
} from "./continuous-improvement.mjs";

function assertCoverageRequirements(text) {
  assert.match(text, /Add or extend focused unit\/regression tests/);
  assert.match(text, /integration tests when affected behavior crosses/);
  assert.match(text, /Playwright tests for affected user-facing journeys when the repository uses Playwright/);
  assert.match(text, /backend-only changes do not require browser tests/);
  assert.match(text, /Use existing test frameworks and patterns/);
  assert.match(text, /identify the exact tests and explain why additions are unnecessary/);
}

function assertTestingInstructions(text) {
  assertCoverageRequirements(text);
  assert.match(text, /PR description, record added\/updated test paths, commands, pass\/fail outcomes/);
  assert.match(text, /stop for human guidance; never omit required coverage to meet the size limit/);
  assert.match(text, /targeted tests may live in separate test directories/);
  assert.match(text, /Production and all unverified\/non-test changes: at most eight files and 250 added\/deleted lines/);
  assert.match(text, /Verified test-only changes: at most eight files and 750 added\/deleted lines/);
  assert.match(text, /Entire PR: at most 12 files and 1000 added\/deleted lines/);
  assert.match(text, /shared directory alone is not a relationship/);
  assert.match(text, /require zero blocking new findings/);
  assert.match(text, /existing CI-equivalent analyzer checks/);
  assert.match(text, /Advisory findings remain visible/);
}

test("improvement issues and agent assignments require appropriate new coverage within the same bounded scope", () => {
  const proposal = {
    title: "Simplify reminders", rationale: "Preserve recipient selection and failure isolation",
    alertIds: ["sonarcloud:One"], tests: ["dotnet test --filter ReminderTests"],
    cohesion: { kind: "single-finding", summary: "Preserve reminder recipient selection",
      members: [{ alertId: "sonarcloud:One", change: "Simplify one selection condition with focused regression coverage" }] },
    estimates: { nonTest: { files: 1, lines: 30 }, tests: { files: 2, lines: 300 } },
    alerts: [{ id: "sonarcloud:One", severity: "medium", summary: "Simplify", url: "https://sonarcloud.io/example" }],
  };
  const counts = { "code-scanning": 2, sonarcloud: 4 };
  const task = improvementTask("owner/repo", "main", proposal, counts);
  assert.equal(task.title, "Continuous improvement: Simplify reminders");
  assert.deepEqual(parseBatch(task.body), { alertIds: proposal.alertIds, baseline: counts,
    changeScope: CHANGE_SCOPE_VERSION, cohesion: proposal.cohesion, estimates: proposal.estimates });
  assert.deepEqual(task.labels, ["platform-devex-ci"]);
  assert.deepEqual(task.assignees, ["copilot-swe-agent[bot]"]);
  assert.equal(task.agent_assignment.target_repo, "owner/repo");
  assert.equal(task.agent_assignment.base_branch, "main");
  assertTestingInstructions(task.body);
  assertTestingInstructions(task.agent_assignment.custom_instructions);
  assert.match(task.body, /Suggested verification: dotnet test --filter ReminderTests/);
  assert.match(task.body, /Estimated change budget.*non-test 1 files \/ 30 lines; verified tests 2 files \/ 300 lines/);
  assert.match(task.body, /Human review and merge are required/);
  const longCommand = `dotnet test ${"Established.Test.Project/".repeat(12)}Unit.csproj --filter FullyQualifiedName~ExactRegressionCase`;
  assert.ok(longCommand.length > 250);
  assert.ok(improvementTask("owner/repo", "main", { ...proposal, tests: [longCommand] }, counts).body.includes(longCommand),
    "suggested commands must not silently truncate their project path or regression filter");
});

test("allowlist is explicit, deduplicated and rejects unsafe names", () => {
  assert.deepEqual(parseAllowlist(" first, second,first "), ["first", "second"]);
  assert.deepEqual(parseAllowlist(""), []);
  assert.throws(() => parseAllowlist("repo,other/third"), /repository names/);
});

test("batch marker ignores unrelated issues and rejects invalid IDs", () => {
  assert.equal(parseBatch("Ordinary issue"), null);
  assert.deepEqual(parseBatch('<!-- platform-devex-ci-batch-v1:{"alertIds":["dependabot:15"]} -->'),
    { alertIds: ["dependabot:15"] });
  assert.deepEqual(parseBatch('<!-- platform-devex-ci-batch-v1:{"alertIds":["sonarcloud:AaDaEDTYk1PEmkU3Sahr"],"baseline":{"sonarcloud":1982}} -->'),
    { alertIds: ["sonarcloud:AaDaEDTYk1PEmkU3Sahr"], baseline: { sonarcloud: 1982 } });
  assert.throws(() => parseBatch('<!-- platform-devex-ci-batch-v1:{"alertIds":["bogus"]} -->'), /Invalid/);
  assert.throws(() => parseBatch('<!-- platform-devex-ci-batch-v1:{"alertIds":["sonarcloud:"]} -->'), /Invalid/);
  assert.throws(() => parseBatch('<!-- platform-devex-ci-batch-v1:{"alertIds":["sonarcloud:safe"],"baseline":{"sonarcloud":-1}} -->'), /Invalid/);
});

test("missing batch label is created once and unrelated API errors are not hidden", async () => {
  const calls = [];
  const missing = { request: async (path, options) => {
    calls.push({ path, options });
    if (!options) throw new Error("GitHub GET labels returned HTTP 404");
    return {};
  } };
  await ensureBatchLabel(missing, "owner/repo");
  assert.deepEqual(calls.map(({ path }) => path), [
    "/repos/owner/repo/labels/platform-devex-ci", "/repos/owner/repo/labels",
  ]);
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.body.name, "platform-devex-ci");
  const present = { request: async () => ({ name: "platform-devex-ci" }) };
  await ensureBatchLabel(present, "owner/repo");
  await assert.rejects(ensureBatchLabel({
    request: async () => { throw new Error("GitHub GET labels returned HTTP 403"); },
  }, "owner/repo"), /HTTP 403/);
});

test("check state does not treat stale commit statuses as failures", () => {
  const checks = { check_runs: [{ status: "completed", conclusion: "success" }] };
  assert.equal(checkState(checks, { state: "success", statuses: [{ state: "failure" }, { state: "success" }] }), "passed");
  assert.equal(checkState(checks, { state: "pending", statuses: [] }), "passed");
  assert.equal(checkState(checks, { state: "failure", statuses: [{ state: "failure" }] }), "failed");
  assert.equal(checkState({ check_runs: [] }, { state: "pending", statuses: [] }), "pending");
  assert.equal(checkState({ check_runs: [{ status: "in_progress" }] }, { state: "pending", statuses: [] }), "pending");
  assert.equal(checkState({ check_runs: [{ status: "completed", conclusion: "skipped" }] },
    { state: "pending", statuses: [] }), "pending");
  assert.equal(checkState({ check_runs: [{ status: "completed", conclusion: "neutral" }] },
    { state: "pending", statuses: [] }), "pending");
  assert.equal(checkState({ check_runs: [
    { name: "build", status: "completed", conclusion: "skipped" },
    { name: "copilot-pull-request-reviewer", status: "completed", conclusion: "success" },
  ] }, { state: "pending", statuses: [] }), "pending");
  assert.equal(checkState({ check_runs: [] }, { state: "success", statuses: [{ state: "success" }] }), "passed");
});

test("cancelled and approval-required checks never become code-fix requests or passing checks", () => {
  const status = { state: "pending", statuses: [] };
  const cancelled = { name: "build", status: "completed", conclusion: "cancelled" };
  assert.equal(checkState({ check_runs: [cancelled] }, status), "cancelled");
  assert.equal(checkState({ check_runs: [cancelled, { status: "in_progress" }] }, status), "pending");
  assert.equal(checkState({ check_runs: [cancelled, { status: "completed", conclusion: "failure" }] }, status), "failed");
  assert.equal(checkState({ check_runs: [{ ...cancelled, conclusion: "action_required" }] }, status), "pending");
  assert.equal(checkState({ check_runs: [{ ...cancelled, conclusion: "stale" }] }, status), "blocked");
  assert.equal(checkState({ check_runs: [
    { name: "copilot", status: "completed", conclusion: "success" },
    { name: "build", status: "completed", conclusion: "skipped" },
  ] }, status), "pending");
});

test("analysis cannot select unknown, critical or unrelated findings", () => {
  const alerts = [
    { id: "code-scanning:1", severity: "medium", path: "src/a.js" },
    { id: "code-scanning:2", severity: "low", path: "other/b.js" },
    { id: "dependabot:3", severity: "critical", path: "src/package.json" },
  ];
  const proposal = { decision: "propose", risk: "low", title: "Fix", rationale: "small",
    tests: ["npm test"], alertIds: ["code-scanning:1"],
    cohesion: { kind: "single-finding", summary: "One bounded fix",
      members: [{ alertId: "code-scanning:1", change: "Address the selected finding" }] },
    estimates: { nonTest: { files: 1, lines: 20 }, tests: { files: 1, lines: 40 } } };
  assert.deepEqual(validateProposal(proposal, alerts)?.alertIds, proposal.alertIds);
  assert.equal(validateProposal({ ...proposal, alertIds: ["code-scanning:1", "code-scanning:2"] }, alerts), null);
  assert.equal(validateProposal({ ...proposal, alertIds: ["dependabot:3"] }, alerts), null);
  assert.equal(validateProposal({ ...proposal, alertIds: ["code-scanning:9"] }, alerts), null);
  assert.equal(validateProposal({ ...proposal, risk: "high" }, alerts), null);
  assert.equal(validateProposal({ ...proposal, risk: "medium" }, alerts)?.risk, "medium");
  const sonar = { id: "sonarcloud:key", source: "sonarcloud", path: "src/other.js", severity: "BLOCKER" };
  assert.equal(validateProposal({ ...proposal, alertIds: [sonar.id] }, [...alerts, sonar]), null);
});

test("multi-finding selection requires an explicit per-finding relationship and bounded separate estimates", () => {
  const alerts = [
    { id: "sonarcloud:A", source: "sonarcloud", rule: "same", path: "src/A.cs", severity: "medium" },
    { id: "sonarcloud:B", source: "sonarcloud", rule: "same", path: "src/B.cs", severity: "medium" },
    { id: "sonarcloud:C", source: "sonarcloud", rule: "other", path: "src/C.cs", severity: "medium" },
  ];
  const proposal = { decision: "propose", risk: "low", title: "One pattern", rationale: "Preserve behavior",
    alertIds: ["sonarcloud:A", "sonarcloud:B"], tests: ["dotnet test"],
    cohesion: { kind: "repeated-corrective-pattern", summary: "Apply the same bounded correction",
      members: [{ alertId: "sonarcloud:A", change: "Correct the same operation in A" },
        { alertId: "sonarcloud:B", change: "Correct the same operation in B" }] },
    estimates: { nonTest: { files: 2, lines: 100 }, tests: { files: 3, lines: 500 } } };
  assert.ok(validateProposal(proposal, alerts));
  for (const change of [
    { cohesion: undefined }, { estimates: undefined },
    { cohesion: { ...proposal.cohesion, summary: "" } },
    { cohesion: { ...proposal.cohesion, kind: "single-finding" } },
    { cohesion: { ...proposal.cohesion, members: [proposal.cohesion.members[0]] } },
    { cohesion: { ...proposal.cohesion, members: [proposal.cohesion.members[0], proposal.cohesion.members[0]] } },
    { estimates: { ...proposal.estimates, nonTest: { files: 2, lines: 251 } } },
    { estimates: { ...proposal.estimates, tests: { files: 3, lines: 751 } } },
    { estimates: { nonTest: { files: 8, lines: 100 }, tests: { files: 5, lines: 100 } } },
  ]) assert.equal(validateProposal({ ...proposal, ...change }, alerts), null);
  const differentRule = alerts.map((alert) => alert.id === "sonarcloud:B" ? { ...alert, rule: "other" } : alert);
  assert.equal(validateProposal(proposal, differentRule), null);
  const rootCause = { ...proposal, cohesion: { ...proposal.cohesion, kind: "shared-root-cause" } };
  assert.equal(validateProposal(rootCause, differentRule), null, "same directory alone is insufficient");
  assert.ok(validateProposal(rootCause, differentRule.map((alert) => ({ ...alert, path: "src/A.cs" }))),
    "different symptoms in one file require an explicitly explained shared root cause");
  const reasons = [];
  assert.equal(validateProposal({ ...proposal, estimates: { ...proposal.estimates,
    tests: { files: 3, lines: 751 } } }, alerts, (reason) => reasons.push(reason)), null);
  assert.deepEqual(reasons, ["change_budget"], "logs identify the safe rejection category without dumping the response");
});

test("diff gate blocks sensitive paths and oversized changes", () => {
  const pr = { changed_files: 1, additions: 5, deletions: 1 };
  const file = { filename: "src/a.js", additions: 5, deletions: 1 };
  assert.equal(diffRisk(pr, [file]), null);
  assert.match(diffRisk(pr, [{ ...file, filename: ".github/workflows/ci.yml" }]), /gated path/);
  assert.match(diffRisk(pr, [{ ...file, previous_filename: "infra/main.tf" }]), /gated path/);
  assert.equal(diffRisk({ ...pr, additions: 249 }, [{ ...file, additions: 249 }]), null);
  assert.match(diffRisk({ ...pr, additions: 250 }, [{ ...file, additions: 250 }]), /250-line/);
  assert.match(diffRisk({ changed_files: 9, additions: 9, deletions: 0 },
    Array.from({ length: 9 }, (_, n) => ({ filename: `src/${n}.js`, additions: 1, deletions: 0 }))), /eight-file/);
  const files = ["src/a.js", "tests/unit/a.test.js", "tests/integration/a.test.js", "tests/playwright/a.spec.js"]
    .map((filename) => ({ filename, additions: 50, deletions: 5 }));
  assert.equal(diffRisk({ changed_files: 4, additions: 200, deletions: 20 }, files), null);
  files[0].additions += 30;
  files[0].deletions++;
  assert.match(diffRisk({ changed_files: 4, additions: 230, deletions: 21 }, files), /250-line/);
});

test("candidate sampling spans scanners and rules instead of the first noisy findings", () => {
  const alerts = [
    ...Array.from({ length: 30 }, (_, n) => ({ id: `code-scanning:${n + 1}`,
      source: "code-scanning", rule: "same", path: "src/controller/a.cs", severity: "medium" })),
    ...Array.from({ length: 20 }, (_, n) => ({ id: `sonarcloud:Smell${n}`,
      source: "sonarcloud", rule: "CA2007", path: "src/other/b.cs", severity: "medium" })),
    { id: "sonarcloud:Better", source: "sonarcloud", rule: "S1234", path: "src/other/c.cs", severity: "low" },
    { id: "dependabot:99", source: "dependabot", rule: "package", path: "src/package.json", severity: "high" },
    { id: "sonarcloud:Unsafe", source: "sonarcloud", rule: "S9999", path: "src/other/d.cs", severity: "critical" },
  ];
  const selected = selectCandidates(alerts, new Set(["code-scanning:1"]));
  assert.ok(selected.length <= 24);
  assert.equal(selected.includes(alerts[0]), false);
  assert.ok(selected.some((alert) => alert.id === "dependabot:99"));
  assert.ok(selected.some((alert) => alert.id === "sonarcloud:Better"));
  assert.ok(selected.some((alert) => alert.source === "code-scanning"));
  assert.equal(selected.some((alert) => alert.id === "sonarcloud:Unsafe"), false);
});

test("candidate sampling prioritizes higher-impact rules over large cosmetic groups", () => {
  const alerts = Array.from({ length: 100 }, (_, index) => ({
    id: `sonarcloud:Style${index}`, source: "sonarcloud", rule: "CS1591",
    path: "src/a.cs", severity: "medium",
  }));
  alerts.push({
    id: "sonarcloud:Impact", source: "sonarcloud", rule: "S927",
    path: "src/b.cs", severity: "high",
  });
  assert.equal(selectCandidates(alerts)[0].id, "sonarcloud:Impact");
});

test("code-scanning numeric and textual security severities preserve critical protection", async () => {
  const records = ["9.1", "7.5", "4.2", "critical", "high", "medium"].map((score, index) => ({
    number: index + 1, rule: { id: `rule-${index}`, security_severity_level: score },
    most_recent_instance: { location: { path: `src/${index}.js`, start_line: 5 } },
  }));
  const api = { pages: async () => records };
  const scan = await scanAlerts(api, "owner/repo", ["code-scanning"]);
  assert.deepEqual(scan.alerts.map((alert) => alert.severity),
    ["critical", "high", "medium", "critical", "high", "medium"]);
  assert.equal(selectCandidates(scan.alerts).some((alert) => ["code-scanning:1", "code-scanning:4"].includes(alert.id)), false);
  assert.equal(validateProposal({
    decision: "propose", risk: "medium", title: "Security fix",
    rationale: "Fix the issue", tests: ["npm test"], alertIds: ["code-scanning:1"],
  }, scan.alerts), null);
  records[0].rule.security_severity_level = "unexpected";
  await assert.rejects(scanAlerts(api, "owner/repo", ["code-scanning"]), /Invalid code-scanning security severity/);
});

test("SonarCloud scan verifies its project and reads every page before reporting the count", async () => {
  const paths = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const request = new URL(url);
    assert.equal(request.hostname, "sonarcloud.io");
    paths.push(request.pathname);
    assert.equal(options.headers.Authorization, "Bearer read-token");
    if (request.pathname === "/api/components/show") {
      assert.equal(request.searchParams.get("component"), "owner_repo");
      return Response.json({ component: {
        key: "owner_repo", organization: "owner", qualifier: "TRK", analysisDate: "2026-10-02T06:00:00+0000",
      } });
    }
    assert.equal(request.pathname, "/api/issues/search");
    assert.equal(request.searchParams.get("branch"), "main");
    assert.equal(request.searchParams.get("types"), "CODE_SMELL");
    assert.equal(request.searchParams.get("resolved"), "false");
    const page = Number(request.searchParams.get("p"));
    const issues = Array.from({ length: page === 1 ? 500 : 1 }, (_, index) => ({
      key: `Key${(page - 1) * 500 + index}`, project: "owner_repo",
      component: "owner_repo:src/a.cs", rule: "csharpsquid:S1234", type: "CODE_SMELL",
      message: "Improve this source", severity: "MAJOR", impacts: [
        { softwareQuality: "MAINTAINABILITY", severity: "MEDIUM" },
      ], textRange: { startLine: 7 },
    }));
    return Response.json({ total: 501, paging: { pageIndex: page, pageSize: 500, total: 501 }, issues });
  };
  try {
    const api = { request: async (path) => {
      if (path === "/repos/owner/repo") return { default_branch: "main" };
      assert.equal(path, "/repos/owner/repo/commits/main");
      return { commit: { committer: { date: "2026-10-01T06:00:00Z" } } };
    } };
    const scan = await scanAlerts(api, "owner/repo", ["sonarcloud"], "read-token");
    assert.equal(scan.complete, true);
    assert.equal(scan.sonarIsCurrent, true);
    assert.equal(scan.counts.sonarcloud, 501);
    assert.equal(scan.alerts.length, 501);
    assert.deepEqual(scan.alerts[0], {
      id: "sonarcloud:Key0", source: "sonarcloud", rule: "csharpsquid:S1234",
      type: "CODE_SMELL", sonarSeverity: "MAJOR",
      impacts: [{ softwareQuality: "MAINTAINABILITY", severity: "MEDIUM" }],
      path: "src/a.cs", line: 7, severity: "medium", summary: "Improve this source",
      url: "https://sonarcloud.io/project/issues?id=owner_repo&issues=Key0",
    });
    assert.deepEqual(paths, ["/api/components/show", "/api/issues/search", "/api/issues/search"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("unknown, unauthorized and truncated SonarCloud scans cannot be treated as clean", async () => {
  const previousFetch = globalThis.fetch;
  const api = { request: async (path) => path.endsWith("/commits/main")
    ? { commit: { committer: { date: "2026-10-01T06:00:00Z" } } }
    : { default_branch: "main" } };
  const project = { component: {
    key: "owner_repo", organization: "owner", qualifier: "TRK", analysisDate: "2026-10-02T06:00:00+0000",
  } };
  try {
    globalThis.fetch = async () => new Response("", { status: 404 });
    await assert.rejects(scanAlerts(api, "owner/repo", ["sonarcloud"]), /HTTP 404/);
    globalThis.fetch = async () => new Response("", { status: 401 });
    await assert.rejects(scanAlerts(api, "owner/repo", ["sonarcloud"], "revoked"), /HTTP 401/);
    globalThis.fetch = async (url) => new URL(url).pathname === "/api/components/show"
      ? Response.json(project)
      : Response.json({ total: 10001, paging: { pageIndex: 1, pageSize: 500 }, issues: [] });
    await assert.rejects(scanAlerts(api, "owner/repo", ["sonarcloud"]), /incomplete or invalid SonarCloud/);
    globalThis.fetch = async (url) => new URL(url).pathname === "/api/components/show"
      ? Response.json({ component: { key: "other_project", qualifier: "TRK", organization: "owner",
        analysisDate: "2026-10-02T06:00:00+0000" } })
      : Response.json({ total: 0, paging: { pageIndex: 1, pageSize: 500 }, issues: [] });
    await assert.rejects(scanAlerts(api, "owner/repo", ["sonarcloud"]), /project or analysis metadata is invalid/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("SonarCloud paths relative to src resolve to real GitHub files and share lookups", async () => {
  const paths = [];
  const api = { request: async (path) => {
    paths.push(path);
    if (path === "/repos/owner/repo") return { default_branch: "main" };
    if (path === "/repos/owner/repo/contents/src/Project/File.cs?ref=main") {
      return { type: "file", size: 32, encoding: "base64",
        content: Buffer.from("public class File {}").toString("base64") };
    }
    throw new Error(`GitHub GET ${path} returned HTTP 404`);
  } };
  const alerts = ["First", "Second"].map((id) => ({
    id: `sonarcloud:${id}`, source: "sonarcloud", path: "Project/File.cs", line: 1,
  }));
  const contextual = await addContext(api, "owner/repo", alerts);
  assert.equal(contextual.length, 2);
  assert.deepEqual(contextual.map((alert) => alert.path), ["src/Project/File.cs", "src/Project/File.cs"]);
  assert.match(contextual[0].context, /public class File/);
  assert.deepEqual(paths, [
    "/repos/owner/repo", "/repos/owner/repo/contents/Project/File.cs?ref=main",
    "/repos/owner/repo/contents/src/Project/File.cs?ref=main",
  ]);
});

test("SDK impact analysis has no tools and validates its response", async () => {
  const oldToken = process.env.GITHUB_TOKEN;
  const oldPat = process.env.COPILOT_AGENT_PAT;
  const oldSonarToken = process.env.SONAR_TOKEN;
  let baseDirectory;
  process.env.GITHUB_TOKEN = "test";
  process.env.COPILOT_AGENT_PAT = "test-human";
  process.env.SONAR_TOKEN = "test-sonar";
  try {
    const result = await analyze([{ id: "code-scanning:1", path: "src/a.js" }], async (options) => {
      assert.equal(options.mode, "empty");
      assert.equal(options.gitHubToken, undefined);
      assert.equal(options.useLoggedInUser, false);
      assert.equal(options.env.COPILOT_AGENT_PAT, undefined);
      assert.equal(options.env.COPILOT_GITHUB_TOKEN, undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env.SONAR_TOKEN, undefined);
      baseDirectory = options.baseDirectory;
      await access(baseDirectory);
      return {
        createSession: async (config) => {
          assert.deepEqual(config.availableTools, []);
          assert.equal(config.onPermissionRequest().kind, "reject");
          assert.equal(config.skipCustomInstructions, true);
          assert.equal(config.sessionLimits.maxAiCredits, 30);
          assert.equal(config.gitHubToken, "test-human");
          return {
            sendAndWait: async (message, timeoutMs) => {
              assert.equal(timeoutMs, 240_000);
              assert.equal(message.responseSchema, undefined);
              assert.match(message.prompt, /alertIds \(array of IDs\)/);
              assertCoverageRequirements(message.prompt);
              assert.match(message.prompt, /READ-ONLY INTAKE PLANNER/);
              assert.match(message.prompt, /Lack of shell\/repository tools.*NOT a reason to skip planning/);
              assert.match(message.prompt, /FUTURE IMPLEMENTER/);
              assert.doesNotMatch(message.prompt, /platform-devex-ci-evidence|committed clean tree|patch_committed/);
              return { data: { content: '{"decision":"skip","rationale":"No bounded safe fix in these excerpts"}' } };
            },
          };
        },
        stop: async () => {},
      };
    });

    assert.equal(result.decision, "skip");
    await assert.rejects(access(baseDirectory), { code: "ENOENT" });
  } finally {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
    if (oldPat === undefined) delete process.env.COPILOT_AGENT_PAT;
    else process.env.COPILOT_AGENT_PAT = oldPat;
    if (oldSonarToken === undefined) delete process.env.SONAR_TOKEN;
    else process.env.SONAR_TOKEN = oldSonarToken;
  }
});

test("intake retries only malformed protocol on unchanged input, never valid skips or transport errors", async () => {
  const previous = process.env.COPILOT_AGENT_PAT;
  process.env.COPILOT_AGENT_PAT = "test-human";
  const skip = '{"decision":"skip","rationale":"Genuine uncertainty in the supplied data"}';
  const veto = JSON.stringify({ decision: "propose", risk: "high", title: "Risky fix", rationale: "Requires architecture changes",
    alertIds: ["sonarcloud:A"], tests: ["dotnet test"],
    cohesion: { kind: "single-finding", summary: "Unsafe change",
      members: [{ alertId: "sonarcloud:A", change: "Requires human review" }] },
    estimates: { nonTest: { files: 1, lines: 10 }, tests: { files: 1, lines: 10 } } });
  try {
    for (const scenario of ["retry", "changed", "valid-skip", "valid-veto", "transport", "twice-invalid"]) {
      let calls = 0;
      let stateChecks = 0;
      const factory = async () => ({
        createSession: async () => ({ sendAndWait: async ({ prompt }) => {
          calls++;
          if (calls === 2) assert.match(prompt, /SAME planning input/);
          if (scenario === "transport") throw new Error("SECRET_PRIVATE timeout");
          const content = scenario === "valid-veto" ? veto :
            scenario === "valid-skip" || (calls === 2 && scenario === "retry")
              ? skip : `\`\`\`json\n${skip}\n\`\`\``;
          return { data: { content } };
        } }),
        stop: async () => {},
      });
      const run = () => analyze([], factory, {}, async () => {
        stateChecks++; return scenario !== "changed";
      });
      if (["retry", "valid-skip"].includes(scenario)) assert.equal((await run()).decision, "skip");
      else if (scenario === "valid-veto") assert.equal((await run()).risk, "high");
      else await assert.rejects(run(), scenario === "changed" ? /state_changed/ :
        scenario === "transport" ? /analysis failed \(timeout\)/ : /invalid_json/);
      assert.equal(calls, ["retry", "twice-invalid"].includes(scenario) ? 2 : 1, scenario);
      assert.equal(stateChecks, ["retry", "changed", "twice-invalid"].includes(scenario) ? 1 : 0, scenario);
    }
  } finally {
    if (previous === undefined) delete process.env.COPILOT_AGENT_PAT;
    else process.env.COPILOT_AGENT_PAT = previous;
  }
});

test("discovery refuses repositories outside the installation", async () => {
  const api = { request: async () => ({ data: { repositories: [{ name: "safe" }] }, link: null }) };
  assert.deepEqual(await selectRepositories(api, ["safe"], ""), ["safe"]);
  await assert.rejects(selectRepositories(api, ["missing"], ""), /not installed/);
  await assert.rejects(selectRepositories(api, ["safe"], "other"), /not opted in/);
  assert.deepEqual(await selectRepositories(api, [], ""), []);
});

test("discovery follows GitHub cursor pagination and rejects cross-origin links", async () => {
  const calls = [];
  const api = { request: async (path) => {
    calls.push(path);
    return calls.length === 1
      ? { data: { repositories: [] }, link: '<https://api.github.com/installation/repositories?per_page=100&after=cursor>; rel="next"' }
      : { data: { repositories: [{ name: "safe" }] }, link: null };
  } };
  assert.deepEqual(await selectRepositories(api, ["safe"], ""), ["safe"]);
  assert.equal(calls[1], "/installation/repositories?per_page=100&after=cursor");
  const malicious = { request: async () => ({
    data: { repositories: [] }, link: '<https://example.com/installation/repositories>; rel="next"',
  }) };
  await assert.rejects(selectRepositories(malicious, ["safe"], ""), /pagination URL/);
});

test("discover mode writes an empty matrix when no repositories opted in", async () => {
  const folder = await mkdtemp(join(tmpdir(), "platform-devex-ci-"));
  const output = join(folder, "output");
  try {
    await writeFile(output, "");
    await main({ CI_MODE: "discover", CI_REPOSITORIES: "", APP_TOKEN: "unused", GITHUB_OUTPUT: output });
    assert.equal(await readFile(output, "utf8"), "repos=[]\n");
  } finally {
    await rm(folder, { recursive: true });
  }
});

test("an active Copilot issue reconciles to a human handoff without creating another issue", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    await run("true", "intake");
    assert.equal(state.writes.length, 0);
    assert.equal(state.verificationCalls, 1);
  } finally {
    restore();
  }
});

test("opted-in work requires the one human token", async () => {
  await assert.rejects(main({
    CI_MODE: "reconcile", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
    GITHUB_REPOSITORY_OWNER: "owner", APP_TOKEN: "app",
  }), /COPILOT_AGENT_PAT is required/);
});

test("cursor-paginated alerts and an unavailable source pause intake without an issue", async () => {
  const paths = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    paths.push(`${init.method} ${path}`);
    const result = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [],
      "/repos/owner/repo/issues?state=closed&labels=platform-devex-ci&per_page=100": [],
      "/repos/owner/repo/pulls?state=open&per_page=100": [],
    };
    if (path in result) return Response.json(result[path]);
    if (path === "/repos/owner/repo/code-scanning/alerts?state=open&per_page=100") {
      return Response.json([], { headers: {
        link: '<https://api.github.com/repositories/1234/code-scanning/alerts?state=open&per_page=100&after=cursor>; rel="next"',
      } });
    }
    if (path.endsWith("after=cursor")) return Response.json([]);
    if (path.startsWith("/repos/owner/repo/dependabot/alerts?")) return new Response("", { status: 404 });
    assert.fail(`unexpected request: ${path}`);
  };
  try {
    await main({
      CI_MODE: "intake", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
      CI_SCAN_SOURCES: "code-scanning,dependabot",
      GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: "false",
      APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]",
      COPILOT_AGENT_PAT: "human",
    });
    assert.ok(paths.some((path) => path.startsWith(
      "GET /repositories/1234/code-scanning/alerts?state=open&per_page=100&after=cursor")));
    assert.equal(paths.some((path) => path.startsWith("POST ")), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a stale alert pointing to a deleted file is skipped without opening an issue", async () => {
  const paths = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    paths.push(`${init.method} ${path}`);
    const result = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [],
      "/repos/owner/repo/issues?state=closed&labels=platform-devex-ci&per_page=100": [],
      "/repos/owner/repo/pulls?state=open&per_page=100": [],
      "/repos/owner/repo/code-scanning/alerts?state=open&per_page=100": [{
        number: 1, rule: { id: "rule", severity: "warning" },
        most_recent_instance: { location: { path: "src/deleted.js", start_line: 5 } },
      }],
      "/repos/owner/repo/dependabot/alerts?state=open&per_page=100": [],
      "/repos/owner/repo": { default_branch: "main" },
    };
    if (path === "/repos/owner/repo/contents/src/deleted.js?ref=main") return new Response("", { status: 404 });
    assert.ok(path in result, `unexpected request: ${path}`);
    return Response.json(result[path]);
  };
  try {
    await main({
      CI_MODE: "intake", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
      CI_SCAN_SOURCES: "code-scanning,dependabot",
      GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: "false",
      APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]", COPILOT_AGENT_PAT: "human",
    });
    assert.equal(paths.some((path) => path.startsWith("POST ")), false);
    assert.ok(paths.some((path) => path.includes("contents/src/deleted.js")));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("SonarCloud zero findings from before the latest commit pauses intake", async () => {
  const paths = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const request = new URL(url);
    if (request.hostname === "sonarcloud.io") {
      if (request.pathname === "/api/components/show") return Response.json({ component: {
        key: "owner_repo", organization: "owner", qualifier: "TRK", analysisDate: "2026-02-21T11:57:44Z",
      } });
      return Response.json({ total: 0, paging: { pageIndex: 1, pageSize: 500 }, issues: [] });
    }
    const path = request.pathname + request.search;
    paths.push(`${init.method} ${path}`);
    const replies = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [],
      "/repos/owner/repo/issues?state=closed&labels=platform-devex-ci&per_page=100": [],
      "/repos/owner/repo/pulls?state=open&per_page=100": [],
      "/repos/owner/repo": { default_branch: "main" },
      "/repos/owner/repo/commits/main": { commit: { committer: { date: "2026-09-27T01:18:20Z" } } },
    };
    assert.ok(path in replies, `unexpected request: ${path}`);
    return Response.json(replies[path]);
  };
  try {
    await main({
      CI_MODE: "intake", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
      CI_SCAN_SOURCES: "sonarcloud", GITHUB_REPOSITORY_OWNER: "owner",
      CI_DRY_RUN: "false", APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]", COPILOT_AGENT_PAT: "human",
    });
    assert.equal(paths.some((path) => path.startsWith("POST ")), false);
    assert.ok(paths.some((path) => path.includes("/commits/main")));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a manually closed batch issue still blocks a new batch while its linked PR is open", async () => {
  const paths = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    paths.push(`${init.method} ${path}`);
    const result = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [],
      "/repos/owner/repo/issues?state=closed&labels=platform-devex-ci&per_page=100": [{
        number: 7, body: '<!-- platform-devex-ci-batch-v1:{"alertIds":["dependabot:1"]} -->',
        user: { login: "owner" }, closed_at: new Date().toISOString(),
      }],
      "/repos/owner/repo/pulls?state=open&per_page=100": [{
        number: 8, body: "", user: { login: "copilot-swe-agent[bot]" },
        head: { ref: "copilot/fix", repo: { full_name: "owner/repo" } },
      }],
      "/repos/owner/repo/issues/7/timeline?per_page=100": [{
        event: "cross-referenced", source: { issue: { number: 8, pull_request: {} } },
      }],
      "/repos/owner/repo/pulls/8": {
        number: 8, state: "open", user: { login: "copilot-swe-agent[bot]" },
        head: { ref: "copilot/fix", repo: { full_name: "owner/repo" } },
      },
    };
    assert.ok(path in result, `unexpected request: ${path}`);
    return Response.json(result[path]);
  };
  try {
    await main({
      CI_MODE: "intake", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
      GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: "false",
      APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]",
      COPILOT_AGENT_PAT: "human",
    });
    assert.equal(paths.some((path) => path.startsWith("POST ")), false);
    assert.equal(paths.some((path) => path.includes("/code-scanning/alerts")), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a malformed alert cannot be mistaken for a resolved finding after merge", async () => {
  const writes = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (init.method !== "GET") {
      writes.push({ method: init.method, path, body: JSON.parse(init.body) });
      return Response.json({});
    }
    const result = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [{
        number: 7, body: '<!-- platform-devex-ci-batch-v1:{"alertIds":["code-scanning:1"]} -->',
        user: { login: "owner" },
      }],
      "/repos/owner/repo/issues/7/comments?per_page=100": [],
      "/repos/owner/repo/issues/7/timeline?per_page=100": [{
        event: "cross-referenced", source: { issue: { number: 8, pull_request: {} } },
      }],
      "/repos/owner/repo/pulls/8": {
        number: 8, state: "closed", merged_at: new Date().toISOString(),
        user: { login: "Copilot" },
        head: { ref: "copilot/fix", repo: { full_name: "owner/repo" } },
        base: { ref: "main", repo: { full_name: "owner/repo" } },
      },
      "/repos/owner/repo": { default_branch: "main" },
      "/repos/owner/repo/code-scanning/alerts?state=open&per_page=100": [{
        number: 1, rule: { id: "rule" }, most_recent_instance: {},
      }],
      "/repos/owner/repo/dependabot/alerts?state=open&per_page=100": [],
    };
    assert.ok(path in result, `unexpected request: ${path}`);
    return Response.json(result[path]);
  };
  try {
    await main({
      CI_MODE: "reconcile", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
      CI_SCAN_SOURCES: "code-scanning,dependabot",
      GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: "false",
      APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]",
      COPILOT_AGENT_PAT: "human",
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "POST");
    assert.equal(writes[0].path, "/repos/owner/repo/issues/7/comments");
    assert.match(writes[0].body.body, /Cannot verify all alert sources/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("merged SonarCloud batch waits for fresh analysis and records verified count reduction", async () => {
  const previousFetch = globalThis.fetch;
  const writes = [];
  const issueComments = [];
  const mergedAt = new Date(Date.now() - 60_000).toISOString();
  let analysisDate = new Date(Date.now() - 120_000).toISOString();
  let selectedStillOpen = true;
  globalThis.fetch = async (url, init) => {
    const request = new URL(url);
    if (request.hostname === "sonarcloud.io") {
      if (request.pathname === "/api/components/show") return Response.json({ component: {
        key: "owner_repo", organization: "owner", qualifier: "TRK", analysisDate,
      } });
      const ids = selectedStillOpen ? ["Old", "New1", "New2", "New3"] : ["New1", "New2", "New3", "New4"];
      return Response.json({ total: 4, paging: { pageIndex: 1, pageSize: 500 },
        issues: ids.map((key) => ({ key, project: "owner_repo", component: "owner_repo:src/a.cs",
          rule: "S1234", type: "CODE_SMELL", message: "Quality issue", severity: "MINOR" })) });
    }
    const path = request.pathname + request.search;
    if (init.method !== "GET") {
      writes.push({ path, method: init.method, body: JSON.parse(init.body) });
      if (path === "/repos/owner/repo/issues/7/comments") {
        issueComments.push({ user: { login: "app[bot]" }, body: JSON.parse(init.body).body });
      }
      return Response.json({});
    }
    const replies = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [{
        number: 7, body: '<!-- platform-devex-ci-batch-v1:{"alertIds":["sonarcloud:Old"],"baseline":{"sonarcloud":5}} -->',
        user: { login: "owner" },
      }],
      "/repos/owner/repo/issues/7/comments?per_page=100": issueComments,
      "/repos/owner/repo/issues/7/timeline?per_page=100": [{
        event: "cross-referenced", source: { issue: { number: 8, pull_request: {} } },
      }],
      "/repos/owner/repo/pulls/8": {
        number: 8, state: "closed", merged_at: mergedAt,
        user: { login: "Copilot" },
        head: { ref: "copilot/fix", repo: { full_name: "owner/repo" } },
        base: { ref: "main", repo: { full_name: "owner/repo" } },
      },
      "/repos/owner/repo": { default_branch: "main" },
      "/repos/owner/repo/commits/main": { commit: { committer: { date: mergedAt } } },
    };
    assert.ok(path in replies, `unexpected request: ${path}`);
    return Response.json(replies[path]);
  };
  const env = {
    CI_MODE: "reconcile", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
    CI_SCAN_SOURCES: "sonarcloud", GITHUB_REPOSITORY_OWNER: "owner",
    CI_DRY_RUN: "false", APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]", COPILOT_AGENT_PAT: "human",
  };
  try {
    await main(env);
    assert.equal(writes.length, 0);
    analysisDate = new Date(Date.now() + 60_000).toISOString();
    await main(env);
    assert.equal(writes.length, 0);
    selectedStillOpen = false;
    await main(env);
    assert.deepEqual(writes.map(({ path, method }) => `${method} ${path}`), [
      "POST /repos/owner/repo/issues/7/comments", "PATCH /repos/owner/repo/issues/7",
    ]);
    assert.match(writes[0].body.body, /Verified 1 targeted findings resolved/);
    assert.match(writes[0].body.body, /sonarcloud: 5 -> 4 \(net 1\)/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("disabling the source of a merged batch escalates instead of claiming resolution", async () => {
  const previousFetch = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (init.method !== "GET") {
      writes.push({ path, body: JSON.parse(init.body) });
      return Response.json({});
    }
    const replies = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [{
        number: 7, body: '<!-- platform-devex-ci-batch-v1:{"alertIds":["sonarcloud:Old"]} -->',
        user: { login: "owner" },
      }],
      "/repos/owner/repo/issues/7/comments?per_page=100": [],
      "/repos/owner/repo/issues/7/timeline?per_page=100": [{
        event: "cross-referenced", source: { issue: { number: 8, pull_request: {} } },
      }],
      "/repos/owner/repo/pulls/8": {
        number: 8, state: "closed", merged_at: new Date().toISOString(),
        user: { login: "Copilot" },
        head: { ref: "copilot/fix", repo: { full_name: "owner/repo" } },
        base: { ref: "main", repo: { full_name: "owner/repo" } },
      },
      "/repos/owner/repo": { default_branch: "main" },
    };
    assert.ok(path in replies, `unexpected request: ${path}`);
    return Response.json(replies[path]);
  };
  try {
    await main({
      CI_MODE: "reconcile", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
      CI_SCAN_SOURCES: "code-scanning", GITHUB_REPOSITORY_OWNER: "owner",
      CI_DRY_RUN: "false", APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]", COPILOT_AGENT_PAT: "human",
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/repos/owner/repo/issues/7/comments");
    assert.match(writes[0].body.body, /source\(s\) disabled: sonarcloud/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("trusted draft PR failures delegate once per SHA and escalate at the cap", async () => {
  const writes = [];
  const sha = "abcd";
  const prComments = [];
  const now = new Date().toISOString();
  const issue = {
    number: 7, body: '<!-- platform-devex-ci-batch-v1:{"alertIds":["code-scanning:1"]} -->',
    user: { login: "owner" }, created_at: now, state: "open", labels: [{ name: "platform-devex-ci" }],
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (init.method === "POST") {
      writes.push({ path, body: JSON.parse(init.body).body });
      return Response.json({});
    }
    const result = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [issue],
      "/repos/owner/repo/issues/7": issue,
      "/repos/owner/repo/issues/7/comments?per_page=100": [],
      "/repos/owner/repo/issues/7/timeline?per_page=100": [{
        event: "cross-referenced", source: { issue: { number: 8, pull_request: {} } },
      }],
      "/repos/owner/repo/pulls/8": {
        number: 8, state: "open", updated_at: now, draft: true,
        changed_files: 1, additions: 2, deletions: 1,
        user: { login: "copilot-swe-agent[bot]" },
        head: { sha, ref: "copilot/fix", repo: { full_name: "owner/repo" } },
        base: { ref: "main", repo: { full_name: "owner/repo" } },
      },
      "/repos/owner/repo": { default_branch: "main" },
      "/repos/owner/repo/issues/8/comments?per_page=100": prComments,
      "/repos/owner/repo/pulls/8/files?per_page=100": [{ filename: "src/a.js", additions: 2, deletions: 1 }],
      "/repos/owner/repo/compare/main...abcd": { behind_by: 0 },
      "/repos/owner/repo/commits/abcd/check-runs?per_page=100": {
        total_count: 1, check_runs: [{ status: "completed", conclusion: "failure" }],
      },
      "/repos/owner/repo/commits/abcd/status": { state: "pending", statuses: [] },
    };
    assert.ok(path in result, `unexpected request: ${path}`);
    return Response.json(result[path]);
  };
  const env = {
    CI_MODE: "reconcile", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
    GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: "false",
    APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]",
    COPILOT_AGENT_PAT: "human",
  };
  try {
    await main(env);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/repos/owner/repo/issues/8/comments");
    assert.match(writes[0].body, /<!-- devex-copilot-delegate --><!-- sha:abcd -->/);
    assertTestingInstructions(writes[0].body);
    prComments.push({ user: { login: "owner" }, body: writes[0].body });
    await main(env);
    assert.equal(writes.length, 1);
    prComments.splice(0, prComments.length, ...["one", "two", "three"].map((oldSha) => ({
      user: { login: "owner" }, body: `<!-- devex-copilot-delegate --><!-- sha:${oldSha} -->`,
    })));
    await main(env);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].path, "/repos/owner/repo/issues/7/comments");
    assert.match(writes[1].body, /human attention/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function mockImprovementPr() {
  const now = new Date().toISOString();
  const state = {
    pr: {
      number: 8, node_id: "PR_8", state: "open", updated_at: now, draft: true,
      mergeable_state: "blocked", changed_files: 1, additions: 2, deletions: 1,
      user: { login: "Copilot" },
      head: { sha: "abcd", ref: "copilot/fix", repo: { full_name: "owner/repo" } },
      base: { ref: "main", sha: "base", repo: { full_name: "owner/repo" } },
    },
    checks: { total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "skipped" }] },
    status: { state: "pending", statuses: [] },
    behindBy: 0,
    reviews: [],
    reviewRequestEvents: [],
    recordReviewRequest: true,
    reviewRequester: "owner",
    requestedReviewer: "copilot-pull-request-reviewer",
    threads: [],
    issueComments: [],
    prComments: [],
    workflowRuns: [],
    files: [{ filename: "src/a.js", additions: 2, deletions: 1, status: "modified",
      patch: "@@ -1 +1 @@\n-export const a=0;\n+export const a=1;" }],
    verificationCalls: 0,
    normalizationCalls: 0,
    verificationDecisions: {},
    coverageDecision: "verified",
    rules: [],
    rollupState: "SUCCESS",
    rollupPartial: false,
    sonarFindings: [],
    tree: [{ type: "blob", mode: "100644", path: "package.json" }],
    sourceFiles: {},
    sonarAnalysisDate: now,
    writes: [],
  };
  state.issue = {
    number: 7, state: "open", user: { login: "owner" }, created_at: now,
    labels: [{ name: "platform-devex-ci" }],
    body: '<!-- platform-devex-ci-batch-v1:{"alertIds":["code-scanning:1"]} -->',
  };
  state.report = {
    sha: "abcd", testPaths: ["src/a.test.js"],
    commands: [{ command: "node --test src/a.test.js", outcome: "passed", details: "1 test passed" }],
    layers: { unit: "Exact a behavior is asserted", integration: "No external boundary", playwright: "Backend-only" },
    threads: [],
  };
  const reportComment = { id: 1, user: { login: "Copilot" }, created_at: now,
    html_url: "https://github.com/owner/repo/pull/8#issuecomment-1", body: marker(EVIDENCE_TAG, state.report) };
  state.prComments.push(reportComment);
  state.pr.body = publishEvidenceBody("Refs #7", { report: state.report, comment: reportComment });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (new URL(url).origin === "https://sonarcloud.io") {
      if (path.startsWith("/api/components/show")) return Response.json({ component: {
        key: "owner_repo", qualifier: "TRK", organization: "owner", analysisDate: now,
      } });
      if (path.startsWith("/api/project_pull_requests/list")) {
        state.sonarMetadataCalls = (state.sonarMetadataCalls ?? 0) + 1;
        state.onSonarMetadata?.(state.sonarMetadataCalls);
        return Response.json({ pullRequests: [
          { key: "8", analysisDate: state.sonarAnalysisDate,
            commit: state.sonarCommit === undefined ? { sha: state.sonarAnalysisSha ?? state.pr.head.sha } : state.sonarCommit },
        ] });
      }
      if (path.startsWith("/api/issues/search")) {
        const page = Number(new URL(url).searchParams.get("p"));
        return Response.json({
          total: state.sonarTotal ?? state.sonarFindings.length,
          paging: { pageIndex: page, pageSize: 500 },
          issues: state.sonarFindings.slice((page - 1) * 500, page * 500),
        });
      }
      assert.fail(`unexpected Sonar endpoint: ${path}`);
    }
    if (init.method !== "GET") {
      const body = init.body ? JSON.parse(init.body) : null;
      if (path === "/graphql" && body.query.startsWith("query(")) {
        if (body.query.includes("statusCheckRollup")) return Response.json({ data: { repository: { pullRequest: {
          headRefOid: state.pr.head.sha, mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE",
          commits: { nodes: [{ commit: { oid: state.pr.head.sha, statusCheckRollup: {
            state: state.rollupState, contexts: { nodes: state.checks.check_runs.map((check) => ({
              __typename: "CheckRun", name: check.name, status: check.status.toUpperCase(),
              conclusion: check.conclusion?.toUpperCase(),
            })), pageInfo: { hasNextPage: state.rollupPartial } },
          } } }] },
        } } } });
        if (body.query.includes("timelineItems")) {
          return Response.json({ data: { repository: { pullRequest: {
            timelineItems: { nodes: state.reviewRequestEvents },
          } } } });
        }
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: {
          nodes: state.threads, pageInfo: { hasNextPage: false },
        } } } } });
      }
      state.writes.push({ method: init.method, path, body, token: init.headers.Authorization });
      if (path === "/repos/owner/repo/pulls/8/requested_reviewers" && state.recordReviewRequest &&
          init.headers.Authorization.split(" ").at(-1) === "human") {
        state.reviewRequestEvents.push({ id: `REVIEW_REQUEST_${state.writes.length}`,
          actor: { login: state.reviewRequester }, requestedReviewer: { login: state.requestedReviewer } });
      }
      if (path === "/graphql") {
        if (body.query.includes("markPullRequestReadyForReview")) {
          state.pr.draft = false;
          return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
        }
        if (body.query.includes("resolveReviewThread")) {
          const thread = state.threads.find((item) => item.id === body.variables.id);
          assert.ok(thread, "cannot resolve an unknown thread");
          thread.isResolved = true;
          return Response.json({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
        }
        assert.fail(`unexpected GraphQL mutation: ${body.query}`);
      }
      if (path === "/repos/owner/repo/pulls/8" && init.method === "PATCH") state.pr.body = body.body;
      if (path === "/repos/owner/repo/issues/7/comments") {
        state.issueComments.push({ id: 100 + state.writes.length, created_at: now,
          user: { login: "app[bot]" }, body: body.body });
      }
      if (path.startsWith("/repos/owner/repo/issues/comments/") && init.method === "PATCH") {
        const comment = state.issueComments.find((comment) => path.endsWith(`/${comment.id}`));
        comment.body = body.body;
        comment.updated_at = new Date().toISOString();
      }
      if (path === "/repos/owner/repo/issues/8/comments") {
        state.prComments.push({ id: 200 + state.writes.length, created_at: now,
          user: { login: init.headers.Authorization.endsWith("human") ? "owner" : "app[bot]" }, body: body.body });
      }
      const rerun = path.match(/^\/repos\/owner\/repo\/actions\/runs\/(\d+)\/rerun$/);
      if (rerun) {
        const workflow = state.workflowRuns.find((run) => run.id === Number(rerun[1]));
        assert.ok(workflow, "cannot rerun an unknown workflow");
        workflow.status = "queued";
        workflow.conclusion = null;
        workflow.run_attempt++;
        return new Response(null, { status: 201 });
      }
      return Response.json({});
    }
    if (path.startsWith("/repos/owner/repo/contents/")) {
      const request = new URL(url);
      const filename = decodeURIComponent(request.pathname.split("/contents/")[1]);
      const text = state.sourceFiles[`${request.searchParams.get("ref")}:${filename}`] ??
        state.sourceFiles[filename] ?? "discovered source and focused assertions";
      return Response.json({ type: "file", encoding: "base64", size: Buffer.byteLength(text),
        content: Buffer.from(text).toString("base64") });
    }
    const replies = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [state.issue],
      "/repos/owner/repo/issues/7": state.issue,
      "/repos/owner/repo/issues/7/comments?per_page=100": state.issueComments,
      "/repos/owner/repo/issues/7/timeline?per_page=100": [{
        event: "cross-referenced", source: { issue: { number: 8, pull_request: {} } },
      }],
      "/repos/owner/repo/pulls/8": state.pr,
      "/repos/owner/repo": { default_branch: "main" },
      "/repos/owner/repo/issues/8/comments?per_page=100": state.prComments,
      "/repos/owner/repo/pulls/8/files?per_page=100": state.files,
      [`/repos/owner/repo/compare/main...${state.pr.head.sha}`]: { behind_by: state.behindBy },
      [`/repos/owner/repo/commits/${state.pr.head.sha}/check-runs?per_page=100`]: state.checks,
      [`/repos/owner/repo/commits/${state.pr.head.sha}/status`]: state.status,
      [`/repos/owner/repo/commits/${state.pr.head.sha}`]: {
        sha: state.pr.head.sha,
        commit: { committer: { date: new Date(Date.parse(now) - 60_000).toISOString() } },
      },
      "/repos/owner/repo/commits/main": { sha: state.pr.head.sha,
        commit: { committer: { date: new Date(Date.parse(now) - 60_000).toISOString() } } },
      "/repos/owner/repo/code-scanning/alerts?state=open&per_page=100": [],
      "/repos/owner/repo/dependabot/alerts?state=open&per_page=100": [],
      "/repos/owner/repo/pulls/8/reviews?per_page=100": state.reviews.map((review, index) => ({ id: index + 1, ...review })),
      [`/repos/owner/repo/git/trees/${state.pr.head.sha}?recursive=1`]: {
        truncated: false, tree: state.tree,
      },
      "/repos/owner/repo/git/trees/base?recursive=1": { truncated: false, tree: state.baseTree ?? state.tree },
      "/repos/owner/repo/rules/branches/main": state.rules,
      [`/repos/owner/repo/actions/runs?event=pull_request&head_sha=${state.pr.head.sha}&per_page=100`]: {
        total_count: state.workflowRuns.length, workflow_runs: state.workflowRuns,
      },
    };
    for (const workflow of state.workflowRuns) replies[`/repos/owner/repo/actions/runs/${workflow.id}`] = workflow;
    assert.ok(path in replies, `unexpected request: ${path}`);
    return Response.json(replies[path]);
  };
  const run = (dryRun = "false", mode = "reconcile") => main({
    CI_MODE: mode, CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
    GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: dryRun,
    APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]", COPILOT_AGENT_PAT: "human",
  }, {
    verifyThreads: async (context) => {
      state.verificationCalls++;
      state.onVerify?.(context);
      return { coverage: { decision: state.coverageDecision, reason: "Specific focused assertions and execution" },
        threads: context.threads.map((thread) => ({ id: thread.id,
          decision: state.verificationDecisions[thread.id] ?? "fix", reason: "Specific current-source proof or remaining defect" })) };
    },
    normalizeEvidence: async (comment) => {
      state.normalizationCalls++;
      return { report: state.report, comment };
    },
  });
  return { state, run, restore: () => { globalThis.fetch = previousFetch; } };
}

function greenReviewed(state) {
  state.pr.draft = false;
  state.pr.mergeable_state = "clean";
  state.checks.check_runs[0].conclusion = "success";
  state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: state.pr.head.sha, state: "COMMENTED" });
}

function cancelledValidation(state) {
  state.pr.draft = false;
  state.checks = { total_count: 1, check_runs: [{
    name: "build", status: "completed", conclusion: "cancelled",
    app: { slug: "github-actions" }, check_suite: { id: 55 },
  }] };
  state.workflowRuns = [{
    id: 10, workflow_id: 100, check_suite_id: 55, event: "pull_request",
    head_sha: "abcd", pull_requests: [{ number: 8 }], created_at: "2026-10-02T10:25:00Z",
    status: "completed", conclusion: "cancelled", run_attempt: 2,
    triggering_actor: { login: "app[bot]" },
  }];
}

test("each cancelled workflow is retried once despite having multiple cancelled jobs", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    cancelledValidation(state);
    state.checks.check_runs.push({ ...state.checks.check_runs[0], name: "integration" });
    state.workflowRuns.push({ ...state.workflowRuns[0], id: 11, workflow_id: 200, check_suite_id: 56 });
    state.checks.check_runs.push({ ...state.checks.check_runs[0], name: "quality", check_suite: { id: 56 } });
    await run();
    assert.deepEqual(state.writes.filter((write) => write.path.endsWith("/rerun")).map((write) => write.path), [
      "/repos/owner/repo/actions/runs/10/rerun", "/repos/owner/repo/actions/runs/11/rerun",
    ]);
  } finally {
    restore();
  }
});

test("cancelled validation cannot bypass risk review or retry runs released by another identity", async () => {
  for (const untrusted of ["initial", "foreign"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      cancelledValidation(state);
      if (untrusted === "initial") state.workflowRuns[0].run_attempt = 1;
      else state.workflowRuns[0].triggering_actor.login = "other-bot[bot]";
      await run();
      assert.equal(state.writes.length, 1);
      assert.match(state.writes[0].body.body, /not previously released by the trusted App/);
    } finally {
      restore();
    }
  }
});

test("human PRs, forks and sensitive changes cannot enter workflow recovery", async () => {
  for (const untrusted of ["human", "fork", "sensitive"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      cancelledValidation(state);
      if (untrusted === "human") state.pr.user.login = "owner";
      if (untrusted === "fork") state.pr.head.repo.full_name = "contributor/repo";
      if (untrusted === "sensitive") state.files[0].filename = ".github/workflows/test.yml";
      await run();
      assert.equal(state.writes.some((write) => write.path.endsWith("/rerun")), false);
      assert.equal(state.writes.some((write) => write.body?.body?.includes("@copilot")), false);
    } finally {
      restore();
    }
  }
});

test("obsolete cancellations wait for newer pending approval and never rerun the old event", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    cancelledValidation(state);
    state.workflowRuns.push({
      ...state.workflowRuns[0], id: 11, check_suite_id: 56,
      conclusion: "action_required", created_at: "2026-10-02T11:00:00Z",
    });
    await run();
    assert.equal(state.writes.length, 0);
  } finally {
    restore();
  }
});

test("obsolete cancelled contexts do not block successful newer validation but cannot fake passing checks", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    cancelledValidation(state);
    state.workflowRuns.push({
      ...state.workflowRuns[0], id: 11, check_suite_id: 56,
      conclusion: "success", created_at: "2026-10-02T11:00:00Z",
    });
    await run();
    assert.equal(state.writes.length, 0, "no real passing check is present yet");
    state.checks.check_runs.push({ name: "validation", status: "completed", conclusion: "success" });
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    state.pr.mergeable_state = "clean";
    await run();
    assert.equal(state.writes.length, 2);
    assert.match(state.writes.at(-1).body.body, /ready for \*\*human\*\* review and merge/);
  } finally {
    restore();
  }
});

test("cancelled validation reruns the latest event using the App, never an obsolete draft or Copilot mention", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    cancelledValidation(state);
    state.workflowRuns.push({
      ...state.workflowRuns[0], id: 9, check_suite_id: 54,
      created_at: "2026-10-02T08:56:00Z", conclusion: "action_required",
    });
    await run("true");
    assert.equal(state.writes.length, 0);
    await run();
    assert.deepEqual(state.writes.map((write) => `${write.method} ${write.path}`), [
      "POST /repos/owner/repo/issues/7/comments",
      "POST /repos/owner/repo/actions/runs/10/rerun",
    ]);
    assert.match(state.writes[0].body.body, /platform-devex-ci-rerun:10:abcd:2/);
    assert.equal(state.writes[1].token, "Bearer app");
    assert.equal(state.writes.some((write) => write.body?.body?.includes("@copilot")), false);
    await run();
    assert.equal(state.writes.length, 2, "a queued retry must not be retried again");
    state.checks.check_runs[0].conclusion = "success";
    state.workflowRuns[0].status = "completed";
    state.workflowRuns[0].conclusion = "success";
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    state.pr.mergeable_state = "clean";
    await run();
    assert.match(state.writes.at(-1).body.body, /ready for \*\*human\*\* review and merge/);
  } finally {
    restore();
  }
});

test("cancelled workflows have two automatic retries then escalate without a code-change request", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    cancelledValidation(state);
    await run();
    state.workflowRuns[0].status = "completed";
    state.workflowRuns[0].conclusion = "cancelled";
    await run();
    state.workflowRuns[0].status = "completed";
    state.workflowRuns[0].conclusion = "cancelled";
    await run();
    assert.equal(state.writes.filter((write) => write.path.endsWith("/rerun")).length, 2);
    assert.match(state.writes.at(-1).body.body, /bounded retry budget/);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("@copilot")), false);
  } finally {
    restore();
  }
});

test("foreign retry markers cannot exhaust the workflow recovery budget", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    cancelledValidation(state);
    state.issueComments.push(...[1, 2].map((attempt) => ({
      user: { login: "other-bot[bot]" }, body: `<!-- platform-devex-ci-rerun:10:abcd:${attempt} -->`,
    })));
    await run();
    assert.equal(state.writes.filter((write) => write.path.endsWith("/rerun")).length, 1);
  } finally {
    restore();
  }
});

test("newer workflow events and PR changes during recovery prevent stale retries", async () => {
  for (const change of ["head", "workflow", "attempt"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      cancelledValidation(state);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const path = new URL(url).pathname;
        if (path === "/repos/owner/repo/actions/runs/10") {
          if (change === "head") state.pr.head.sha = "new-head";
          if (change === "workflow") state.workflowRuns.push({
            ...state.workflowRuns[0], id: 11, created_at: "2026-10-02T11:00:00Z",
          });
          if (change === "attempt") state.workflowRuns[0].run_attempt++;
        }
        if (path === "/repos/owner/repo/actions/runs" && change === "head") {
          return Response.json({ total_count: 1, workflow_runs: state.workflowRuns });
        }
        return originalFetch(url, init);
      };
      await run();
      assert.equal(state.writes.length, 0, `must not retry after ${change} changes`);
    } finally {
      restore();
    }
  }
});

test("workflow recovery reads every canonical API page and rejects foreign pagination", async () => {
  for (const foreign of [false, true]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      cancelledValidation(state);
      const latest = state.workflowRuns[0];
      const older = { ...latest, id: 9, check_suite_id: 54, created_at: "2026-10-02T08:56:00Z" };
      const originalFetch = globalThis.fetch;
      let pages = 0;
      globalThis.fetch = async (url, init) => {
        const path = new URL(url).pathname;
        if (path === "/repos/owner/repo/actions/runs") {
          pages++;
          return Response.json({ total_count: 2, workflow_runs: [older] }, { headers: {
            link: `<${foreign ? "https://foreign.example" : "https://api.github.com"}/repositories/99/actions/runs?page=2>; rel="next"`,
          } });
        }
        if (path === "/repositories/99/actions/runs") {
          pages++;
          return Response.json({ total_count: 2, workflow_runs: [latest] });
        }
        return originalFetch(url, init);
      };
      if (foreign) {
        await assert.rejects(run(), /Unexpected GitHub pagination URL/);
        assert.equal(state.writes.length, 0);
      } else {
        await run();
        assert.equal(pages, 4);
        assert.equal(state.writes.filter((write) => write.path.endsWith("/rerun")).length, 1);
      }
    } finally {
      restore();
    }
  }
});

test("incomplete workflow history and retry API failures are explicit, never safe fallbacks", async () => {
  for (const failure of ["paging", "rerun"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      cancelledValidation(state);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const path = new URL(url).pathname;
        if (path === "/repos/owner/repo/actions/runs" && failure === "paging") {
          return Response.json({ total_count: 2, workflow_runs: state.workflowRuns });
        }
        if (path.endsWith("/rerun") && failure === "rerun") return new Response("", { status: 403 });
        return originalFetch(url, init);
      };
      await assert.rejects(run(), failure === "paging" ? /Incomplete/ : /HTTP 403/);
      assert.equal(state.writes.some((write) => write.body?.body?.includes("@copilot")), false);
      if (failure === "rerun") {
        await run();
        assert.match(state.writes.at(-1).body.body, /bounded retry budget/);
      }
    } finally {
      restore();
    }
  }
});

test("trusted draft becomes ready, skipped-only checks cannot pass, and handoff waits for green checks and review", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    await run("true");
    assert.equal(state.writes.length, 0);
    assert.equal(state.pr.draft, true);
    await run();
    assert.equal(state.writes[0].path, "/graphql");
    assert.equal(state.writes[0].token, "Bearer human");
    assert.equal(state.writes[0].body.variables.id, "PR_8");
    await run();
    assert.equal(state.writes.length, 1);
    state.checks = { total_count: 2, check_runs: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "optional", status: "completed", conclusion: "skipped" },
    ] };
    await run();
    assert.equal(state.writes[1].path, "/repos/owner/repo/pulls/8/requested_reviewers");
    assert.equal(state.writes[1].token.split(" ").at(-1), "human");
    assert.deepEqual(state.writes[1].body.reviewers, ["copilot-pull-request-reviewer[bot]"]);
    assert.equal(state.writes[2].path, "/repos/owner/repo/issues/7/comments");
    assert.match(state.writes[2].body.body, /platform-devex-ci-human-review:abcd/);
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    await run();
    assert.equal(state.writes.length, 4);
    assert.equal(state.verificationCalls, 1);
    state.pr.mergeable_state = "clean";
    await run();
    assert.equal(state.writes[4].path, "/repos/owner/repo/issues/7/comments");
    assert.match(state.writes[4].body.body, /ready for \*\*human\*\* review and merge/);
    assert.match(state.writes[4].body.body, /Passing checks: build/);
    assert.doesNotMatch(state.writes[4].body.body, /optional/);
    await run();
    assert.equal(state.writes.length, 5);
    assert.equal(state.verificationCalls, 1);
  } finally {
    restore();
  }
});

test("verified human reviews ignore legacy App markers and deduplicate only the same head", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    state.pr.draft = false;
    state.checks.check_runs[0].conclusion = "success";
    state.issueComments.push({ user: { login: "app[bot]" },
      body: "<!-- platform-devex-ci-review:abcd -->" });
    await run("true");
    assert.equal(state.writes.length, 0);
    await run();
    assert.equal(state.writes.length, 2);
    assert.equal(state.reviewRequestEvents.length, 1);
    await run();
    assert.equal(state.writes.length, 2);
    state.pr.head.sha = "new";
    await run();
    assert.equal(state.writes.length, 4);
    assert.match(state.writes[3].body.body, /platform-devex-ci-human-review:new/);
  } finally {
    restore();
  }
});

test("a successful but ignored review request is never recorded, including with an older matching event", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    state.pr.draft = false;
    state.checks.check_runs[0].conclusion = "success";
    state.recordReviewRequest = false;
    state.reviewRequestEvents.push({ id: "OLD_REQUEST", actor: { login: "owner" },
      requestedReviewer: { login: "copilot-pull-request-reviewer" } });
    await assert.rejects(run(), /did not record a new human-authored Copilot review request/);
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].path, "/repos/owner/repo/pulls/8/requested_reviewers");
    assert.equal(state.issueComments.length, 0);
  } finally {
    restore();
  }
});

test("unrelated actors and reviewers cannot confirm a Copilot review request", async () => {
  for (const mismatch of ["reviewRequester", "requestedReviewer"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      state.pr.draft = false;
      state.checks.check_runs[0].conclusion = "success";
      state[mismatch] = "other";
      await assert.rejects(run(), /did not record a new human-authored Copilot review request/);
      assert.equal(state.writes.length, 1);
      assert.equal(state.issueComments.length, 0);
    } finally {
      restore();
    }
  }
});

test("review-request verification errors and API failures cannot write success markers", async () => {
  for (const failure of ["graphql", "malformed", "request", "verification"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      state.pr.draft = false;
      state.checks.check_runs[0].conclusion = "success";
      const originalFetch = globalThis.fetch;
      let eventReads = 0;
      globalThis.fetch = async (url, init) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/requested_reviewers") && failure === "request") {
          return new Response(null, { status: 403 });
        }
        if (path === "/graphql" && JSON.parse(init.body).query.includes("timelineItems")) {
          eventReads++;
          if (failure === "graphql" || (failure === "verification" && eventReads === 2)) {
            return Response.json({ errors: [{ message: "Cannot read events" }] });
          }
          if (failure === "malformed") return Response.json({ data: { repository: null } });
        }
        return originalFetch(url, init);
      };
      await assert.rejects(run(), failure === "request" ? /HTTP 403/ : /cannot verify Copilot review request events/);
      assert.equal(state.issueComments.length, 0);
      assert.equal(state.writes.some((write) => write.path.endsWith("/comments")), false);
    } finally {
      restore();
    }
  }
});

test("behind branch is updated before readiness, and base changes before handoff prevent a stale handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    state.behindBy = 1;
    await run();
    assert.equal(state.writes[0].method, "PUT");
    assert.equal(state.writes[0].path, "/repos/owner/repo/pulls/8/update-branch");
    assert.equal(state.writes[0].body.expected_head_sha, "abcd");
    assert.equal(state.writes[0].token, "Bearer human");
    state.behindBy = 0;
    await run();
    assert.equal(state.writes[1].path, "/graphql");
    state.checks.check_runs[0].conclusion = "success";
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    state.pr.mergeable_state = "clean";
    let comparisons = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (new URL(url).pathname.includes("/compare/")) {
        comparisons++;
        return Response.json({ behind_by: comparisons === 1 ? 0 : 1 });
      }
      return originalFetch(url, init);
    };
    await run();
    assert.equal(comparisons, 2);
    assert.equal(state.writes.at(-1).path, "/repos/owner/repo/pulls/8/update-branch");
    assert.equal(state.writes.some((write) => write.body.body?.includes("platform-devex-ci-ready:")), false);
  } finally {
    restore();
  }
});

test("Copilot changes-requested review without inline findings escalates instead of handing off", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    state.pr.draft = false;
    state.checks.check_runs[0].conclusion = "success";
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "CHANGES_REQUESTED" });
    await run();
    assert.equal(state.writes.length, 1);
    assert.match(state.writes[0].body.body, /needs human attention/);
    assert.doesNotMatch(state.writes[0].body.body, /platform-devex-ci-ready:/);
  } finally {
    restore();
  }
});

test("Copilot issue-reference finding is fixed and resolved before the human handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    state.pr.draft = false;
    state.pr.body = state.pr.body.replace("Refs #7", "Fixes #7");
    state.pr.mergeable_state = "blocked";
    state.checks.check_runs[0].conclusion = "success";
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    state.threads.push({ id: "THREAD_1", isResolved: false, comments: {
      pageInfo: { hasNextPage: false },
      nodes: [{ author: { login: "copilot-pull-request-reviewer" }, commit: { oid: "abcd" },
        body: "The linked issue requires referencing #7 without an auto-closing keyword, but the PR description uses `Fixes #7`." }],
    } });
    await run();
    const patch = state.writes.find((write) => write.method === "PATCH");
    assert.equal(patch.path, "/repos/owner/repo/pulls/8");
    assert.equal(patch.token, "Bearer app");
    assert.match(state.pr.body, /^Refs #7/);
    await run();
    assert.equal(state.threads[0].isResolved, false, "a fresh review is required after description repair");
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    await run();
    const resolution = state.writes.find((write) => write.body?.query?.includes("resolveReviewThread"));
    assert.equal(resolution.body.variables.id, "THREAD_1");
    assert.equal(resolution.token, "Bearer human");
    assert.equal(state.threads[0].isResolved, true);
    state.pr.mergeable_state = "clean";
    await run();
    assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-ready:")), false);
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    await run();
    assert.match(state.writes.at(-1).body.body, /platform-devex-ci-ready:abcd/);
  } finally {
    restore();
  }
});

test("unresolved Copilot review threads delegate instead of handing off", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    state.pr.draft = false;
    state.pr.mergeable_state = "clean";
    state.checks.check_runs[0].conclusion = "success";
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    state.threads.push({ id: "THREAD_2", isResolved: false, comments: {
      pageInfo: { hasNextPage: false },
      nodes: [{ author: { login: "Copilot" }, commit: { oid: "abcd" }, body: "Please fix this bug." }],
    } });
    await run();
    assert.equal(state.writes.length, 2);
    assert.equal(state.writes[1].path, "/repos/owner/repo/issues/8/comments");
    assert.equal(state.writes[1].token, "Bearer human");
    assert.match(state.writes[1].body.body, /@copilot please address/);
    assert.match(state.writes[1].body.body, /Thread THREAD_2/);
    assertTestingInstructions(state.writes[1].body.body);
  } finally {
    restore();
  }
});

test("a new head during reconciliation cannot receive a stale human handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    state.pr.draft = false;
    state.pr.mergeable_state = "clean";
    state.checks.check_runs[0].conclusion = "success";
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    const originalFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (url, init) => {
      if (new URL(url).pathname === "/repos/owner/repo/pulls/8" && ++reads === 2) {
        return Promise.resolve(Response.json({ ...state.pr, head: { ...state.pr.head, sha: "new" } }));
      }
      return originalFetch(url, init);
    };
    await run();
    assert.equal(reads, 2);
    assert.equal(state.writes.length, 0);
  } finally {
    restore();
  }
});

test("a PR already handed off does not escalate just because a human has not yet reviewed it", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    state.pr.draft = false;
    state.pr.mergeable_state = "clean";
    state.checks.check_runs[0].conclusion = "success";
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    await run();
    state.writes.length = 0;
    state.pr.updated_at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await run();
    assert.equal(state.writes.length, 0);
  } finally {
    restore();
  }
});

function addThread(state, id, author = "copilot-pull-request-reviewer", commit = "old") {
  state.threads.push({ id, isResolved: false, isOutdated: true, path: "src/a.js", comments: {
    pageInfo: { hasNextPage: false }, nodes: [{ author: { login: author }, commit: { oid: commit },
      body: "Specific original code/evidence finding", updatedAt: "2026-10-03T10:00:00Z" }],
  } });
}

test("affirmatively verified old-head/outdated conversations resolve outside exhausted code budgets, followed by a fresh same-head review", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    addThread(state, "OLD");
    state.verificationDecisions.OLD = "resolve";
    state.prComments.push(...["one", "two"].map((sha) => ({ user: { login: "owner" },
      body: `<!-- platform-devex-ci-fix:${sha} -->` })));
    await run();
    assert.equal(state.threads[0].isResolved, true);
    assert.equal(state.writes.filter((write) => write.body?.body?.includes("@copilot")).length, 0);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("needs human attention")), false);
    assert.equal(state.writes.find((write) => write.body?.query?.includes("resolveReviewThread")).token.split(" ").at(-1), "human");
    await run();
    assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-ready:")), false);
    const requests = state.writes.filter((write) => write.path.endsWith("/requested_reviewers"));
    assert.equal(requests.length, 1);
    await run();
    assert.equal(state.writes.filter((write) => write.path.endsWith("/requested_reviewers")).length, 1);
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "abcd", state: "COMMENTED" });
    await run();
    assert.match(state.writes.at(-1).body.body, /ready for \*\*human\*\*/);
  } finally { restore(); }
});

test("human/mixed conversations and new threads appearing before handoff are never auto-resolved or ignored", async () => {
  for (const mixed of [false, true]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      greenReviewed(state);
      addThread(state, "HUMAN", mixed ? "copilot-pull-request-reviewer" : "owner");
      if (mixed) state.threads[0].comments.nodes.push({ author: { login: "owner" }, body: "Still reviewing" });
      await run();
      assert.equal(state.writes.length, 0);
      assert.equal(state.verificationCalls, 0);
    } finally { restore(); }
  }
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.onVerify = () => addThread(state, "NEW", "owner");
    await run();
    assert.equal(state.writes.length, 0, "stale verification cannot reserve or hand off");
  } finally { restore(); }
});

test("authenticated coding-agent replies do not turn a Copilot reviewer conversation into a human conversation", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    addThread(state, "REPLIED");
    state.threads[0].comments.nodes.push({ author: { login: "copilot-swe-agent" },
      body: "Added the specific regression; verify the current implementation." });
    state.verificationDecisions.REPLIED = "resolve";
    await run();
    assert.equal(state.verificationCalls, 1);
    assert.equal(state.threads[0].isResolved, true);
  } finally { restore(); }
});

test("evidence publication preserves the human description and makes older same-head reviews ineligible", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.pr.body = "Preserve this human summary\nRefs #7";
    await run();
    assert.match(state.pr.body, /^Preserve this human summary/);
    assert.match(state.pr.body, /node --test src\/a.test.js/);
    assert.equal(state.verificationCalls, 0);
    await run();
    assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-ready:")), false);
    assert.equal(state.writes.filter((write) => write.path.endsWith("/requested_reviewers")).length, 1);
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "abcd", state: "COMMENTED" });
    await run();
    assert.match(state.writes.at(-1).body.body, /ready for \*\*human\*\*/);
  } finally { restore(); }
});

test("missing/malformed current evidence gets one bounded metadata request, not a code repair", async () => {
  for (const malformed of [false, true]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      greenReviewed(state);
      state.prComments = malformed ? [{ user: { login: "Copilot" }, body: marker(EVIDENCE_TAG, {
        sha: "abcd", commands: [null],
      }) }] : [];
      await run();
      await run();
      assert.equal(state.writes.length, 1);
      assert.match(state.writes[0].body.body, /platform-devex-ci-evidence-request:abcd/);
      assert.doesNotMatch(state.writes[0].body.body, /platform-devex-ci-fix:/);
      assert.equal(state.verificationCalls, 0);
    } finally { restore(); }
  }
});

test("changed heads, reports, body evidence and final validation discard decisions instead of posting stale success", async () => {
  for (const change of ["head", "report", "body", "issue", "task", "checks"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      greenReviewed(state);
      state.onVerify = () => {
        if (change === "head") state.pr.head.sha = "new";
        if (change === "report") state.prComments[0].body = "Execution evidence corrected during analysis";
        if (change === "body") state.pr.body = "Evidence removed during analysis";
        if (change === "issue") state.issue.state = "closed";
        if (change === "task") state.issue.body += "\nChanged owner requirements during analysis";
        if (change === "checks") state.checks.check_runs[0].conclusion = "failure";
      };
      await run();
      assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-ready:")), false);
      assert.equal(state.writes.some((write) => write.body?.query?.includes("resolveReviewThread")), false);
    } finally { restore(); }
  }
});

test("coverage gaps are bounded code repairs even without inline comments; uncertain proof escalates", async () => {
  for (const decision of ["fix", "human"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      greenReviewed(state);
      state.coverageDecision = decision;
      await run();
      assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-ready:")), false);
      assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-fix:")), decision === "fix");
      assert.equal(state.writes.some((write) => write.body?.body?.includes("needs human attention")), decision === "human");
    } finally { restore(); }
  }
});

test("UNSTABLE requires complete successful native roll-up and exact effective required check/App policies", async () => {
  for (const failure of ["none", "required", "app", "pending", "partial", "unknown-policy"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      greenReviewed(state);
      state.pr.mergeable_state = "unstable";
      state.pr.mergeable = true;
      state.checks.check_runs[0].app = { id: 15368 };
      state.rules = [{ type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "build", integration_id: 15368 }] } }];
      if (failure === "required") state.rules[0].parameters.required_status_checks[0].context = "missing-required";
      if (failure === "app") state.rules[0].parameters.required_status_checks[0].integration_id = 999;
      if (failure === "pending") state.rollupState = "PENDING";
      if (failure === "partial") state.rollupPartial = true;
      if (failure === "unknown-policy") state.rules.push({ type: "unknown-new-protection" });
      await run();
      assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-ready:")), failure === "none");
    } finally { restore(); }
  }
});

test("only a subsequent exact owner resume supersedes that escalation, without removing history or resetting budgets", () => {
  const escalation = { id: 10, user: { login: "app[bot]" }, body: "<!-- platform-devex-ci-escalated -->" };
  const resume = { user: { login: "owner" }, body: "<!-- platform-devex-ci-resume:10 -->\nAuthorized after bounded repair" };
  assert.equal(activeEscalation([escalation, resume], "app[bot]", "owner"), null);
  assert.equal(activeEscalation([resume, escalation], "app[bot]", "owner"), escalation);
  assert.equal(activeEscalation([escalation, { ...resume, user: { login: "attacker" } }], "app[bot]", "owner"), escalation);
  const next = { ...escalation, id: 11 };
  assert.equal(activeEscalation([escalation, resume, next], "app[bot]", "owner"), next);
});

test("existing differently shaped agent JSON is normalized once, published and reused only for its authenticated source", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.pr.body = "Human summary\nRefs #7";
    state.prComments = [{ id: 4, user: { login: "Copilot" }, body: JSON.stringify({
      commit_sha: "abcd", tests: [{ path: "src/a.test.js", command: state.report.commands[0].command,
        result: state.report.commands[0].details }],
    }) }];
    await run();
    assert.equal(state.normalizationCalls, 1);
    assert.match(state.pr.body, /Source:\*\* trusted comment 4/);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-evidence-request:")), false);
    await run();
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "abcd", state: "COMMENTED" });
    await run();
    assert.equal(state.normalizationCalls, 1);
    assert.match(state.writes.at(-1).body.body, /ready for \*\*human\*\*/);
  } finally { restore(); }
});

test("known structured agent reports bypass probabilistic normalization while preserving exact execution claims", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.pr.body = "Human summary\nRefs #7";
    state.prComments = [{ id: 4, user: { login: "Copilot" }, body: JSON.stringify({
      commit_sha: "abcd", tests: [{ path: "src/a.test.js", command: state.report.commands[0].command,
        result: "PASS: 1 passed, 0 failed" }], coverage: state.report.layers,
    }) }];
    await run();
    assert.equal(state.normalizationCalls, 0);
    assert.match(state.pr.body, /PASS: 1 passed, 0 failed/);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-evidence-request:")), false);
  } finally { restore(); }
});

test("a known report wrapped in the canonical marker is published without redundant metadata requests or SDK normalization", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.pr.body = "Human summary\nRefs #7";
    state.prComments = [{ id: 4, user: { login: "Copilot" }, body: marker(EVIDENCE_TAG, {
      sha: "abcd", commit_sha: "abcd", testPaths: ["src/a.test.js"],
      tests: [{ path: "src", command: state.report.commands[0].command, result: "passed: 1 test, 0 failed" }],
      coverage: state.report.layers,
    }) }];
    await run();
    assert.equal(state.normalizationCalls, 0);
    assert.match(state.pr.body, /passed: 1 test, 0 failed/);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-evidence-request:")), false);
    assert.equal(state.verificationCalls, 0);
  } finally { restore(); }
});

function sonarInfo() {
  return { key: "new-info", project: "owner_repo", component: "owner_repo:src/a.test.js",
    type: "CODE_SMELL", rule: "external_roslyn:IDE0058", severity: "INFO", line: 2,
    message: "Expression value is never used" };
}

test("a green quality gate with one new INFO finding cannot reach review or human handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.sonarFindings = [sonarInfo()];
    await run();
    assert.equal(state.verificationCalls, 0);
    assert.equal(state.writes.length, 1);
    assert.match(state.writes[0].body.body, /Zero blocking new SonarCloud findings/);
    assert.match(state.writes[0].body.body, /external_roslyn:IDE0058/);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("platform-devex-ci-ready:")), false);
  } finally { restore(); }
});

test("new Sonar findings withdraw the previous handoff and exhausted code budgets escalate, never reset", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.sonarFindings = [sonarInfo()];
    state.issueComments.push({ id: 77, user: { login: "app[bot]" },
      body: "<!-- platform-devex-ci-ready:abcd -->\nPrevious ready handoff" });
    state.prComments.push(...["one", "two"].map((sha) => ({ user: { login: "owner" },
      body: `<!-- platform-devex-ci-fix:${sha} -->` })));
    await run();
    assert.match(state.issueComments[0].body, /^<!-- platform-devex-ci-handoff-withdrawn -->/);
    assert.match(state.issueComments[0].body, /Previous ready handoff/);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("@copilot")), false);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("needs human attention")), true);
  } finally { restore(); }
});

test("stale/incomplete Sonar PR analysis fails explicitly and withdraws misleading existing handoff", async () => {
  for (const failure of ["stale", "partial"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      greenReviewed(state);
      state.issueComments.push({ id: 77, user: { login: "app[bot]" }, body: "<!-- platform-devex-ci-ready:abcd -->" });
      if (failure === "stale") state.sonarAnalysisSha = "old";
      else { state.sonarFindings = [sonarInfo()]; state.sonarTotal = 2; }
      await assert.rejects(run(), failure === "stale" ? /does not match the current head/ : /incomplete or invalid/);
      assert.equal(state.verificationCalls, 0);
      assert.match(state.issueComments[0].body, /handoff-withdrawn/);
    } finally { restore(); }
  }
});

test("new Sonar findings appearing during coverage verification prevent a stale final handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.onVerify = () => state.sonarFindings.push(sonarInfo());
    await run();
    assert.equal(state.verificationCalls, 1);
    assert.equal(state.writes.some((write) => write.body?.body?.startsWith("<!-- platform-devex-ci-ready:")), false);
  } finally { restore(); }
});

test("quality dry-runs remain read-only even with findings and an existing handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.sonarFindings = [sonarInfo()];
    state.issueComments.push({ id: 77, user: { login: "app[bot]" }, body: "<!-- platform-devex-ci-ready:abcd -->" });
    await run("true");
    assert.equal(state.writes.length, 0);
  } finally { restore(); }
});

test("legacy handoffs are withdrawn before waiting for pending checks under the versioned quality policy", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.checks.check_runs[0].status = "in_progress";
    state.checks.check_runs[0].conclusion = null;
    state.issueComments.push({ id: 77, user: { login: "app[bot]" },
      body: "<!-- platform-devex-ci-ready:abcd -->\nPreviously ready" });
    await run();
    assert.match(state.issueComments[0].body, /^<!-- platform-devex-ci-handoff-withdrawn -->/);
    assert.match(state.issueComments[0].body, /current versioned Sonar policy/);
    assert.equal(state.writes.length, 1);
    assert.equal(state.sonarMetadataCalls, undefined);
  } finally { restore(); }
});

test("missing exact Sonar commit metadata fails closed instead of trusting a fresh analysis date", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.sonarCommit = null;
    await assert.rejects(run(), /current SonarCloud PR analysis is unavailable/);
    assert.equal(state.writes.length, 0);
    assert.equal(state.verificationCalls, 0);
  } finally { restore(); }
});

test("analyzer/build suppression configurations are gated even when the diff fits the size budget", () => {
  for (const filename of [".editorconfig", "src/settings.ruleset", "sonar-project.properties",
    "Directory.Build.props", "src/Directory.Build.targets", "scripts/sonar-policy.mjs"]) {
    assert.match(diffRisk({ changed_files: 1, additions: 1, deletions: 1 },
      [{ filename, additions: 1, deletions: 1 }]), /gated path/);
  }
});

test("no-code resolve/re-review cycles are bounded independently of code-fix attempts", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.reviews = [];
    state.issueComments.push(...Array.from({ length: 4 }, (_, index) => ({
      user: { login: "app[bot]" }, body: `<!-- platform-devex-ci-human-review:abcd:cycle-${index} -->`,
    })));
    await run();
    assert.equal(state.writes.some((write) => write.path.endsWith("/requested_reviewers")), false);
    assert.match(state.writes.at(-1).body.body, /exhausted 4 verified review requests/);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("@copilot")), false);
  } finally { restore(); }
});

test("review budgets ignore other authors and heads and still permit the fourth verified request", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.reviews = [];
    state.issueComments.push(...Array.from({ length: 3 }, (_, index) => ({
      user: { login: "app[bot]" }, body: `<!-- platform-devex-ci-human-review:abcd:cycle-${index} -->`,
    })), ...Array.from({ length: 4 }, (_, index) => ({
      user: { login: "attacker" }, body: `<!-- platform-devex-ci-human-review:abcd:forged-${index} -->`,
    })), { user: { login: "app[bot]" }, body: "<!-- platform-devex-ci-human-review:old -->" });
    await run();
    assert.equal(state.writes.filter((write) => write.path.endsWith("/requested_reviewers")).length, 1);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("needs human attention")), false);
  } finally { restore(); }
});

test("an analysis changing between issue pages and final metadata invalidates the whole Sonar snapshot", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.sonarFindings = Array.from({ length: 501 }, (_, index) => ({ ...sonarInfo(), key: `new-${index}` }));
    state.onSonarMetadata = (call) => {
      if (call === 2) state.sonarAnalysisDate = new Date(Date.now() + 60_000).toISOString();
    };
    await assert.rejects(run(), /analysis changed during paging/);
    assert.equal(state.writes.length, 0);
    assert.equal(state.verificationCalls, 0);
  } finally { restore(); }
});

test("a large finding set waits for the existing owner-authorized same-head repair without duplicate delegation or escalation", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.sonarFindings = Array.from({ length: 17 }, (_, index) => ({ ...sonarInfo(), key: `new-${index}` }));
    state.prComments.push({ user: { login: "owner" }, created_at: new Date().toISOString(),
      body: "<!-- platform-devex-ci-fix:abcd -->\nOwner-authorized bounded cleanup" });
    await run();
    assert.equal(state.writes.length, 0);
    assert.equal(state.verificationCalls, 0);
  } finally { restore(); }
});

test("quality validation disappearing during SDK verification withdraws a previously valid strict-policy handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.issueComments.push({ id: 77, user: { login: "app[bot]" },
      body: `<!-- platform-devex-ci-ready:abcd -->\n${sonarPolicyMarker("abcd")}` });
    state.onVerify = () => { state.sonarCommit = null; };
    await assert.rejects(run(), /current SonarCloud PR analysis is unavailable/);
    assert.equal(state.verificationCalls, 1);
    assert.match(state.issueComments[0].body, /^<!-- platform-devex-ci-handoff-withdrawn -->/);
    assert.match(state.issueComments[0].body, /final complete SonarCloud PR validation is unavailable/);
  } finally { restore(); }
});

const verifiedProjectXml = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="xunit" /><PackageReference Include="xunit.runner.visualstudio" /></ItemGroup></Project>';

function largerVerifiedTestDiff(state) {
  const project = "src/Checks/Checks.csproj";
  const path = "src/Checks/Regression.cs";
  state.tree.push(...[project, path].map((path) => ({ type: "blob", mode: "100644", path })));
  state.baseTree = state.tree.filter((item) => item.path !== path);
  state.sourceFiles[project] = verifiedProjectXml;
  state.sourceFiles[path] = "public class Regression { }";
  state.files.push({ filename: path, status: "added", additions: 500, deletions: 0,
    patch: "@@ -0,0 +1 @@\n+public class Regression { }" });
  state.pr.changed_files = 2;
  state.pr.additions = 502;
  return { project, path };
}

test("large verified test diffs use their separate budget and report actual categories at human handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    const { project, path } = largerVerifiedTestDiff(state);
    state.onVerify = (context) => {
      assert.deepEqual(context.changeScope.nonTest, { files: 1, lines: 3 });
      assert.deepEqual(context.changeScope.tests, { files: 1, lines: 500 });
      assert.deepEqual(context.changeScope.verifiedTestFiles, [{ path, project }]);
    };
    await run();
    const ready = state.issueComments.find((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:"));
    assert.ok(ready);
    assert.ok(ready.body.includes(changeScopeMarker(state.pr.head.sha)));
    assert.match(ready.body, /non-test\/unverified 1\/8 files, 3\/250 lines; verified tests 1\/8 files, 500\/750 lines; total 2\/12 files, 503\/1000 lines/);
    assert.match(ready.body, /Test allowance: src\/Checks\/Regression.cs.*Checks.csproj/);
    assert.equal(state.verificationCalls, 1, "coverage/conversations are still independently verified");
  } finally { restore(); }
});

test("production moved to a test directory cannot exploit the larger allowance", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    largerVerifiedTestDiff(state);
    state.files[1].status = "renamed";
    state.files[1].previous_filename = "src/Production.cs";
    state.baseTree.push({ path: "src/Production.cs", type: "blob", mode: "100644" });
    await run();
    assert.equal(state.verificationCalls, 0);
    assert.ok(state.issueComments.some((comment) => comment.body.includes("250-line limit")));
    assert.equal(state.issueComments.some((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:")), false);
  } finally { restore(); }
});

test("the test allowance never waives required coverage or grants stale-base handoffs", async () => {
  for (const scenario of ["coverage-gap", "base-race"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      greenReviewed(state);
      largerVerifiedTestDiff(state);
      if (scenario === "coverage-gap") state.coverageDecision = "fix";
      else state.onVerify = () => { state.pr.base.sha = "new-base"; };
      await run();
      assert.equal(state.verificationCalls, 1);
      assert.equal(state.issueComments.some((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:")), false);
      if (scenario === "coverage-gap") {
        const repair = state.writes.find((write) => write.body?.body?.includes("@copilot"));
        assert.ok(repair);
        assertTestingInstructions(repair.body.body);
      } else assert.equal(state.writes.length, 0, "a changed trusted base invalidates cached ownership proof");
    } finally { restore(); }
  }
});

function verifiedStyleFinding(state, key = "new-info") {
  const project = "src/Checks/Checks.csproj";
  const path = "src/Checks/Regression.cs";
  state.tree.push(...[project, path].map((path) => ({ type: "blob", mode: "100644", path })));
  state.sourceFiles[project] = verifiedProjectXml;
  state.sourceFiles[path] = "public class Regression { }";
  return { ...sonarInfo(), key, component: `owner_repo:${path}` };
}

test("verified style advisories reach versioned human handoff without consuming code repairs", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.sonarFindings = [verifiedStyleFinding(state)];
    await run();
    const ready = state.issueComments.find((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:"));
    assert.ok(ready);
    assert.match(ready.body, new RegExp(SONAR_POLICY_VERSION));
    assert.match(ready.body, /1 raw new findings, zero blocking, 1 advisory/);
    assert.match(ready.body, /Advisory findings remain open, not fixed/);
    assert.match(ready.body, /external_roslyn:IDE0058.*src\/Checks\/Regression.cs/);
    assert.equal(state.verificationCalls, 1);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("@copilot")), false);
    state.writes.length = 0;
    await run("true");
    assert.deepEqual(state.writes, []);
  } finally { restore(); }
});

test("mixed findings repair only blockers and valuable INFO stays blocking even in verified test source", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    const advisory = verifiedStyleFinding(state);
    state.sonarFindings = [advisory, { ...advisory, key: "valuable-info",
      rule: "external_roslyn:CA1305", message: "Culture-sensitive parsing" }];
    await run();
    const request = state.writes.find((write) => write.path.endsWith("/issues/8/comments"));
    assert.match(request.body.body, /sonarcloud:valuable-info.*CA1305/);
    assert.doesNotMatch(request.body.body, /sonarcloud:new-info/);
    assert.equal(state.verificationCalls, 0);
    assert.equal(state.issueComments.some((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:")), false);
  } finally { restore(); }
});

test("unverified or PR-created test wiring cannot waive style diagnostics", async () => {
  for (const unknown of ["fake-project", "new-project", "no-base"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      greenReviewed(state);
      state.sonarFindings = [verifiedStyleFinding(state)];
      if (unknown === "fake-project") state.sourceFiles["src/Checks/Checks.csproj"] = "<Project />";
      if (unknown === "new-project") state.baseTree = [];
      if (unknown === "no-base") delete state.pr.base.sha;
      await run();
      assert.equal(state.verificationCalls, 0, unknown);
      assert.ok(state.writes.some((write) => write.body?.body?.includes("sonarcloud:new-info")), unknown);
      assert.equal(state.issueComments.some((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:")), false);
    } finally { restore(); }
  }
});

test("advisory classification never bypasses failed checks or unresolved review conversations", async () => {
  for (const blocker of ["checks", "thread"]) {
    const { state, run, restore } = mockImprovementPr();
    try {
      greenReviewed(state);
      state.sonarFindings = [verifiedStyleFinding(state)];
      if (blocker === "checks") state.checks.check_runs[0].conclusion = "failure";
      else addThread(state, "style-is-not-proof");
      await run();
      assert.equal(state.issueComments.some((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:")), false);
      assert.equal(state.threads.some((thread) => thread.isResolved), false);
    } finally { restore(); }
  }
});

test("a production/valuable finding appearing at final revalidation still prevents advisory handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    const advisory = verifiedStyleFinding(state);
    state.sonarFindings = [advisory];
    state.onVerify = () => state.sonarFindings.push({ ...advisory, key: "valuable",
      rule: "external_roslyn:CA1305", message: "Culture-sensitive parsing" });
    await run();
    assert.equal(state.verificationCalls, 1);
    assert.equal(state.issueComments.some((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:")), false);
  } finally { restore(); }
});

test("large advisory sets report full counts and a bounded excerpt; updates refresh the owned handoff", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    const advisory = verifiedStyleFinding(state);
    state.sonarFindings = Array.from({ length: 17 }, (_, n) => ({ ...advisory, key: `advisory-${n}` }));
    await run();
    const ready = state.issueComments.find((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:"));
    assert.match(ready.body, /17 raw new findings, zero blocking, 17 advisory/);
    assert.match(ready.body, /Showing 12 of 17 advisories; full findings:/);
    assert.equal(state.writes.some((write) => write.body?.body?.includes("@copilot")), false);
    state.sonarFindings.pop();
    state.writes.length = 0;
    await run();
    assert.match(ready.body, /16 raw new findings, zero blocking, 16 advisory/);
    assert.ok(state.writes.some((write) => write.method === "PATCH" && write.path.endsWith(`/comments/${ready.id}`)));
    assert.equal(state.issueComments.filter((comment) => comment.body.startsWith("<!-- platform-devex-ci-ready:")).length, 1);
  } finally { restore(); }
});

test("a merged selected advisory finding must actually disappear, never count as fixed by reclassification", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    state.sonarFindings = [verifiedStyleFinding(state)];
    state.issue.body = '<!-- platform-devex-ci-batch-v1:{"alertIds":["sonarcloud:new-info"],"baseline":{"sonarcloud":1}} -->';
    state.pr.state = "closed";
    state.pr.merged_at = new Date(Date.now() - 30_000).toISOString();
    await run();
    assert.deepEqual(state.writes, []);
    assert.equal(state.issue.state, "open");
  } finally { restore(); }
});

test("intake does not select advisory-only findings and retains their raw scanner count", async () => {
  const previousFetch = globalThis.fetch;
  const writes = [];
  const content = verifiedProjectXml;
  globalThis.fetch = async (url, init) => {
    const request = new URL(url);
    if (request.hostname === "sonarcloud.io") {
      if (request.pathname === "/api/components/show") return Response.json({ component: {
        key: "owner_repo", organization: "owner", qualifier: "TRK", analysisDate: new Date().toISOString(),
      } });
      return Response.json({ total: 1, paging: { pageIndex: 1, pageSize: 500 },
        issues: [{ ...sonarInfo(), component: "owner_repo:Checks/Regression.cs" }] });
    }
    if (init.method !== "GET") writes.push(url);
    const path = request.pathname + request.search;
    if (path.includes("/contents/")) return Response.json({ type: "file", encoding: "base64",
      size: Buffer.byteLength(content), content: Buffer.from(content).toString("base64") });
    const replies = {
      "/user": { login: "owner" },
      "/repos/owner/repo": { default_branch: "main" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [],
      "/repos/owner/repo/issues?state=closed&labels=platform-devex-ci&per_page=100": [],
      "/repos/owner/repo/pulls?state=open&per_page=100": [],
      "/repos/owner/repo/commits/main": { sha: "abcd", commit: { committer: {
        date: new Date(Date.now() - 60_000).toISOString(),
      } } },
      "/repos/owner/repo/git/trees/abcd?recursive=1": { truncated: false, tree: [
        { type: "blob", mode: "100644", path: "src/Checks/Checks.csproj" },
        { type: "blob", mode: "100644", path: "src/Checks/Regression.cs" },
      ] },
    };
    assert.ok(path in replies, `unexpected intake request ${path}`);
    return Response.json(replies[path]);
  };
  try {
    const api = { request: async (path) => (await fetch(`https://api.github.com${path}`, { method: "GET" })).json() };
    const scan = await scanAlerts(api, "owner/repo", ["sonarcloud"]);
    assert.equal(scan.counts.sonarcloud, 1);
    assert.equal(scan.alerts.length, 1);
    await main({ CI_MODE: "intake", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
      CI_SCAN_SOURCES: "sonarcloud", GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: "false",
      APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]", COPILOT_AGENT_PAT: "human" });
    assert.deepEqual(writes, []);
  } finally { globalThis.fetch = previousFetch; }
});

test("policy migration grants bounded revalidation time, not an immediate stall escalation or budget reset", async () => {
  const { state, run, restore } = mockImprovementPr();
  try {
    greenReviewed(state);
    state.pr.updated_at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    state.checks.check_runs[0].status = "in_progress";
    state.checks.check_runs[0].conclusion = null;
    state.issueComments.push({ id: 77, user: { login: "app[bot]" },
      body: "<!-- platform-devex-ci-ready:abcd -->\n<!-- platform-devex-ci-sonar-zero-v1:abcd -->" });
    await run();
    assert.match(state.issueComments[0].body, /current versioned Sonar policy/);
    state.writes.length = 0;
    await run();
    assert.deepEqual(state.writes, [], "wait for pending validation during the migration grace period");
    state.issueComments[0].updated_at = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    await run();
    assert.ok(state.writes.some((write) => write.body?.body?.includes("has not progressed for 48 hours")));
  } finally { restore(); }
});
