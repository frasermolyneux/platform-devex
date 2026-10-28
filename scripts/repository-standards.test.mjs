import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  BRANCH,
  CONTRACT_VERSION,
  MARKER,
  discoverRepositories,
  generateManagedFiles,
  graphemeLength,
  isIncompleteStatus,
  reconcile,
  renderCheckov,
  validateCatalog,
  validateContract,
  validatePolicy,
} from "./repository-standards.mjs";

const repository = "owner/target";
const bot = "standards[bot]";
const baseSha = "a".repeat(40);
const oldHeadSha = "b".repeat(40);
const newHeadSha = "c".repeat(40);
const sourceBlobSha = "d".repeat(40);
const generatedBlobSha = "e".repeat(40);
const policy = JSON.parse(await readFile(new URL("../standards/checkov/v1.json", import.meta.url), "utf8"));

function contract(overrides = {}) {
  return {
    version: CONTRACT_VERSION,
    managedFiles: {
      checkov: {
        version: "checkov-v1",
        profiles: ["base"],
        exceptions: [{
          rule: "CKV_OPENAPI_21",
          reason: "Approved because this repository uses the shared platform control.",
        }],
        ...overrides,
      },
    },
  };
}

function tree(entries = []) {
  return { truncated: false, tree: entries };
}

function file(path, sha) {
  return { path, sha, mode: "100644", type: "blob" };
}

function blob(content) {
  return {
    encoding: "base64",
    size: Buffer.byteLength(content),
    content: Buffer.from(content).toString("base64"),
  };
}

function fixture({ declaredContract = contract(), current = null, head = null, pull = null } = {}) {
  const expected = generateManagedFiles(declaredContract, policy)[0]?.content ?? null;
  const state = {
    meta: { full_name: repository, archived: false, fork: false, default_branch: "main" },
    base: baseSha,
    current,
    head,
    pull,
    writes: [],
    baseReads: 0,
    pullsReads: 0,
    headContent: head ? expected : null,
    unrelated: [],
  };
  const makePull = (data = {}) => ({
    number: 7,
    state: "open",
    user: { type: "Bot", login: bot },
    title: "old title",
    body: `${MARKER}\nold`,
    head: { ref: BRANCH, sha: state.head, repo: { full_name: repository } },
    base: { ref: "main", sha: state.base, repo: { full_name: repository } },
    ...data,
  });
  if (state.pull === true) state.pull = makePull();
  const api = {
    async get(endpoint) {
      state.onGet?.(endpoint);
      if (endpoint === `/repos/${repository}`) return structuredClone(state.meta);
      if (endpoint.endsWith("/git/ref/heads/main")) {
        state.baseReads++;
        state.onBaseRead?.();
        return { object: { sha: state.base } };
      }
      if (endpoint.endsWith(`/git/ref/heads/${encodeURIComponent(BRANCH)}`)) {
        state.onHeadRead?.();
        if (!state.head) throw Object.assign(new Error("not found"), { status: 404 });
        return { object: { sha: state.head } };
      }
      if (endpoint === `/repos/${repository}/git/trees/${state.base}?recursive=1`) {
        return tree([
          ...(state.current === null ? [] : [file(".checkov.yml", sourceBlobSha)]),
          ...state.unrelated,
        ]);
      }
      if (endpoint === `/repos/${repository}/git/trees/${state.head}?recursive=1`) {
        return tree([file(".checkov.yml", generatedBlobSha)]);
      }
      if (endpoint.endsWith(`/git/blobs/${sourceBlobSha}`)) return blob(state.current);
      if (endpoint.endsWith(`/git/blobs/${generatedBlobSha}`)) return blob(state.headContent);
      if (endpoint.includes("/compare/")) {
        const comparison = {
          status: state.compare?.status ?? "ahead",
          ahead_by: state.compare?.ahead_by ?? 1,
          behind_by: state.compare?.behind_by ?? 0,
          base_commit: { sha: state.compare?.baseSha ?? state.base },
          merge_base_commit: { sha: state.compare?.mergeBaseSha ?? state.base },
          files: state.diff ?? [{ filename: ".checkov.yml", status: state.current === null ? "added" : "modified" }],
        };
        state.onCompare?.();
        return comparison;
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    },
    async pages(endpoint) {
      assert.equal(endpoint, `/repos/${repository}/pulls?state=open`);
      state.pullsReads++;
      state.onPullsRead?.();
      return state.pull ? [structuredClone(state.pull)] : [];
    },
    async post(endpoint, data) {
      state.writes.push({ method: "POST", endpoint, data });
      if (endpoint.endsWith("/git/refs")) {
        state.head = data.sha;
        return {};
      }
      assert.ok(endpoint.endsWith("/pulls"));
      state.pull = makePull({ title: data.title, body: data.body });
      state.onPublish?.();
      return structuredClone(state.pull);
    },
    async patch(endpoint, data) {
      state.writes.push({ method: "PATCH", endpoint, data });
      assert.equal(endpoint, `/repos/${repository}/pulls/7`);
      state.pull = makePull({ title: data.title, body: data.body });
      state.onPublish?.();
      return structuredClone(state.pull);
    },
    async graphql(query, { input }) {
      state.writes.push({ method: "GRAPHQL", endpoint: "/graphql", data: input });
      assert.match(query, /createCommitOnBranch/);
      assert.equal(input.expectedHeadOid, state.head);
      assert.deepEqual(input.fileChanges.additions.map((item) => item.path), [".checkov.yml"]);
      state.head = newHeadSha;
      state.headContent = Buffer.from(input.fileChanges.additions[0].contents, "base64").toString("utf8");
      if (state.pull) state.pull = makePull();
      state.onCommit?.();
      return { createCommitOnBranch: { commit: { oid: newHeadSha } } };
    },
  };
  return { api, state, expected, makePull, contract: declaredContract };
}

function run(f, extra = {}) {
  return reconcile({ api: f.api, repository, bot, policy, contract: f.contract, ...extra });
}

test("canonical policy contains the approved profiles and exact ordered rules", () => {
  validatePolicy(policy);
  assert.equal(policy.version, "checkov-v1");
  assert.deepEqual(policy.exceptionRules, ["CKV_OPENAPI_21", "CKV_SECRET_6"]);
  assert.deepEqual(Object.fromEntries(policy.profiles.map((profile) => [profile.name, profile.rules])), {
    base: ["CKV_AZURE_41", "CKV_AZURE_114", "CKV_GHA_7", "CKV_GIT_1"],
    "cost-optimised": ["CKV2_AZURE_1", "CKV2_AZURE_22", "CKV_AZURE_199", "CKV_AZURE_201",
      "CKV_AZURE_206", "CKV_AZURE_212", "CKV_AZURE_225", "CKV_AZURE_229", "CKV_AZURE_233",
      "CKV_AZURE_165", "CKV_AZURE_211", "CKV_AZURE_188", "CKV_AZURE_224"],
    "cost-optimised-resource-scoped": ["CKV2_AZURE_1", "CKV2_AZURE_22", "CKV_AZURE_199", "CKV_AZURE_201",
      "CKV_AZURE_206", "CKV_AZURE_212", "CKV_AZURE_229", "CKV_AZURE_233",
      "CKV_AZURE_165", "CKV_AZURE_211", "CKV_AZURE_188", "CKV_AZURE_224"],
    "public-endpoints": ["CKV2_AZURE_33", "CKV_AZURE_109", "CKV_AZURE_189", "CKV2_AZURE_32",
      "CKV_AZURE_222", "CKV_AZURE_221", "CKV_AZURE_107", "CKV_AZURE_174", "CKV_AZURE_134",
      "CKV_AZURE_139", "CKV_AZURE_204", "CKV_AZURE_113", "CKV2_AZURE_45"],
    "public-endpoints-resource-scoped": ["CKV_AZURE_109", "CKV_AZURE_189", "CKV2_AZURE_32",
      "CKV_AZURE_222", "CKV_AZURE_221", "CKV_AZURE_107", "CKV_AZURE_174", "CKV_AZURE_134",
      "CKV_AZURE_139", "CKV_AZURE_204", "CKV_AZURE_113", "CKV2_AZURE_45"],
    "app-service-standard": ["CKV_AZURE_88", "CKV_AZURE_13", "CKV_AZURE_17"],
    "central-observability": ["CKV_AZURE_33", "CKV2_AZURE_21", "CKV2_AZURE_20", "CKV_AZURE_63",
      "CKV_AZURE_65", "CKV_AZURE_66", "CKV_AZURE_24"],
  });
});

test("resource-scoped profiles leave only their specific control enforced without changing other exemptions", () => {
  for (const [original, enforced] of [
    ["cost-optimised", "CKV_AZURE_225"],
    ["public-endpoints", "CKV2_AZURE_33"],
  ]) {
    const profiles = ["base", "cost-optimised", "public-endpoints", "app-service-standard", "central-observability"];
    const baseline = renderCheckov(contract({ profiles, exceptions: [] }).managedFiles.checkov, policy);
    const scoped = renderCheckov(contract({
      profiles: profiles.map((name) => name === original ? `${name}-resource-scoped` : name),
      exceptions: [],
    }).managedFiles.checkov, policy);
    const rules = (text) => [...text.matchAll(/^  - (\S+)$/gm)].map((match) => match[1]);
    assert.deepEqual(rules(scoped), rules(baseline).filter((rule) => rule !== enforced));
    assert.ok(scoped.indexOf(`# Profile: ${original}-resource-scoped`) <
      scoped.indexOf("# Profile: app-service-standard"));
    assert.throws(() => renderCheckov(contract({
      profiles: [original, `${original}-resource-scoped`],
      exceptions: [],
    }).managedFiles.checkov, policy), /cannot be combined/);
    assert.throws(() => renderCheckov(contract({
      profiles: [`${original}-resource-scoped`],
      exceptions: [{ rule: enforced, reason: "This control must remain scoped to the target resource." }],
    }).managedFiles.checkov, policy), /unsupported/);
  }
});

test("renders deterministic fail-closed compact Checkov configuration with provenance and reasons", () => {
  const rendered = renderCheckov(contract().managedFiles.checkov, policy);
  assert.match(rendered, /^# Managed by platform-devex repository standards/m);
  assert.match(rendered, /repository-standards-v1 \/ checkov-v1/);
  assert.match(rendered, /^soft-fail: false$/m);
  assert.match(rendered, /^compact: true$/m);
  assert.match(rendered, /# Profile: base\n  - CKV_AZURE_41\n  - CKV_AZURE_114\n  - CKV_GHA_7\n  - CKV_GIT_1/);
  assert.match(rendered, /# Approved repository exceptions\n  - CKV_OPENAPI_21 # Approved because/);
  assert.equal(rendered, generateManagedFiles(contract(), policy)[0].content);

  const ordered = renderCheckov(contract({ exceptions: [
    { rule: "CKV_SECRET_6", reason: "The reviewed test fixture contains a documented placeholder secret." },
    { rule: "CKV_OPENAPI_21", reason: "The generated document cannot express the reviewed constraint." },
  ] }).managedFiles.checkov, policy);
  assert.ok(ordered.indexOf("CKV_OPENAPI_21") < ordered.indexOf("CKV_SECRET_6"));
});

test("deduplicates overlapping profile rules while preserving canonical profile order", () => {
  const custom = structuredClone(policy);
  custom.profiles[1].rules.unshift("CKV_AZURE_41");
  const rendered = renderCheckov(contract({ profiles: ["cost-optimised", "base"], exceptions: [] })
    .managedFiles.checkov, custom);
  assert.ok(rendered.indexOf("# Profile: base") < rendered.indexOf("# Profile: cost-optimised"));
  assert.equal(rendered.match(/- CKV_AZURE_41/g)?.length, 1);
});

test("contract validation rejects unknown versions, profiles, unsafe paths and malformed exceptions", () => {
  const cases = [
    { value: { ...contract(), version: "repository-standards-v2" }, message: /Invalid repository/ },
    { value: contract({ version: "checkov-v2" }), message: /Unknown managed/ },
    { value: contract({ profiles: ["unknown"] }), message: /profile/ },
    { value: contract({ path: "../.checkov.yml" }), message: /declaration/ },
    { value: contract({ exceptions: [
      { rule: "CKV_OPENAPI_21", reason: "A sufficiently detailed reason." },
      { rule: "CKV_OPENAPI_21", reason: "Another sufficiently detailed reason." },
    ] }), message: /Duplicate/ },
    { value: contract({ exceptions: [{ rule: "CKV_AZURE_199", reason: "A sufficiently detailed reason." }] }),
      message: /unsupported/ },
    { value: contract({ exceptions: [{ rule: "CKV_OPENAPI_21", reason: "short" }] }), message: /malformed/ },
    { value: contract({ exceptions: [{
      rule: "CKV_OPENAPI_21", reason: `A${"x".repeat(600)}`,
    }] }), message: /malformed/ },
    { value: { ...contract(), managedFiles: [] }, message: /Invalid repository/ },
    { value: { ...contract(), managedFiles: { unknown: {} } }, message: /Invalid repository/ },
    { value: { ...contract(), managedFiles: { checkov: null } }, message: /declaration/ },
  ];
  for (const { value, message } of cases) assert.throws(() => validateContract(value, policy), message);

  const overlapping = structuredClone(policy);
  overlapping.exceptionRules.push("CKV_AZURE_41");
  assert.throws(() => validateContract(contract({ exceptions: [{
    rule: "CKV_AZURE_41", reason: "Already selected by the base profile.",
  }] }), overlapping), /Duplicate/);

  const longest = "x".repeat(600);
  assert.doesNotThrow(() => validateContract(contract({ exceptions: [{
    rule: "CKV_SECRET_6", reason: longest,
  }] }), policy));
  for (const separator of ["\u007f", "\u0080", "\u0085", "\u009f", "\u2028", "\u2029",
    "\ud800", "\udfff", "\ufffe", "\uffff"]) {
    assert.throws(() => validateContract(contract({ exceptions: [{
      rule: "CKV_SECRET_6", reason: `Meaningful before${separator}meaningful after`,
    }] }), policy), /malformed/);
  }
  const normalUnicode = contract({ exceptions: [{
    rule: "CKV_SECRET_6",
    reason: "Reviewed café configuration – 日本語 and emoji 🚀 remain valid Unicode.",
  }] });
  assert.doesNotThrow(() => validateContract(normalUnicode, policy));
  assert.match(renderCheckov(normalUnicode.managedFiles.checkov, policy), /emoji 🚀 remain valid Unicode/);

  assert.equal(graphemeLength("12345678🚀"), 9);
  assert.throws(() => validateContract(contract({ exceptions: [{
    rule: "CKV_SECRET_6", reason: "12345678🚀",
  }] }), policy), /malformed/);
  assert.equal(graphemeLength("123456789🚀"), 10);
  assert.doesNotThrow(() => validateContract(contract({ exceptions: [{
    rule: "CKV_SECRET_6", reason: "123456789🚀",
  }] }), policy));
  assert.equal(graphemeLength(`${"x".repeat(599)}🚀`), 600);
  assert.doesNotThrow(() => validateContract(contract({ exceptions: [{
    rule: "CKV_SECRET_6", reason: `${"x".repeat(599)}🚀`,
  }] }), policy));
  assert.equal(graphemeLength(`${"x".repeat(600)}🚀`), 601);
  assert.throws(() => validateContract(contract({ exceptions: [{
    rule: "CKV_SECRET_6", reason: `${"x".repeat(600)}🚀`,
  }] }), policy), /malformed/);
});

test("catalog validation is bounded and maps exact valid repository names to validated contracts", () => {
  const value = JSON.stringify({
    alpha: contract(),
    "repo.with-dots": { version: CONTRACT_VERSION, managedFiles: {} },
  });
  const catalog = validateCatalog(value, policy);
  assert.deepEqual(Object.keys(catalog), ["alpha", "repo.with-dots"]);
  assert.deepEqual(catalog.alpha, contract());

  for (const invalid of [
    "",
    "[]",
    JSON.stringify({ "bad/name": contract() }),
    JSON.stringify({ alpha: { ...contract(), extra: true } }),
  ]) {
    assert.throws(() => validateCatalog(invalid, policy), /catalog|repository standards contract/i);
  }
  assert.throws(() => validateCatalog("x".repeat(48 * 1024 + 1), policy), /byte bound/);
  assert.throws(() => validateCatalog(JSON.stringify(Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [`repo-${index}`, { version: CONTRACT_VERSION, managedFiles: {} }]),
  )), policy), /entry bound/);
});

test("explicitly skips declared contracts with no managed files", async () => {
  const empty = fixture({ declaredContract: { version: CONTRACT_VERSION, managedFiles: {} } });
  assert.equal((await reconcile({ ...empty, repository, bot, policy })).status, "skipped-no-managed-files");
  assert.equal(empty.state.writes.length, 0);
});

test("reports current content as a no-op", async () => {
  const f = fixture();
  f.state.current = f.expected;
  const result = await run(f);
  assert.equal(result.status, "current");
  assert.deepEqual(result.changes, []);
  assert.equal(f.state.writes.length, 0);
});

test("accepts unrelated valid Git paths containing spaces, brackets and Unicode", async () => {
  const f = fixture();
  f.state.current = f.expected;
  f.state.unrelated = [
    file("docs/file with spaces.md", "1".repeat(40)),
    file("src/[generated]/contract.json", "2".repeat(40)),
    file("資料/überblick.txt", "3".repeat(40)),
  ];
  assert.equal((await run(f)).status, "current");

  f.state.unrelated.push(file("", "4".repeat(40)));
  await assert.rejects(run(f), /tree entry/);
  f.state.unrelated.pop();
  f.state.unrelated.push(file("invalid\0path", "4".repeat(40)));
  await assert.rejects(run(f), /tree entry/);
});

test("dry run reports drift without creating a branch or pull request", async () => {
  const f = fixture({ current: "soft-fail: true\n" });
  const result = await run(f, { dryRun: true });
  assert.equal(result.status, "would-propose");
  assert.deepEqual(result.changes, [".checkov.yml"]);
  assert.equal(f.state.writes.length, 0);
});

test("creates an owned branch and pull request without writing the default branch", async () => {
  const f = fixture({ current: "soft-fail: true\n" });
  const result = await run(f, { dryRun: false });
  assert.equal(result.status, "created");
  assert.equal(result.headSha, newHeadSha);
  assert.equal(result.pullRequest, 7);
  assert.deepEqual(f.state.writes.map((write) => write.endpoint), [
    `/repos/${repository}/git/refs`,
    "/graphql",
    `/repos/${repository}/pulls`,
  ]);
  assert.equal(f.state.writes[0].data.ref, `refs/heads/${BRANCH}`);
  assert.equal(f.state.writes[0].data.sha, baseSha);
  assert.equal(f.state.writes[2].data.base, "main");
  assert.equal(f.state.writes[2].data.head, BRANCH);
  assert.doesNotMatch(JSON.stringify(f.state.writes), /refs\/heads\/main/);
});

test("updates only an App-owned branch and pull request", async () => {
  const f = fixture({ current: "old\n", head: oldHeadSha, pull: true });
  f.state.headContent = "older proposal\n";
  const result = await run(f, { dryRun: false });
  assert.equal(result.status, "updated");
  assert.deepEqual(f.state.writes.map((write) => write.endpoint), [
    "/graphql",
    `/repos/${repository}/pulls/7`,
  ]);
});

test("refreshes metadata without another commit when owned branch content is exact", async () => {
  const f = fixture({ current: "old\n", head: oldHeadSha, pull: true });
  f.state.headContent = f.expected;
  const result = await run(f, { dryRun: false });
  assert.equal(result.status, "metadata-updated");
  assert.deepEqual(f.state.writes.map((write) => write.method), ["PATCH"]);
});

test("reports an owned diverged proposal as stale without writes even when its final tree is expected", async () => {
  const configureDivergence = (f) => {
    f.state.headContent = f.expected;
    f.state.compare = {
      status: "diverged",
      ahead_by: 1,
      behind_by: 2,
      mergeBaseSha: "f".repeat(40),
    };
  };

  const dry = fixture({ current: "unsafe default-side edit\n", head: oldHeadSha, pull: true });
  configureDivergence(dry);
  const preview = await run(dry, { dryRun: true });
  assert.equal(preview.status, "stale-pr-needs-branch-update");
  assert.equal(preview.ancestry.current, false);
  assert.equal(dry.state.writes.length, 0);

  const f = fixture({ current: "unsafe default-side edit\n", head: oldHeadSha, pull: true });
  configureDivergence(f);
  const result = await run(f, { dryRun: false });
  assert.equal(result.status, "stale-pr-needs-branch-update");
  assert.equal(f.state.writes.length, 0);
});

test("a concurrent push before stale handling cannot be overwritten because no ref update is attempted", async () => {
  const f = fixture({ current: "unsafe default-side edit\n", head: oldHeadSha, pull: true });
  f.state.headContent = f.expected;
  f.state.compare = {
    status: "diverged",
    ahead_by: 1,
    behind_by: 1,
    mergeBaseSha: "f".repeat(40),
  };
  f.state.onCompare = () => {
    f.state.head = "9".repeat(40);
    f.state.pull = f.makePull();
  };
  const result = await run(f, { dryRun: false });
  assert.equal(result.status, "stale-pr-needs-branch-update");
  assert.equal(f.state.head, "9".repeat(40));
  assert.equal(f.state.writes.length, 0);

  const source = await readFile(new URL("./repository-standards.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /force:\s*true|git\/refs\/heads/);
  assert.equal(isIncompleteStatus("stale-pr-needs-branch-update"), true);
});

test("rejects incomplete or inconsistent comparison ancestry", async () => {
  const f = fixture({ current: "old\n", head: oldHeadSha, pull: true });
  f.state.compare = { status: "ahead", ahead_by: 1, behind_by: 1, mergeBaseSha: baseSha };
  await assert.rejects(run(f), /comparison ancestry/);
  assert.equal(f.state.writes.length, 0);
});

test("refuses human branches, human pull requests and changes outside managed paths", async () => {
  const human = fixture({ current: "old\n", head: oldHeadSha, pull: true });
  human.state.pull.user = { type: "User", login: "human" };
  await assert.rejects(run(human), /not owned/);

  const extra = fixture({ current: "old\n", head: oldHeadSha, pull: true });
  extra.state.diff = [{ filename: "README.md", status: "modified" }];
  await assert.rejects(run(extra), /unowned changes/);

  const orphan = fixture({ current: "old\n", head: oldHeadSha });
  await assert.rejects(run(orphan), /Orphan/);
});

test("fails closed on GitHub API errors", async () => {
  const f = fixture();
  f.api.get = async () => { throw Object.assign(new Error("API unavailable"), { status: 503 }); };
  await assert.rejects(run(f), /API unavailable/);
});

test("rechecks repository identity and default branch source before writes", async () => {
  const identity = fixture({ current: "old\n" });
  let metadataReads = 0;
  identity.state.onGet = (endpoint) => {
    if (endpoint === `/repos/${repository}` && ++metadataReads === 2) {
      identity.state.meta.default_branch = "trunk";
    }
  };
  await assert.rejects(run(identity, { dryRun: false }),
    /default branch changed/);
  assert.equal(identity.state.writes.length, 0);

  const source = fixture({ current: "old\n" });
  source.state.onBaseRead = () => {
    if (source.state.baseReads === 2) source.state.base = "f".repeat(40);
  };
  await assert.rejects(run(source, { dryRun: false }),
    /Default branch source changed/);
  assert.equal(source.state.writes.length, 0);

});

test("treats the supplied catalog contract as immutable trusted input and never calls Variables APIs", async () => {
  const f = fixture({ current: "old\n" });
  const result = await run(f, { dryRun: false });
  assert.equal(result.status, "created");
  assert.equal(f.state.writes.length, 3);
  const source = await readFile(new URL("./repository-standards.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /actions\/variables|variableSnapshot|REPOSITORY_STANDARDS(?!_(?:CATALOG|CONTRACT))/);
});

test("rejects a pull request race before publishing", async () => {
  const f = fixture({ current: "old\n", head: oldHeadSha, pull: true });
  f.state.headContent = "older proposal\n";
  f.state.onCommit = () => { f.state.pull.number = 8; };
  await assert.rejects(run(f, { dryRun: false }),
    /pull request changed/);
  assert.equal(f.state.writes.some((write) => write.method === "PATCH"), false);
});

test("discovers bounded active installation repositories and validates selection", async () => {
  const api = { pages: async () => [
    { name: "zeta", archived: false, fork: false, owner: { login: "owner" } },
    { name: "alpha", archived: false, fork: false, owner: { login: "OWNER" } },
    { name: "archived", archived: true, fork: false, owner: { login: "owner" } },
    { name: "fork", archived: false, fork: true, owner: { login: "owner" } },
    { name: "foreign", archived: false, fork: false, owner: { login: "other" } },
    { name: "uncatalogued", archived: false, fork: false, owner: { login: "owner" } },
  ] };
  const catalog = { alpha: contract(), zeta: contract(), declaredOnly: contract() };
  assert.deepEqual(await discoverRepositories(api, "owner", "", catalog), [
    { repo: "alpha", contract: catalog.alpha },
    { repo: "zeta", contract: catalog.zeta },
  ]);
  assert.deepEqual(await discoverRepositories(api, "owner", "zeta", catalog), [
    { repo: "zeta", contract: catalog.zeta },
  ]);
  await assert.rejects(discoverRepositories(api, "owner", "missing", catalog), /not declared/);
  await assert.rejects(discoverRepositories(api, "owner", "declaredOnly", catalog), /not an applicable/);
});

test("workflow is least-privilege, bounded, dry by default and never checks out target code", async () => {
  const workflow = await readFile(new URL("../.github/workflows/repository-standards.yml", import.meta.url), "utf8");
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /dry_run:[\s\S]*default: true/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /max-parallel: 4/);
  assert.equal(workflow.match(/actions\/create-github-app-token@/g)?.length, 1);
  assert.doesNotMatch(workflow, /permission-variables:/);
  assert.doesNotMatch(workflow, /actions\/variables|REPOSITORY_STANDARDS(?!_)/);
  assert.match(workflow, /run: node scripts\/repository-standards-token\.mjs/);
  assert.match(workflow, /GH_APP_INSTALLATION_ID: \$\{\{ vars\.GH_APP_INSTALLATION_ID \}\}/);
  assert.match(workflow, /REPOSITORY_STANDARDS_ENABLED: \$\{\{ vars\.REPOSITORY_STANDARDS_ENABLED \}\}/);
  assert.match(workflow, /REPOSITORY_STANDARDS_CATALOG: \$\{\{ vars\.REPOSITORY_STANDARDS_CATALOG \}\}/);
  assert.match(workflow, /REPOSITORY_STANDARDS_CONTRACT: \$\{\{ toJson\(matrix\.target\.contract\) \}\}/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.repository-token\.outputs\.token \}\}/);
  assert.match(workflow, /APP_BOT: \$\{\{ steps\.repository-token\.outputs\['app-bot'\] \}\}/);
  assert.match(workflow, /DRY_RUN: \$\{\{ steps\.repository-token\.outputs\['dry-run'\] \}\}/);
  assert.doesNotMatch(workflow, /REPOSITORY_STANDARDS_ENABLED\s*==/);
  assert.match(workflow, /repository: \$\{\{ github\.repository \}\}/);
  assert.doesNotMatch(workflow, /repository: \$\{\{ matrix\.target\.repo \}\}/);
  assert.doesNotMatch(workflow, /merge-multiple:\s*true/);
  assert.match(workflow, /\.status != "current" and \.status != "unchanged" and \.status != "skipped-no-managed-files"/);
  assert.match(workflow, /Ensure metadata-only failure result[\s\S]*repository-token-issuance-failed/);
  assert.doesNotMatch(workflow, /\bgh\s+pr\s+merge\b|\/merges\b|enablePullRequestAutoMerge/);
  for (const reference of workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
    assert.match(reference[1], /^[a-f0-9]{40}$/, `action is not pinned by full SHA: ${reference[0]}`);
  }
});
