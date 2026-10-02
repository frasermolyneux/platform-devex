import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyze,
  checkState,
  diffRisk,
  ensureBatchLabel,
  main,
  parseAllowlist,
  parseBatch,
  scanAlerts,
  selectCandidates,
  selectRepositories,
  validateProposal,
} from "./continuous-improvement.mjs";

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

test("analysis cannot select unknown, critical or unrelated findings", () => {
  const alerts = [
    { id: "code-scanning:1", severity: "medium", path: "src/a.js" },
    { id: "code-scanning:2", severity: "low", path: "other/b.js" },
    { id: "dependabot:3", severity: "critical", path: "src/package.json" },
  ];
  const proposal = { decision: "propose", risk: "low", title: "Fix", rationale: "small",
    tests: ["npm test"], alertIds: ["code-scanning:1"] };
  assert.deepEqual(validateProposal(proposal, alerts)?.alertIds, proposal.alertIds);
  assert.equal(validateProposal({ ...proposal, alertIds: ["code-scanning:1", "code-scanning:2"] }, alerts), null);
  assert.equal(validateProposal({ ...proposal, alertIds: ["dependabot:3"] }, alerts), null);
  assert.equal(validateProposal({ ...proposal, alertIds: ["code-scanning:9"] }, alerts), null);
  assert.equal(validateProposal({ ...proposal, risk: "high" }, alerts), null);
  assert.equal(validateProposal({ ...proposal, risk: "medium" }, alerts)?.risk, "medium");
  const sonar = { id: "sonarcloud:key", source: "sonarcloud", path: "src/other.js", severity: "BLOCKER" };
  assert.equal(validateProposal({ ...proposal, alertIds: [sonar.id] }, [...alerts, sonar]), null);
});

test("diff gate blocks sensitive paths and oversized changes", () => {
  const pr = { changed_files: 1, additions: 5, deletions: 1 };
  assert.equal(diffRisk(pr, [{ filename: "src/a.js" }]), null);
  assert.match(diffRisk(pr, [{ filename: ".github/workflows/ci.yml" }]), /gated path/);
  assert.match(diffRisk(pr, [{ filename: "src/a.js", previous_filename: "infra/main.tf" }]), /gated path/);
  assert.equal(diffRisk({ ...pr, additions: 249, deletions: 1 }, [{ filename: "src/a.js" }]), null);
  assert.match(diffRisk({ ...pr, additions: 251 }, [{ filename: "src/a.js" }]), /250-line/);
  assert.match(diffRisk({ ...pr, changed_files: 9 }, [{ filename: "src/a.js" }]), /eight-file/);
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

test("code-scanning security scores reject critical findings rather than treating them as unknown", async () => {
  const records = ["9.1", "7.5", "4.2"].map((score, index) => ({
    number: index + 1, rule: { id: `rule-${index}`, security_severity_level: score },
    most_recent_instance: { location: { path: `src/${index}.js`, start_line: 5 } },
  }));
  const api = { pages: async () => records };
  const scan = await scanAlerts(api, "owner/repo", ["code-scanning"]);
  assert.deepEqual(scan.alerts.map((alert) => alert.severity), ["critical", "high", "medium"]);
  assert.equal(selectCandidates(scan.alerts).some((alert) => alert.id === "code-scanning:1"), false);
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
            sendAndWait: async (message) => {
              assert.equal(message.responseSchema, undefined);
              assert.match(message.prompt, /alertIds \(array of IDs\)/);
              return { data: { content: '{"decision":"skip"}' } };
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
  const paths = [];
  const replies = new Map([
    ["/user", { login: "owner" }],
    ["/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100", [{
      number: 7, body: '<!-- platform-devex-ci-batch-v1:{"alertIds":["code-scanning:1"]} -->',
      user: { login: "owner" }, created_at: new Date().toISOString(),
    }]],
    ["/repos/owner/repo/issues/7/comments?per_page=100", []],
    ["/repos/owner/repo/issues/7/timeline?per_page=100", [{
      event: "cross-referenced", source: { issue: { number: 8, pull_request: {} } },
    }]],
    ["/repos/owner/repo/pulls/8", {
      number: 8, state: "open", updated_at: new Date().toISOString(),
      changed_files: 1, additions: 2, deletions: 1, draft: false, mergeable_state: "clean",
      user: { login: "Copilot" }, head: { sha: "abcd", ref: "copilot/fix", repo: { full_name: "owner/repo" } },
      base: { ref: "main", repo: { full_name: "owner/repo" } },
    }],
    ["/repos/owner/repo", { default_branch: "main" }],
    ["/repos/owner/repo/compare/main...abcd", { behind_by: 0 }],
    ["/repos/owner/repo/issues/8/comments?per_page=100", []],
    ["/repos/owner/repo/pulls/8/files?per_page=100", [{ filename: "src/a.js" }]],
    ["/repos/owner/repo/commits/abcd/check-runs?per_page=100", {
      total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }],
    }],
    ["/repos/owner/repo/commits/abcd/status", { state: "pending", statuses: [] }],
    ["/repos/owner/repo/pulls/8/reviews?per_page=100", [{
      user: { login: "copilot-pull-request-reviewer[bot]" }, commit_id: "abcd", state: "COMMENTED",
    }]],
    ["/graphql", { data: { repository: { pullRequest: { reviewThreads: {
      nodes: [], pageInfo: { hasNextPage: false },
    } } } } }],
  ]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    paths.push(`${init.method} ${path}`);
    assert.ok(replies.has(path), `unexpected request: ${path}`);
    if (path === "/graphql") assert.match(JSON.parse(init.body).query, /^query\(/);
    return new Response(JSON.stringify(replies.get(path)), { status: 200 });
  };
  try {
    await main({
      CI_MODE: "intake", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
      GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: "true",
      APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]",
      COPILOT_AGENT_PAT: "human",
    });
    assert.equal(paths.filter((path) => path.startsWith("POST ") && !path.endsWith("/graphql")).length, 0);
    assert.equal(paths.filter((path) => path === "GET /user").length, 1);
    assert.equal(paths.some((path) => path.includes("/code-scanning/alerts")), false);
  } finally {
    globalThis.fetch = previousFetch;
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
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (init.method === "POST") {
      writes.push({ path, body: JSON.parse(init.body).body });
      return Response.json({});
    }
    const result = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [{
        number: 7, body: '<!-- platform-devex-ci-batch-v1:{"alertIds":["code-scanning:1"]} -->',
        user: { login: "owner" }, created_at: now,
      }],
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
      "/repos/owner/repo/pulls/8/files?per_page=100": [{ filename: "src/a.js" }],
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
      base: { ref: "main", repo: { full_name: "owner/repo" } },
    },
    checks: { total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion: "skipped" }] },
    status: { state: "pending", statuses: [] },
    behindBy: 0,
    reviews: [],
    threads: [],
    issueComments: [],
    prComments: [],
    writes: [],
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (init.method !== "GET") {
      const body = JSON.parse(init.body);
      if (path === "/graphql" && body.query.startsWith("query(")) {
        return Response.json({ data: { repository: { pullRequest: { reviewThreads: {
          nodes: state.threads, pageInfo: { hasNextPage: false },
        } } } } });
      }
      state.writes.push({ method: init.method, path, body, token: init.headers.Authorization });
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
        state.issueComments.push({ user: { login: "app[bot]" }, body: body.body });
      }
      return Response.json({});
    }
    const replies = {
      "/user": { login: "owner" },
      "/repos/owner/repo/issues?state=open&labels=platform-devex-ci&per_page=100": [{
        number: 7, body: '<!-- platform-devex-ci-batch-v1:{"alertIds":["code-scanning:1"]} -->',
        user: { login: "owner" }, created_at: now,
      }],
      "/repos/owner/repo/issues/7/comments?per_page=100": state.issueComments,
      "/repos/owner/repo/issues/7/timeline?per_page=100": [{
        event: "cross-referenced", source: { issue: { number: 8, pull_request: {} } },
      }],
      "/repos/owner/repo/pulls/8": state.pr,
      "/repos/owner/repo": { default_branch: "main" },
      "/repos/owner/repo/issues/8/comments?per_page=100": state.prComments,
      "/repos/owner/repo/pulls/8/files?per_page=100": [{ filename: "src/a.js" }],
      [`/repos/owner/repo/compare/main...${state.pr.head.sha}`]: { behind_by: state.behindBy },
      [`/repos/owner/repo/commits/${state.pr.head.sha}/check-runs?per_page=100`]: state.checks,
      [`/repos/owner/repo/commits/${state.pr.head.sha}/status`]: state.status,
      "/repos/owner/repo/pulls/8/reviews?per_page=100": state.reviews,
    };
    assert.ok(path in replies, `unexpected request: ${path}`);
    return Response.json(replies[path]);
  };
  const run = (dryRun = "false") => main({
    CI_MODE: "reconcile", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
    GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: dryRun,
    APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]", COPILOT_AGENT_PAT: "human",
  });
  return { state, run, restore: () => { globalThis.fetch = previousFetch; } };
}

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
    assert.deepEqual(state.writes[1].body.reviewers, ["copilot-pull-request-reviewer[bot]"]);
    assert.equal(state.writes[2].path, "/repos/owner/repo/issues/7/comments");
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    await run();
    assert.equal(state.writes.length, 3);
    state.pr.mergeable_state = "clean";
    await run();
    assert.equal(state.writes[3].path, "/repos/owner/repo/issues/7/comments");
    assert.match(state.writes[3].body.body, /ready for \*\*human\*\* review and merge/);
    assert.match(state.writes[3].body.body, /Passing checks: build/);
    assert.doesNotMatch(state.writes[3].body.body, /optional/);
    await run();
    assert.equal(state.writes.length, 4);
  } finally {
    restore();
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
    assert.equal(state.writes[2].path, "/repos/owner/repo/pulls/8/update-branch");
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
    state.pr.body = "Fixes #7";
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
    assert.equal(state.writes[0].method, "PATCH");
    assert.equal(state.writes[0].path, "/repos/owner/repo/pulls/8");
    assert.equal(state.writes[0].token, "Bearer app");
    assert.equal(state.pr.body, "Refs #7");
    await run();
    assert.equal(state.writes[1].path, "/graphql");
    assert.equal(state.writes[1].body.variables.id, "THREAD_1");
    assert.equal(state.writes[1].token, "Bearer human");
    assert.equal(state.threads[0].isResolved, true);
    state.pr.mergeable_state = "clean";
    await run();
    assert.match(state.writes[2].body.body, /platform-devex-ci-ready:abcd/);
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
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].path, "/repos/owner/repo/issues/8/comments");
    assert.equal(state.writes[0].token, "Bearer human");
    assert.match(state.writes[0].body.body, /@copilot please address/);
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
    state.pr.updated_at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    state.checks.check_runs[0].conclusion = "success";
    state.reviews.push({ user: { login: "copilot-pull-request-reviewer[bot]" },
      commit_id: "abcd", state: "COMMENTED" });
    state.issueComments.push({ user: { login: "app[bot]" },
      body: "<!-- platform-devex-ci-ready:abcd -->" });
    await run();
    assert.equal(state.writes.length, 0);
  } finally {
    restore();
  }
});
