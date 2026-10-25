import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { BRANCH, MARKER, GitHubApi, checkSnapshot, compareVersions, discoverRepositories, pinVersion,
  planUpdate, reconcile, rootSources, selectTarget, sourceDigest, stableReleases, validatePolicy } from "./terraform-cli.mjs";

const repository = "owner/target", bot = "maintenance[bot]";
const baseSha = "a".repeat(40), newSha = "b".repeat(40);
const sourceSha = "c".repeat(40), pinSha = "d".repeat(40), nextPinSha = "e".repeat(40);
const target = "1.16.7", releases = ["1.17.0", target];
const file = (path, sha = sourceSha) => ({ path, sha, mode: "100644", type: "blob" });
const tree = (...entries) => ({ truncated: false, tree: entries });

function fixture() {
  const state = { base: baseSha, head: null, pulls: [], writes: [], refsRead: 0, pullsRead: 0,
    baseTree: tree(file("terraform/providers.tf"), file("terraform/.terraform-version", pinSha)),
    headTree: null, headPin: `${target}\n`, rejectAtomic: false };
  const meta = { full_name: repository, archived: false, fork: false, default_branch: "main" };
  const makePr = () => ({ number: 7, state: "open", user: { type: "Bot", login: bot }, body: `${MARKER}\n`,
    head: { ref: BRANCH, sha: state.head, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } } });
  const api = {
    async get(endpoint) {
      if (endpoint === `/repos/${repository}`) return meta;
      if (endpoint.endsWith("/git/ref/heads/main")) {
        state.refsRead++;
        state.onBaseRead?.();
        return { object: { sha: state.base } };
      }
      if (endpoint.endsWith(`/git/ref/heads/${encodeURIComponent(BRANCH)}`)) {
        state.onHeadRead?.();
        if (!state.head) throw Object.assign(new Error("Not found"), { status: 404 });
        return { object: { sha: state.head } };
      }
      if (endpoint.includes("/git/trees/")) {
        return endpoint.includes(baseSha) ? state.baseTree : state.headTree;
      }
      if (endpoint.endsWith(`/git/blobs/${pinSha}`)) return blob("1.15.8\n");
      if (endpoint.endsWith(`/git/blobs/${nextPinSha}`)) return blob(state.headPin);
      if (endpoint.includes("/compare/")) return { files: state.diff ?? [{ filename: "terraform/.terraform-version", status: "modified" }] };
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async pages(endpoint) {
      if (endpoint.includes("/check-runs?")) return state.checks ?? [];
      if (endpoint.endsWith("/statuses")) return state.statuses ?? [];
      assert.equal(endpoint, `/repos/${repository}/pulls?state=open`);
      state.pullsRead++;
      state.onPullsRead?.();
      return structuredClone(state.pulls);
    },
    async post(endpoint, data) {
      state.writes.push({ endpoint, data });
      if (endpoint.endsWith("/git/refs")) {
        assert.equal(state.head, null);
        state.head = data.sha;
        return {};
      }
      assert.ok(endpoint.endsWith("/pulls"));
      const pr = { ...makePr(), title: data.title, body: data.body };
      state.pulls = [pr];
      return pr;
    },
    async patch(endpoint, data) {
      state.writes.push({ endpoint, data });
      return { ...makePr(), ...data };
    },
    async graphql(query, { input }) {
      state.writes.push({ endpoint: "/graphql", data: input });
      assert.match(query, /createCommitOnBranch/);
      state.onAtomic?.();
      assert.equal(input.expectedHeadOid, state.head);
      if (state.rejectAtomic) throw new Error("atomic head race rejected");
      assert.deepEqual(input.fileChanges.additions.map((entry) => entry.path), ["terraform/.terraform-version"]);
      state.head = newSha;
      state.headPin = Buffer.from(input.fileChanges.additions[0].contents, "base64").toString("utf8");
      state.headTree = tree(file("terraform/providers.tf"), file("terraform/.terraform-version", nextPinSha));
      for (const pr of state.pulls) pr.head.sha = newSha;
      return { createCommitOnBranch: { commit: { oid: newSha } } };
    },
  };
  const policy = { schemaVersion: 1, approvedTarget: target, approvedMinor: "1.16", approval: "Owner-reviewed vendor bulletin and release policy",
    compatibility: { [`${repository}/terraform`]: {
      sourceDigest: sourceDigest([file("terraform/providers.tf")]), allowedTargets: [target],
      rationale: "Reviewed all root required_version and override constraints against the approved target",
    } } };
  return { state, api, policy, meta, makePr };
}

function blob(content) { return { encoding: "base64", size: Buffer.byteLength(content), content: Buffer.from(content).toString("base64") }; }
function run(f, extra = {}) { return reconcile({ api: f.api, repository, bot, policy: f.policy, releases, ...extra }); }

test("detects every pinned root, including repository root, terraform-sub, edge and nested roots", () => {
  const entries = [".", "terraform", "terraform-sub", "edge", "infra/independent"].flatMap((root) => {
    const prefix = root === "." ? "" : `${root}/`;
    return [file(`${prefix}.terraform-version`, pinSha), file(`${prefix}providers.tf`),
      file(`${prefix}override.tf.json`)];
  });
  const roots = rootSources(tree(...entries));
  assert.deepEqual(rootSources(tree(file("terraform/unpinned.tf"))), []);
  assert.equal(roots.length, 5);
  assert.ok(roots.every((root) => root.files.length === 2));
  assert.ok(roots.every((root) => root.compatibilityFiles.length === 10));
  assert.notEqual(sourceDigest(roots[0].files), sourceDigest(roots[1].files));
  assert.throws(() => rootSources({ ...tree(...entries), truncated: true }), /Incomplete/);
  assert.throws(() => rootSources(tree(file("terraform/.terraform-version"))), /no bounded/);
  assert.throws(() => rootSources(tree(...entries, entries[0])), /Invalid repository tree/);
  assert.throws(() => rootSources(tree(file("terraform/.terraform-version"), file("terraform/providers.tf"),
    ...Array.from({ length: 2048 }, (_, index) => file(`modules/shared/source-${index}.tf`)))), /oversized/);
  assert.throws(() => rootSources(tree(file("terraform/.terraform-version"), { ...file("terraform/providers.tf"), mode: "120000" })), /compatibility sources/);
  assert.throws(() => rootSources(tree({ ...file("terraform/.terraform-version"), mode: "120000" }, file("terraform/a.tf"))), /Unsafe/);
});

test("rejects invalid pins, prereleases, floating ranges, whitespace and leading zeroes", () => {
  assert.equal(pinVersion("1.16.7\r\n"), target);
  for (const pin of ["latest", "v1.16.7", "1.16", "01.16.7", "1.16.7-beta1", "1.16.7+build", " 1.16.7", "1.16.7\n\n"]) {
    assert.throws(() => pinVersion(pin), /Invalid/);
  }
  assert.equal(compareVersions("1.16.10", "1.16.9"), 1);
  assert.deepEqual(stableReleases([
    { tag_name: "v1.17.0", draft: false, prerelease: false },
    { tag_name: "v1.18.0-rc1", draft: false, prerelease: false },
    { tag_name: "v2.0.0", draft: false, prerelease: true },
    { tag_name: "v9.0.0", draft: true, prerelease: false },
    { tag_name: "v1.16.7", draft: false, prerelease: false },
    { tag_name: "v1.99.0" },
  ]), ["1.17.0", target]);
});

test("requires explicit reviewed target and exact root-source compatibility, never latest/minor roulette", async () => {
  const f = fixture();
  const plan = await planUpdate({ api: f.api, repository, baseSha, policy: f.policy, releases });
  assert.deepEqual(plan.changes, [{ path: "terraform/.terraform-version", content: `${target}\n` }]);
  assert.deepEqual(plan.blocked, []);
  f.policy.compatibility[`${repository}/terraform`].allowedTargets = ["1.17.0"];
  assert.equal((await run(f)).status, "blocked");
  f.policy.compatibility = {};
  assert.equal((await run(f)).status, "blocked");
  f.policy.approvedTarget = null;
  f.policy.approvedMinor = null;
  assert.match((await run(f)).blocked[0], /no centrally approved/);
  f.policy.approvedTarget = "1.15.7";
  f.policy.approvedMinor = "1.15";
  await assert.rejects(run(f), /absent.*official stable/);
  assert.equal((await run(f, { releases: ["1.15.7"] })).status, "blocked");
  assert.equal(f.state.writes.length, 0);
  assert.throws(() => validatePolicy({ ...f.policy, approvedTarget: "1.17.0-beta1" }), /Invalid/);
});

test("any root source/override identity change invalidates compatibility review", async () => {
  const f = fixture();
  f.state.baseTree.tree.push(file("terraform/override.tf.json", "f".repeat(40)));
  const result = await run(f, { dryRun: false });
  assert.equal(result.status, "blocked");
  assert.match(result.blocked[0], /unknown or incompatible/);
  assert.equal(f.state.writes.length, 0);
});

test("local-module-only changes invalidate compatibility instead of authorizing incompatible pin PRs", async () => {
  const f = fixture();
  const moduleFile = file("modules/shared/versions.tf", "f".repeat(40));
  f.state.baseTree.tree.push(moduleFile);
  f.policy.compatibility[`${repository}/terraform`].sourceDigest =
    sourceDigest([moduleFile, file("terraform/providers.tf")]);
  assert.equal((await run(f)).status, "would-propose");
  moduleFile.sha = "1".repeat(40);
  const blocked = await run(f, { dryRun: false });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.roots[0].compatibility, "unknown");
  assert.match(blocked.blocked[0], /unknown or incompatible/);
  assert.equal(f.state.writes.length, 0);
  moduleFile.mode = "120000";
  await assert.rejects(run(f, { dryRun: false }), /compatibility sources/);
});

test("dry-run reports immutable review evidence without treating current pins as compatibility approval", async () => {
  const f = fixture();
  f.policy.compatibility = {};
  const blocked = await run(f);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.baseSha, baseSha);
  assert.equal(blocked.roots[0].sourceDigest, sourceDigest([file("terraform/providers.tf")]));
  assert.equal(blocked.roots[0].compatibility, "unknown");
  const get = f.api.get;
  f.api.get = (endpoint) => endpoint.endsWith(`/git/blobs/${pinSha}`) ? blob(`${target}\n`) : get(endpoint);
  const current = await run(f);
  assert.equal(current.status, "current");
  assert.equal(current.baseSha, baseSha);
  assert.equal(current.roots[0].compatibility, "unknown");
  assert.deepEqual(current.changes, []);
  assert.equal(f.state.writes.length, 0);
});

test("multi-root proposals are all-or-nothing and include nonstandard roots in the same bounded proposal", async () => {
  const f = fixture();
  f.state.baseTree.tree.push(file("terraform-sub/providers.tf"), file("terraform-sub/.terraform-version", pinSha));
  assert.equal((await run(f, { dryRun: false })).status, "blocked");
  assert.equal(f.state.writes.length, 0);
  const digest = sourceDigest(rootSources(f.state.baseTree)[0].compatibilityFiles);
  f.policy.compatibility[`${repository}/terraform`].sourceDigest = digest;
  f.policy.compatibility[`${repository}/terraform-sub`] = {
    sourceDigest: digest, allowedTargets: [target],
    rationale: "Reviewed independent subscription-root required_version and overrides",
  };
  const result = await run(f);
  assert.equal(result.status, "would-propose");
  assert.deepEqual(result.changes, ["terraform-sub/.terraform-version", "terraform/.terraform-version"]);
  assert.equal(f.state.writes.length, 0);
});

test("discovers installed active nonfork owner repositories with bounded explicit selection", async () => {
  const rows = [
    { name: "target", owner: { login: "owner" }, archived: false, fork: false },
    { name: "archived", owner: { login: "owner" }, archived: true, fork: false },
    { name: "fork", owner: { login: "owner" }, archived: false, fork: true },
    { name: "unknown", owner: { login: "owner" } },
    { name: "other", owner: { login: "elsewhere" }, archived: false, fork: false },
  ];
  const api = { async pages() { return rows; } };
  assert.deepEqual(await discoverRepositories(api, "owner"), ["target"]);
  await assert.rejects(discoverRepositories(api, "owner", "archived"), /not an applicable/);
  await assert.rejects(discoverRepositories(api, "owner", "bad/name"), /Invalid/);
  assert.deepEqual(await discoverRepositories(api, "owner", "target"), ["target"]);
});

test("dry-run defaults to no writes; writes create exactly one atomic pin-only PR and repeat idempotently", async () => {
  const f = fixture();
  assert.equal((await run(f)).status, "would-propose");
  assert.equal(f.state.writes.length, 0);
  assert.equal((await run(f, { dryRun: false })).status, "created");
  assert.deepEqual(f.state.writes.map((write) => write.endpoint), [
    `/repos/${repository}/git/refs`, "/graphql", `/repos/${repository}/pulls`,
  ]);
  const count = f.state.writes.length;
  assert.equal((await run(f, { dryRun: false })).status, "unchanged");
  assert.equal(f.state.writes.length, count);
  assert.match(f.state.pulls[0].body, /Human review, real root validations\/plans/);
});

test("updates only the existing owned branch/PR for a newly reviewed target", async () => {
  const f = fixture();
  await run(f, { dryRun: false });
  f.policy.approvedTarget = "1.17.0";
  f.policy.approvedMinor = "1.17";
  f.policy.compatibility[`${repository}/terraform`].allowedTargets = ["1.17.0"];
  assert.equal((await run(f, { dryRun: false })).status, "updated");
  assert.equal(f.state.writes.filter((write) => write.endpoint.endsWith("/git/refs")).length, 1);
  assert.equal(f.state.writes.filter((write) => write.endpoint.endsWith("/pulls")).length, 1);
  assert.equal(f.state.writes.at(-1).endpoint, `/repos/${repository}/pulls/7`);
});

test("approved minor selects compatible stable patches only; future minors and restrictive constraints stay held", async () => {
  const f = fixture();
  const observed = ["2.0.0", "1.18.0", "1.17.0", "1.16.10", target, "1.16.6"];
  assert.equal(selectTarget(f.policy, observed), "1.16.10");
  assert.equal((await run(f, { releases: observed })).status, "blocked");
  f.policy.compatibility[`${repository}/terraform`].reviewedMinor = "1.16";
  const result = await run(f, { releases: observed });
  assert.equal(result.status, "would-propose");
  assert.equal(result.target, "1.16.10");
  f.policy.approvedMinor = "1.17";
  assert.throws(() => selectTarget(f.policy, observed), /Invalid central/);
});

test("duplicate, unowned, fork and orphan branches fail closed without writes", async () => {
  for (const scenario of ["duplicate", "unowned", "fork", "orphan"]) {
    const f = fixture();
    f.state.head = newSha;
    f.state.pulls = scenario === "orphan" ? [] : [f.makePr()];
    if (scenario === "duplicate") f.state.pulls.push(f.makePr());
    if (scenario === "unowned") f.state.pulls[0].user.login = "other[bot]";
    if (scenario === "fork") f.state.pulls[0].head.repo.full_name = "elsewhere/fork";
    await assert.rejects(run(f, { dryRun: false }), /Duplicate|not owned|Orphan/);
    assert.equal(f.state.writes.length, 0);
  }
});

test("existing branches with workflow/source/renamed/added files cannot be updated", async () => {
  for (const scenario of ["workflow", "source", "rename", "added"]) {
    const f = fixture();
    await run(f, { dryRun: false });
    const count = f.state.writes.length;
    if (scenario === "workflow") f.state.headTree.tree.push(file(".github/workflows/deploy.yml"));
    if (scenario === "source") f.state.headTree.tree[0].sha = "f".repeat(40);
    if (scenario === "rename") f.state.diff = [{ filename: "terraform/.terraform-version", status: "renamed", previous_filename: "old" }];
    if (scenario === "added") f.state.diff = [{ filename: "terraform/.terraform-version", status: "added" }];
    await assert.rejects(run(f, { dryRun: false }), /outside|added or removed|unapproved/);
    assert.equal(f.state.writes.length, count);
  }
});

test("default-base and PR races before writes abort without branch publication", async () => {
  for (const race of ["base", "pr"]) {
    const f = fixture();
    if (race === "base") f.state.onBaseRead = () => { if (f.state.refsRead === 2) f.state.base = newSha; };
    else f.state.onPullsRead = () => {
      if (f.state.pullsRead === 2) f.state.pulls = [f.makePr()];
    };
    await assert.rejects(run(f, { dryRun: false }), /branch raced|PR raced/);
    assert.equal(f.state.writes.length, 0);
  }
});

test("atomic head races fail closed and never force-push or create a PR", async () => {
  const f = fixture();
  f.state.rejectAtomic = true;
  await assert.rejects(run(f, { dryRun: false }), /atomic head race/);
  assert.equal(f.state.pulls.length, 0);
  assert.ok(f.state.writes.every((write) => !("force" in write.data)));
});

test("base change after atomic commit is reported incomplete, not published as a fresh reviewed PR", async () => {
  const f = fixture();
  f.state.onAtomic = () => { f.state.base = "f".repeat(40); };
  await assert.rejects(run(f, { dryRun: false }), /branch raced/);
  assert.equal(f.state.pulls.length, 0);
  assert.equal(f.state.writes.filter((write) => write.endpoint.endsWith("/pulls")).length, 0);
});

test("existing owned branch head racing before commit cannot be overwritten", async () => {
  const f = fixture();
  await run(f, { dryRun: false });
  f.policy.approvedTarget = "1.17.0";
  f.policy.approvedMinor = "1.17";
  f.policy.compatibility[`${repository}/terraform`].allowedTargets = ["1.17.0"];
  const count = f.state.writes.length;
  let reads = 0;
  f.state.onHeadRead = () => { if (++reads === 2) f.state.head = "f".repeat(40); };
  await assert.rejects(run(f, { dryRun: false }), /branch raced/);
  assert.equal(f.state.writes.length, count);
});

test("missing permissions and malformed target pins remain explicit errors, never writable proposals", async () => {
  const f = fixture(), get = f.api.get;
  f.api.get = async (endpoint) => {
    if (endpoint.includes("/git/blobs/")) throw Object.assign(new Error("fixture permissions denied"), { status: 403 });
    return get(endpoint);
  };
  await assert.rejects(run(f, { dryRun: false }), /permissions denied/);
  f.api.get = async (endpoint) => endpoint.includes("/git/blobs/") ? blob("latest\n") : get(endpoint);
  await assert.rejects(run(f, { dryRun: false }), /Invalid exact/);
  assert.equal(f.state.writes.length, 0);
});

test("bounded API paging never converts incomplete collections into empty/success", async () => {
  const api = new GitHubApi("fixture-token");
  api.get = async () => Array(100).fill({});
  await assert.rejects(api.pages("/fixture", null, 2), /pagination bound/);
  api.get = async () => ({ unexpected: [] });
  await assert.rejects(api.pages("/fixture"), /Invalid paginated/);
});

test("failed checks and latest commit statuses are reported without merge or deployment authority", async () => {
  const f = fixture();
  assert.equal((await checkSnapshot(f.api, repository, newSha)).state, "missing");
  f.state.checks = [{ status: "queued", conclusion: null }];
  assert.equal((await checkSnapshot(f.api, repository, newSha)).state, "pending");
  f.state.checks = [{ status: "completed", conclusion: "skipped" }];
  assert.equal((await checkSnapshot(f.api, repository, newSha)).state, "unknown");
  f.state.checks = [{ status: "completed", conclusion: "failure" }];
  assert.equal((await checkSnapshot(f.api, repository, newSha)).state, "failed");
  f.state.checks = [{ status: "completed", conclusion: "success" }];
  f.state.statuses = [{ id: 2, context: "plan", state: "success" }, { id: 1, context: "plan", state: "failure" }];
  assert.equal((await checkSnapshot(f.api, repository, newSha)).state, "observed-success");
  f.state.statuses.push({ id: 3, context: "plan", state: "error" });
  assert.equal((await checkSnapshot(f.api, repository, newSha)).state, "failed");
  assert.equal(f.state.writes.length, 0);
});

test("scheduled/manual writer admission stays opt-in; no target checkout, workflow permission or merge primitive", async () => {
  const workflow = await readFile(new URL("../.github/workflows/terraform-cli-updates.yml", import.meta.url), "utf8");
  const source = await readFile(new URL("./terraform-cli.mjs", import.meta.url), "utf8");
  assert.match(workflow, /cron: "37 0 \* \* 0"/);
  assert.match(workflow, /TF_CLI_UPDATES_ENABLED == 'true'/);
  assert.match(workflow, /permission-metadata: read/);
  assert.match(workflow, /repositories: \$\{\{ matrix.repo \}\}/);
  assert.doesNotMatch(workflow, /permission-(workflows|actions|id-token):/);
  assert.doesNotMatch(source, /child_process|execSync|spawn\(|\/merge\b|force:\s*true/);
  validatePolicy(JSON.parse(await readFile(new URL("./terraform-cli-policy.json", import.meta.url), "utf8")));
});
