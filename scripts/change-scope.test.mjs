import assert from "node:assert/strict";
import test from "node:test";
import { budgetRisk, classifyChangedTests, diffRisk, scopeCounts, scopeReport } from "./change-scope.mjs";

const project = "src/Checks/Checks.csproj";
const source = "src/Checks/Regression.cs";
const xml = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="xunit" /><PackageReference Include="xunit.runner.visualstudio" /></ItemGroup></Project>';
const blob = (path) => ({ path, type: "blob", mode: "100644" });
const pr = { head: { sha: "head" }, base: { sha: "base" } };
const totals = (files) => ({ changed_files: files.length,
  additions: files.reduce((n, file) => n + file.additions, 0),
  deletions: files.reduce((n, file) => n + file.deletions, 0) });

function repository() {
  const state = { head: [blob(project), blob(source)], base: [blob(project), blob(source)],
    content: { [`head:${project}`]: xml, [`base:${project}`]: xml }, calls: [] };
  return { state, api: { request: async (path) => {
    state.calls.push(path);
    const tree = path.match(/\/git\/trees\/(head|base)\?recursive=1$/);
    if (tree) return { truncated: false, tree: state[tree[1]] };
    const url = new URL(path, "https://api.github.com");
    const key = `${url.searchParams.get("ref")}:${decodeURIComponent(url.pathname.split("/contents/")[1])}`;
    if (!(key in state.content)) throw new Error("GET metadata HTTP 404");
    const content = state.content[key];
    if (content instanceof Error) throw content;
    return { type: "file", encoding: "base64", size: Buffer.byteLength(content),
      content: Buffer.from(content).toString("base64") };
  } } };
}

test("separate budgets accept exact boundaries and reject excess in every dimension", () => {
  assert.equal(budgetRisk({ nonTest: { files: 4, lines: 250 }, tests: { files: 8, lines: 750 } }), null);
  for (const [nonTest, tests, expected] of [
    [{ files: 8, lines: 251 }, { files: 1, lines: 1 }, /250-line/],
    [{ files: 9, lines: 9 }, { files: 1, lines: 1 }, /eight-file/],
    [{ files: 1, lines: 1 }, { files: 8, lines: 751 }, /750-line/],
    [{ files: 1, lines: 1 }, { files: 9, lines: 9 }, /eight-file/],
    [{ files: 5, lines: 5 }, { files: 8, lines: 8 }, /12-file/],
    [{ files: 0, lines: 1 }, { files: 1, lines: 1 }, /Invalid/],
    [{ files: 1, lines: -1 }, { files: 1, lines: 1 }, /Invalid/],
    [{ files: 1, lines: 1.5 }, { files: 1, lines: 1 }, /Invalid/],
  ]) assert.match(budgetRisk({ nonTest, tests }), expected);
});

test("actual per-file additions AND deletions reconcile with PR totals; names grant no allowance", () => {
  const files = [
    { filename: "src/App.cs", additions: 200, deletions: 50 },
    { filename: source, additions: 600, deletions: 150 },
  ];
  assert.match(diffRisk(totals(files), files), /250-line/);
  const verified = [{ path: source, project }];
  assert.equal(diffRisk(totals(files), files, verified), null);
  assert.deepEqual(scopeCounts(files, verified), { nonTest: { files: 1, lines: 250 }, tests: { files: 1, lines: 750 } });
  assert.match(scopeReport(files, verified), /non-test\/unverified 1\/8 files, 250\/250 lines.*verified tests 1\/8 files, 750\/750 lines.*1000\/1000/);
  files[1].deletions++;
  assert.match(diffRisk(totals(files), files, verified), /750-line/);
  for (const changed of [
    { ...totals(files), additions: 0 }, { ...totals(files), changed_files: 1 },
    { ...totals(files), deletions: -1 },
  ]) assert.match(diffRisk(changed, files, verified), /inconsistent/);
  assert.match(diffRisk({ changed_files: 1, additions: 1, deletions: 0 }, [{ filename: source }]), /inconsistent/);
  assert.match(diffRisk({ changed_files: 2, additions: 2, deletions: 0 },
    [{ filename: source, additions: 1, deletions: 0 }, { filename: source, additions: 1, deletions: 0 }]), /inconsistent/);
});

test("test source is verified for additions, modifications, removals and both sides of renames", async () => {
  for (const status of ["added", "modified", "removed", "renamed"]) {
    const { state, api } = repository();
    const file = { filename: source, status };
    if (status === "added") state.base.pop();
    if (status === "removed") state.head.pop();
    if (status === "renamed") {
      file.previous_filename = "src/Checks/Old.cs";
      state.base[1].path = file.previous_filename;
    }
    const result = await classifyChangedTests(api, "owner/repo", pr, [file]);
    assert.equal(result.length, 1, status);
    assert.equal(result[0].project, project);
    if (status === "renamed") assert.equal(result[0].previousPath, file.previous_filename);
  }
});

test("production-to-test moves, new/fake projects, excluded files and uncertain ownership get no test budget", async () => {
  for (const scenario of ["production-rename", "missing-rename", "new-project", "fake-base", "symlink",
    "missing-old", "linked-production", "obj", "unknown-status", "no-base"]) {
    const { state, api } = repository();
    const file = { filename: source, status: "modified" };
    if (scenario === "production-rename") {
      file.status = "renamed"; file.previous_filename = "src/App/Regression.cs";
      state.base.push(blob(file.previous_filename));
    }
    if (scenario === "missing-rename") file.status = "renamed";
    if (scenario === "new-project") state.base = [];
    if (scenario === "fake-base") state.content[`base:${project}`] = xml.replace("Microsoft.NET.Test.Sdk", "Production.Sdk");
    if (scenario === "symlink") state.head[1].mode = "120000";
    if (scenario === "missing-old") state.base.pop();
    if (scenario === "linked-production") {
      state.base.push(blob("src/App/App.csproj"));
      state.content["base:src/App/App.csproj"] = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../Checks/*.cs" /></ItemGroup></Project>';
    }
    if (scenario === "obj") { file.filename = "src/Checks/obj/Regression.cs"; state.head[1].path = file.filename; }
    if (scenario === "unknown-status") file.status = "unknown";
    assert.deepEqual(await classifyChangedTests(api, "owner/repo",
      scenario === "no-base" ? { ...pr, base: {} } : pr, [file]), [], scenario);
  }
});

test("metadata 404 is visibly conservative; permission/network errors are not hidden", async () => {
  const { state, api } = repository();
  delete state.content[`base:${project}`];
  assert.deepEqual(await classifyChangedTests(api, "owner/repo", pr, [{ filename: source, status: "modified" }]), []);
  state.content[`base:${project}`] = new Error("GET metadata HTTP 403");
  await assert.rejects(classifyChangedTests(api, "owner/repo", pr,
    [{ filename: source, status: "modified" }]), /HTTP 403/);
});

test("test-like JavaScript names, fixtures and configuration remain normal-budget files", async () => {
  const { state, api } = repository();
  assert.deepEqual(await classifyChangedTests(api, "owner/repo", pr, [
    { filename: "tests/a.test.js", status: "modified" }, { filename: "src/Checks/seed.sql", status: "added" },
    { filename: project, status: "modified" },
  ]), []);
  assert.deepEqual(state.calls, []);
});

test("sensitive paths and their rename sources stay blocked even with asserted test eligibility", () => {
  for (const path of ["scripts/change-scope.mjs", "scripts/test-projects.mjs", ".github/workflows/tests.yml", "Directory.Build.props"]) {
    const file = { filename: source, previous_filename: path, additions: 1, deletions: 1 };
    assert.match(diffRisk(totals([file]), [file], [{ path: source, project }]), /gated path/);
  }
});
