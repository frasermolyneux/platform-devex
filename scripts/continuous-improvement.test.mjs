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
  assert.throws(() => parseBatch('<!-- platform-devex-ci-batch-v1:{"alertIds":["bogus"]} -->'), /Invalid/);
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
});

test("diff gate blocks sensitive paths and oversized changes", () => {
  const pr = { changed_files: 1, additions: 5, deletions: 1 };
  assert.equal(diffRisk(pr, [{ filename: "src/a.js" }]), null);
  assert.match(diffRisk(pr, [{ filename: ".github/workflows/ci.yml" }]), /gated path/);
  assert.match(diffRisk(pr, [{ filename: "src/a.js", previous_filename: "infra/main.tf" }]), /gated path/);
  assert.match(diffRisk({ ...pr, additions: 151 }, [{ filename: "src/a.js" }]), /150-line/);
  assert.match(diffRisk({ ...pr, changed_files: 2 }, [{ filename: "src/a.js" }]), /five-file/);
});

test("SDK impact analysis has no tools and validates its response", async () => {
  const oldToken = process.env.GITHUB_TOKEN;
  const oldPat = process.env.COPILOT_AGENT_PAT;
  let baseDirectory;
  process.env.GITHUB_TOKEN = "test";
  process.env.COPILOT_AGENT_PAT = "test-human";
  try {
    const result = await analyze([{ id: "code-scanning:1", path: "src/a.js" }], async (options) => {
      assert.equal(options.mode, "empty");
      assert.equal(options.gitHubToken, undefined);
      assert.equal(options.useLoggedInUser, false);
      assert.equal(options.env.COPILOT_AGENT_PAT, undefined);
      assert.equal(options.env.COPILOT_GITHUB_TOKEN, undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
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
    ["/repos/owner/repo/pulls/8/comments?per_page=100", []],
  ]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    paths.push(`${init.method} ${path}`);
    assert.ok(replies.has(path), `unexpected request: ${path}`);
    return new Response(JSON.stringify(replies.get(path)), { status: 200 });
  };
  try {
    await main({
      CI_MODE: "intake", CI_REPOSITORIES: "repo", CI_REPOSITORY: "repo",
      GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: "true",
      APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]",
      COPILOT_AGENT_PAT: "human",
    });
    assert.equal(paths.filter((path) => path.startsWith("POST ")).length, 0);
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
      GITHUB_REPOSITORY_OWNER: "owner", CI_DRY_RUN: "false",
      APP_TOKEN: "app", APP_BOT_LOGIN: "app[bot]", COPILOT_AGENT_PAT: "human",
    });
    assert.equal(paths.some((path) => path.startsWith("POST ")), false);
    assert.ok(paths.some((path) => path.includes("contents/src/deleted.js")));
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
    inline: [],
    issueComments: [],
    prComments: [],
    writes: [],
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (init.method !== "GET") {
      const body = JSON.parse(init.body);
      state.writes.push({ method: init.method, path, body, token: init.headers.Authorization });
      if (path === "/graphql") {
        state.pr.draft = false;
        return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      }
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
      "/repos/owner/repo/pulls/8/comments?per_page=100": state.inline,
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
