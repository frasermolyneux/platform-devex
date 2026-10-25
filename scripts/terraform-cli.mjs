import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const BRANCH = "automation/terraform-cli";
export const MARKER = "<!-- platform-devex-terraform-cli-v1 -->";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MINOR = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_ROOTS = 32;
const MAX_SOURCE_FILES = 2048;
const MAX_ENTRIES = 20000;
const MAX_BYTES = 2 * 1024 * 1024;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function pinVersion(value) {
  requireThat(typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\r?\n)?$/.test(value),
    "Invalid exact stable Terraform pin");
  return value.trim();
}

export function compareVersions(left, right) {
  requireThat(VERSION.test(left) && VERSION.test(right), "Invalid stable release");
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function stableReleases(releases) {
  requireThat(Array.isArray(releases) && releases.length <= 100, "Invalid official release response");
  return [...new Set(releases.filter((release) => release.draft === false && release.prerelease === false &&
    typeof release.tag_name === "string" && /^v/.test(release.tag_name) && VERSION.test(release.tag_name.slice(1)))
    .map((release) => release.tag_name.slice(1)))].sort((a, b) => compareVersions(b, a));
}

export function validatePolicy(policy) {
  requireThat(policy?.schemaVersion === 1 && (policy.approvedTarget === null ||
    (typeof policy.approvedTarget === "string" && VERSION.test(policy.approvedTarget))) &&
    (policy.approvedTarget === null ? policy.approvedMinor === null :
      typeof policy.approvedMinor === "string" && MINOR.test(policy.approvedMinor) &&
      policy.approvedTarget.startsWith(`${policy.approvedMinor}.`)) &&
    typeof policy.approval === "string" && policy.approval.trim().length >= 20 &&
    policy.compatibility && typeof policy.compatibility === "object" && !Array.isArray(policy.compatibility),
  "Invalid central Terraform policy");
  for (const [key, review] of Object.entries(policy.compatibility)) {
    requireThat(key.length <= 300 && /^[A-Za-z0-9_.\/-]+$/.test(key) &&
      /^[a-f0-9]{64}$/.test(review?.sourceDigest) &&
      (review.reviewedMinor === undefined || typeof review.reviewedMinor === "string" && MINOR.test(review.reviewedMinor)) &&
      Array.isArray(review.allowedTargets) && review.allowedTargets.length <= 10 &&
      review.allowedTargets.every((version) => typeof version === "string" && VERSION.test(version)) &&
      (review.allowedTargets.length > 0 || review.reviewedMinor !== undefined) &&
      typeof review.rationale === "string" && review.rationale.trim().length >= 20,
    "Invalid compatibility review");
  }
  return policy;
}

export function selectTarget(policy, releases) {
  validatePolicy(policy);
  if (policy.approvedTarget === null) return null;
  requireThat(releases.includes(policy.approvedTarget), "Approved baseline absent from bounded official stable releases");
  return releases.filter((version) => version.startsWith(`${policy.approvedMinor}.`) &&
    compareVersions(version, policy.approvedTarget) >= 0).sort((a, b) => compareVersions(b, a))[0];
}

export function rootSources(tree) {
  requireThat(tree?.truncated === false && Array.isArray(tree.tree) && tree.tree.length <= MAX_ENTRIES,
    "Incomplete or oversized repository tree");
  const paths = new Set();
  for (const item of tree.tree) {
    requireThat(typeof item.path === "string" && item.path.length <= 500 && !paths.has(item.path) &&
      !item.path.split("/").some((part) => part === ".." || part === "." || part === "") &&
      SHA.test(item.sha), "Invalid repository tree entry");
    paths.add(item.path);
  }
  const pins = tree.tree.filter((item) => item.path === ".terraform-version" || item.path.endsWith("/.terraform-version"));
  requireThat(pins.length <= MAX_ROOTS, "Too many Terraform roots");
  const compatibilityFiles = tree.tree.filter((item) => item.path.endsWith(".tf") || item.path.endsWith(".tf.json"))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  requireThat(pins.length === 0 || compatibilityFiles.length <= MAX_SOURCE_FILES &&
    compatibilityFiles.every((item) => item.type === "blob" && item.mode === "100644"),
  "Incomplete or oversized repository Terraform compatibility sources");
  return pins.map((pin) => {
    requireThat(pin.type === "blob" && pin.mode === "100644" && /^[A-Za-z0-9_.\/-]+$/.test(pin.path) &&
      !pin.path.split("/").some((part) => [".git", ".github", ".terraform", "node_modules", "vendor"].includes(part)),
    "Unsafe Terraform pin path");
    const root = pin.path.includes("/") ? pin.path.slice(0, pin.path.lastIndexOf("/")) : ".";
    const files = tree.tree.filter((item) => {
      const parent = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : ".";
      return parent === root && (item.path.endsWith(".tf") || item.path.endsWith(".tf.json"));
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    requireThat(files.length > 0 && files.length <= 512 &&
      files.every((item) => item.type === "blob" && item.mode === "100644"),
    "Pin has no bounded regular Terraform root sources");
    return { root, pin, files, compatibilityFiles };
  }).sort((a, b) => a.pin.path < b.pin.path ? -1 : a.pin.path > b.pin.path ? 1 : 0);
}

// Bind all repository Terraform sources, including local modules and overrides.
// No partial HCL parser or target interpreter is trusted to prove compatibility.
export function sourceDigest(files) {
  return createHash("sha256").update(JSON.stringify(files.map(({ path, sha }) => [path, sha]))).digest("hex");
}

export async function planUpdate({ api, repository, baseSha, policy, releases }) {
  validatePolicy(policy);
  requireThat(SHA.test(baseSha), "Invalid base identity");
  const tree = await api.get(`/repos/${repository}/git/trees/${baseSha}?recursive=1`);
  const roots = rootSources(tree);
  const changes = [], observations = [], blocked = [];
  const target = selectTarget(policy, releases);
  for (const { root, pin, compatibilityFiles } of roots) {
    const blob = await api.get(`/repos/${repository}/git/blobs/${pin.sha}`);
    requireThat(blob.encoding === "base64" && blob.size <= 64 && typeof blob.content === "string",
      "Invalid pin blob");
    const current = pinVersion(Buffer.from(blob.content, "base64").toString("utf8"));
    const digest = sourceDigest(compatibilityFiles);
    const review = policy.compatibility[`${repository}/${root}`];
    const compatible = review?.sourceDigest === digest &&
      (review.allowedTargets.includes(target) || target?.startsWith(`${review.reviewedMinor}.`));
    observations.push({ root, current, sourceDigest: digest, compatibility: compatible ? "reviewed" : "unknown" });
    if (target === null) { blocked.push(`${root}: no centrally approved target`); continue; }
    if (compareVersions(current, target) > 0) { blocked.push(`${root}: downgrade refused`); continue; }
    if (current === target) continue;
    if (!compatible) {
      blocked.push(`${root}: unknown or incompatible reviewed constraints`);
      continue;
    }
    changes.push({ path: pin.path, content: `${target}\n` });
  }
  return { baseSha, tree, observations, changes, blocked, target };
}

export async function discoverRepositories(api, owner, selected = "") {
  requireThat(/^[A-Za-z0-9-]+$/.test(owner) && (!selected || /^[A-Za-z0-9_.-]+$/.test(selected)),
    "Invalid repository selection");
  const rows = await api.pages("/installation/repositories", "repositories", 10);
  const names = rows.filter((repo) => repo.archived === false && repo.fork === false &&
    repo.owner?.login?.toLowerCase() === owner.toLowerCase()).map((repo) => {
    requireThat(/^[A-Za-z0-9_.-]+$/.test(repo.name), "Invalid installation repository name");
    return repo.name;
  });
  requireThat(names.length <= 256, "Repository matrix exceeds bound");
  requireThat(!selected || names.includes(selected), "Selected repository is not an applicable installation repository");
  return [...new Set(names)].filter((name) => !selected || name === selected).sort();
}

function refPath(repository, branch) {
  return `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`;
}

async function optionalRef(api, repository, branch) {
  try { return await api.get(refPath(repository, branch)); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

async function openPulls(api, repository) {
  return api.pages(`/repos/${repository}/pulls?state=open`, null, 10);
}

export async function checkSnapshot(api, repository, sha) {
  requireThat(SHA.test(sha), "Invalid check head");
  const checks = await api.pages(`/repos/${repository}/commits/${sha}/check-runs?filter=latest`, "check_runs", 10);
  const statuses = await api.pages(`/repos/${repository}/commits/${sha}/statuses`, null, 10);
  const contexts = new Map();
  for (const status of statuses) {
    requireThat(typeof status.context === "string" && Number.isSafeInteger(status.id), "Invalid commit status metadata");
    if (!contexts.has(status.context) || contexts.get(status.context).id < status.id) contexts.set(status.context, status);
  }
  const latest = [...contexts.values()];
  const failed = checks.some((check) => ["failure", "timed_out", "cancelled", "startup_failure", "action_required"].includes(check.conclusion)) ||
    latest.some((status) => ["error", "failure"].includes(status.state));
  const pending = checks.some((check) => check.status !== "completed") || latest.some((status) => status.state === "pending");
  const valid = checks.every((check) => ["success", "neutral", "skipped"].includes(check.conclusion)) &&
    latest.every((status) => status.state === "success") &&
    (checks.some((check) => check.conclusion === "success") || latest.some((status) => status.state === "success"));
  return { state: failed ? "failed" : pending ? "pending" : !checks.length && !latest.length ? "missing" : valid ? "observed-success" : "unknown",
    checkRuns: checks.length, statusContexts: latest.length };
}

function ownedPulls(pulls, repository, bot) {
  const candidates = pulls.filter((pr) => pr.head?.ref === BRANCH || pr.body?.includes(MARKER));
  requireThat(candidates.length <= 1, "Duplicate Terraform controller PRs require human reconciliation");
  for (const pr of candidates) {
    requireThat(pr.user?.type === "Bot" && pr.user.login === bot && pr.body?.startsWith(MARKER) &&
      pr.head?.ref === BRANCH && pr.head.repo?.full_name === repository && pr.base?.repo?.full_name === repository,
    "Existing controller branch or PR is not owned by this App");
  }
  return candidates;
}

function validateHeadTree(base, head, allowed) {
  rootSources(head);
  const baseFiles = base.tree.filter((item) => item.type !== "tree");
  const headFiles = head.tree.filter((item) => item.type !== "tree");
  requireThat(baseFiles.length === headFiles.length, "Controller branch contains added or removed files");
  const byPath = new Map(headFiles.map((item) => [item.path, item]));
  for (const item of baseFiles) {
    const other = byPath.get(item.path);
    requireThat(other && item.mode === other.mode && item.type === other.type &&
      (item.sha === other.sha || allowed.has(item.path)),
    "Controller branch differs outside the current pin allowlist; refresh/review required");
  }
}

export async function reconcile({ api, repository, bot, policy, releases, dryRun = true }) {
  requireThat(REPOSITORY.test(repository) && /^[A-Za-z0-9_-]+\[bot\]$/.test(bot),
    "Invalid repository or App identity");
  const meta = await api.get(`/repos/${repository}`);
  requireThat(meta.full_name === repository && meta.archived === false && meta.fork === false &&
    typeof meta.default_branch === "string", "Repository is not applicable");
  const base = await api.get(refPath(repository, meta.default_branch));
  const plan = await planUpdate({ api, repository, baseSha: base.object.sha, policy, releases });
  const result = { repository, baseSha: plan.baseSha, dryRun, latestObserved: releases[0] ?? null, target: plan.target,
    roots: plan.observations, blocked: plan.blocked, changes: plan.changes.map((item) => item.path), status: "not-applicable" };
  if (plan.observations.length === 0) return result;
  const pulls = ownedPulls(await openPulls(api, repository), repository, bot);
  const pr = pulls[0];
  const head = await optionalRef(api, repository, BRANCH);
  requireThat(Boolean(pr) === Boolean(head), "Orphan controller branch or missing PR branch requires human reconciliation");
  if (pr) {
    requireThat(pr.base.ref === meta.default_branch && pr.head.sha === head.object.sha, "PR/head identity changed");
    const headTree = await api.get(`/repos/${repository}/git/trees/${head.object.sha}?recursive=1`);
    const allowed = new Set(plan.observations.map(({ root }) => root === "." ? ".terraform-version" : `${root}/.terraform-version`));
    validateHeadTree(plan.tree, headTree, allowed);
    result.pullRequest = pr.number;
    result.mergeableState = pr.mergeable_state ?? "unknown";
    result.checks = await checkSnapshot(api, repository, head.object.sha);
    const diff = await api.get(`/repos/${repository}/compare/${plan.baseSha}...${head.object.sha}`);
    requireThat(Array.isArray(diff.files) && diff.files.length <= MAX_ROOTS &&
      diff.files.every((file) => allowed.has(file.filename) && file.status === "modified" && !file.previous_filename),
    "Existing PR has an unapproved or incomplete changed-file list");
    const expected = new Map(plan.changes.map((change) => [change.path, change.content]));
    requireThat(plan.blocked.length > 0 || diff.files.every((file) => expected.has(file.filename)),
      "Existing PR includes obsolete pin changes; human reconciliation required");
    let identical = diff.files.length === expected.size;
    for (const file of diff.files) {
      const entry = headTree.tree.find((item) => item.path === file.filename);
      const blob = await api.get(`/repos/${repository}/git/blobs/${entry.sha}`);
      requireThat(blob.encoding === "base64" && blob.size <= 64, "Invalid controller head pin");
      const content = Buffer.from(blob.content, "base64").toString("utf8");
      const headVersion = pinVersion(content);
      requireThat(plan.blocked.length > 0 || compareVersions(headVersion, plan.target) <= 0,
        "Existing PR pin is newer than approved target; downgrade refused");
      if (expected.get(file.filename) !== content) identical = false;
    }
    if (identical && !plan.blocked.length) return { ...result, status: "unchanged" };
  }
  if (plan.blocked.length) return { ...result, status: "blocked" };
  if (!plan.changes.length) return { ...result, status: pr ? "obsolete-pr-needs-human" : "current" };
  if (dryRun) return { ...result, status: "would-propose" };

  const recheck = async (expectedHead) => {
    const currentMeta = await api.get(`/repos/${repository}`);
    requireThat(currentMeta.archived === false && currentMeta.fork === false &&
      currentMeta.default_branch === meta.default_branch, "Repository applicability changed");
    const currentBase = await api.get(refPath(repository, meta.default_branch));
    requireThat(currentBase.object.sha === plan.baseSha, "Default branch raced; retry from current tree");
    const currentPulls = ownedPulls(await openPulls(api, repository), repository, bot);
    requireThat(currentPulls.length === pulls.length && (!pr ||
      (currentPulls[0].number === pr.number && currentPulls[0].head.sha === expectedHead &&
        currentPulls[0].base.ref === meta.default_branch)), "PR raced; retry");
    const currentHead = await optionalRef(api, repository, BRANCH);
    requireThat((currentHead?.object.sha ?? null) === expectedHead, "Controller branch raced; retry");
  };
  await recheck(head?.object.sha ?? null);
  if (!head) {
    await api.post(`/repos/${repository}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: plan.baseSha });
  }
  // GraphQL provides an atomic expected-head compare-and-swap; never force-push.
  await recheck(head?.object.sha ?? plan.baseSha);
  const committed = await api.graphql(`mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid } }
  }`, { input: { branch: { repositoryNameWithOwner: repository, branchName: BRANCH },
    expectedHeadOid: head?.object.sha ?? plan.baseSha,
    message: { headline: `chore: update Terraform CLI to ${plan.target}` },
    fileChanges: { additions: plan.changes.map(({ path, content }) =>
      ({ path, contents: Buffer.from(content).toString("base64") })) } } });
  const newSha = committed.createCommitOnBranch?.commit?.oid;
  requireThat(SHA.test(newSha), "Commit creation returned no identity");
  await recheck(newSha);
  const body = `${MARKER}\n## Reviewed Terraform CLI update\n\n` +
    `Central approved target: **${plan.target}**. Official release: https://github.com/hashicorp/terraform/releases/tag/v${plan.target}\n\n` +
    `Reviewed source base: \`${plan.baseSha}\`.\n\n` +
    plan.observations.map((root) => `- \`${root.root}\`: ${root.current} → ${plan.target}; compatibility digest \`${root.sourceDigest}\``).join("\n") +
    "\n\nOnly exact CLI pins change. Dependabot owns provider/module updates. No target code, Terraform, providers or cloud credentials were used.\n" +
    "Compatibility is a central human-reviewed source-digest approval, not an inferred HCL evaluation or security guarantee.\n" +
    "Human review, real root validations/plans and existing environment/publication gates are required. This controller never merges or deploys.\n";
  const payload = { title: `chore: update Terraform CLI to ${plan.target}`, body };
  const published = pr ? await api.patch(`/repos/${repository}/pulls/${pr.number}`, payload) :
    await api.post(`/repos/${repository}/pulls`, { ...payload, head: BRANCH, base: meta.default_branch });
  requireThat(published.state === "open" && published.head?.sha === newSha,
    "Published PR raced or is not open at the committed head");
  return { ...result, status: pr ? "updated" : "created", pullRequest: published.number, headSha: newSha,
    checks: await checkSnapshot(api, repository, newSha) };
}

export class GitHubApi {
  constructor(token) { requireThat(Boolean(token), "GitHub App token is required"); this.token = token; }
  async request(method, endpoint, payload) {
    requireThat(endpoint.startsWith("/") && !endpoint.startsWith("//"), "Invalid GitHub endpoint");
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} failed (${response.status}); permissions/races require attention`);
      error.status = response.status;
      throw error;
    }
    return boundedJson(response);
  }
  get(endpoint) { return this.request("GET", endpoint); }
  post(endpoint, body) { return this.request("POST", endpoint, body); }
  patch(endpoint, body) { return this.request("PATCH", endpoint, body); }
  async graphql(query, variables) {
    const result = await this.post("/graphql", { query, variables });
    requireThat(!result.errors && result.data, "GitHub atomic commit rejected; head may have raced");
    return result.data;
  }
  async pages(endpoint, key = null, maxPages = 10) {
    const all = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.get(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      const rows = key ? data[key] : data;
      requireThat(Array.isArray(rows), "Invalid paginated GitHub response");
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error("GitHub pagination bound reached; collection incomplete");
  }
}

async function boundedJson(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    requireThat(size <= MAX_BYTES, "Metadata response exceeds byte bound");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function officialReleases() {
  const response = await fetch("https://api.github.com/repos/hashicorp/terraform/releases?per_page=100", {
    redirect: "error", signal: AbortSignal.timeout(30000), headers: { Accept: "application/vnd.github+json" },
  });
  requireThat(response.ok, "Official Terraform release discovery failed");
  const releases = stableReleases(await boundedJson(response));
  requireThat(releases.length > 0, "No official stable Terraform releases discovered");
  return releases;
}

async function main() {
  const api = new GitHubApi(process.env.GH_TOKEN);
  if (process.argv[2] === "discover") {
    const repos = await discoverRepositories(api, process.env.OWNER, process.env.SELECTED_REPOSITORY);
    const releases = await officialReleases();
    await appendFile(process.env.GITHUB_OUTPUT, `repos=${JSON.stringify(repos)}\nreleases=${JSON.stringify(releases)}\n`);
    return;
  }
  requireThat(process.argv[2] === "reconcile" && ["true", "false"].includes(process.env.DRY_RUN ?? "true"),
    "Usage: terraform-cli.mjs discover|reconcile; DRY_RUN must be true or false");
  let result;
  try {
    const policy = JSON.parse(await readFile(new URL("./terraform-cli-policy.json", import.meta.url), "utf8"));
    const releases = process.env.OFFICIAL_RELEASES ? JSON.parse(process.env.OFFICIAL_RELEASES) : await officialReleases();
    requireThat(Array.isArray(releases) && releases.length > 0 && releases.length <= 100 &&
      releases.every((version) => typeof version === "string" && VERSION.test(version)),
    "Invalid official release snapshot");
    result = await reconcile({ api, repository: process.env.REPOSITORY, bot: process.env.APP_BOT,
      policy, releases, dryRun: process.env.DRY_RUN !== "false" });
    if (result.status === "blocked" || result.status === "obsolete-pr-needs-human" ||
      result.checks?.state === "failed") process.exitCode = 1;
  } catch (error) {
    result = { repository: process.env.REPOSITORY, status: "incomplete", error: error.message };
    process.exitCode = 1;
  }
  await writeFile("terraform-cli-result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Terraform CLI maintenance\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Terraform CLI discovery/controller failed; activity is incomplete"); process.exitCode = 1; });
}
