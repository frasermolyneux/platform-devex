import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyAutomation } from "../.github/actions/delegate-failed-checks/eligibility.mjs";

function pullRequest(author, branch) {
  return {
    user: { login: author },
    head: { ref: branch, repo: { id: 42, full_name: "owner/repo" } },
    base: { ref: "main", repo: { id: 42, full_name: "owner/repo" } },
  };
}

test("owner-authored feature PRs are excluded, including xi-bank's reported case", () => {
  const pr = pullRequest("frasermolyneux", "feature/add-ips-api-key");
  pr.head.repo.full_name = pr.base.repo.full_name = "frasermolyneux/xi-bank";
  assert.equal(classifyAutomation(pr, "frasermolyneux/xi-bank"), null);
});

test("same-repository Copilot and Dependabot PRs remain eligible", () => {
  for (const author of ["Copilot", "copilot-swe-agent[bot]"]) {
    assert.equal(classifyAutomation(pullRequest(author, "copilot/fix-checks"), "owner/repo"), "copilot");
  }
  assert.equal(classifyAutomation(pullRequest("dependabot[bot]", "dependabot/nuget/package-1.2"), "owner/repo"),
    "dependabot");
});

test("branch names, labels, assignment and delegation markers cannot opt in a human PR", () => {
  for (const branch of ["feature/work", "copilot/fix-checks", "dependabot/nuget/package"]) {
    const pr = {
      ...pullRequest("owner", branch),
      labels: [{ name: "platform-devex-ci" }],
      assignees: [{ login: "Copilot" }],
      body: "<!-- platform-devex-ci-batch-v1:{\"alertIds\":[\"dependabot:1\"]} -->",
    };
    assert.equal(classifyAutomation(pr, "owner/repo"), null);
  }
});

test("unrecognized bots and unexpected automation branches are excluded", () => {
  for (const [author, branch] of [
    ["github-actions[bot]", "copilot/fix"],
    ["sonarcloud[bot]", "dependabot/package"],
    ["other-user", "copilot/fix"],
    ["Copilot", "feature/work"],
    ["dependabot[bot]", "feature/work"],
  ]) {
    assert.equal(classifyAutomation(pullRequest(author, branch), "owner/repo"), null);
  }
});

test("forks, deleted heads, missing origin metadata and other repositories are excluded", () => {
  for (const author of ["Copilot", "dependabot[bot]"]) {
    const branch = author === "Copilot" ? "copilot/fix" : "dependabot/package";
    const mutations = [
      (pr) => { pr.head.repo.id = 99; pr.head.repo.full_name = "other/repo"; },
      (pr) => { pr.head.repo = null; },
      (pr) => { pr.base.repo = null; },
      (pr) => { delete pr.head.repo.id; },
      (pr) => { pr.head.repo.id = pr.base.repo.id = 0; },
      (pr) => { pr.head.repo.full_name = pr.base.repo.full_name = "other/repo"; },
      (pr) => { delete pr.head.ref; },
    ];
    for (const mutate of mutations) {
      const pr = pullRequest(author, branch);
      mutate(pr);
      assert.equal(classifyAutomation(pr, "owner/repo"), null);
    }
  }
  assert.equal(classifyAutomation(null, "owner/repo"), null);
  assert.throws(() => classifyAutomation({}, ""), /owner\/repo/);
});

test("the composite's CLI reports classification and fails explicitly on invalid data", () => {
  const script = fileURLToPath(new URL("../.github/actions/delegate-failed-checks/eligibility.mjs", import.meta.url));
  for (const [pr, expected] of [
    [pullRequest("owner", "feature/work"), "manual-or-untrusted"],
    [pullRequest("Copilot", "copilot/fix"), "copilot"],
    [pullRequest("dependabot[bot]", "dependabot/package"), "dependabot"],
  ]) {
    const result = spawnSync(process.execPath, [script, "owner/repo"], {
      input: JSON.stringify(pr), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
  const malformed = spawnSync(process.execPath, [script, "owner/repo"], { input: "{", encoding: "utf8" });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /SyntaxError/);
});
