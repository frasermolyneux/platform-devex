import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const BRANCH = "automation/repository-standards";
export const MARKER = "<!-- platform-devex-repository-standards-v1 -->";
export const CONTRACT_VERSION = "repository-standards-v1";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BOT = /^[A-Za-z0-9_-]+\[bot\]$/;
const SHA = /^[a-f0-9]{40}$/;
const RULE = /^CKV(?:2)?_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
const DIAGNOSTIC = /^(?:CA|CS|IDE)[0-9]{4}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._/-]+$/;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_BYTES = 48 * 1024;
const MAX_CATALOG_ENTRIES = 256;
const MAX_FILE_BYTES = 256 * 1024;
const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", { granularity: "grapheme" });

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, message) {
  requireThat(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"), message);
}

export function graphemeLength(value) {
  requireThat(typeof value === "string", "Grapheme input must be a string");
  let length = 0;
  for (const _ of GRAPHEME_SEGMENTER.segment(value)) length++;
  return length;
}

export function validatePolicy(policy) {
  exactKeys(policy, ["version", "targetPath", "exceptionRules", "profiles"], "Invalid Checkov policy");
  requireThat(policy.version === "checkov-v1" && policy.targetPath === ".checkov.yml" &&
    SAFE_PATH.test(policy.targetPath) && policy.targetPath.length <= 200 &&
    Array.isArray(policy.exceptionRules) && policy.exceptionRules.length > 0 &&
    policy.exceptionRules.length <= 32 &&
    Array.isArray(policy.profiles) && policy.profiles.length > 0 && policy.profiles.length <= 16,
  "Invalid Checkov policy");
  const names = new Set(), rules = new Set(), exceptionRules = new Set();
  for (const rule of policy.exceptionRules) {
    requireThat(typeof rule === "string" && RULE.test(rule) && !exceptionRules.has(rule),
      "Invalid Checkov exception rule catalog");
    exceptionRules.add(rule);
  }
  for (const profile of policy.profiles) {
    exactKeys(profile, ["name", "rules"], "Invalid Checkov profile");
    requireThat(typeof profile.name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(profile.name) &&
      !names.has(profile.name) && Array.isArray(profile.rules) && profile.rules.length > 0 &&
      profile.rules.length <= 128, "Invalid Checkov profile");
    names.add(profile.name);
    for (const rule of profile.rules) {
      requireThat(typeof rule === "string" && RULE.test(rule), "Invalid Checkov rule ID");
      rules.add(rule);
    }
  }
  return { policy, names, rules, exceptionRules };
}

export function validateEditorConfigPolicy(policy) {
  exactKeys(policy, ["version", "targetPath", "beginMarker", "endMarker", "profiles"],
    "Invalid editorconfig policy");
  requireThat(policy.version === "dotnet-editorconfig-v1" && policy.targetPath === ".editorconfig" &&
    SAFE_PATH.test(policy.targetPath) && policy.targetPath.length <= 200 &&
    typeof policy.beginMarker === "string" && policy.beginMarker.startsWith("# BEGIN ") &&
    typeof policy.endMarker === "string" && policy.endMarker.startsWith("# END ") &&
    policy.beginMarker !== policy.endMarker &&
    Array.isArray(policy.profiles) && policy.profiles.length > 0 && policy.profiles.length <= 8,
  "Invalid editorconfig policy");
  const names = new Set(), rules = new Set();
  for (const profile of policy.profiles) {
    exactKeys(profile, ["name", "rules"], "Invalid editorconfig profile");
    requireThat(typeof profile.name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(profile.name) &&
      !names.has(profile.name) && Array.isArray(profile.rules) && profile.rules.length > 0 &&
      profile.rules.length <= 128, "Invalid editorconfig profile");
    names.add(profile.name);
    for (const rule of profile.rules) {
      exactKeys(rule, ["id", "reason"], "Invalid editorconfig rule");
      requireThat(typeof rule.id === "string" && DIAGNOSTIC.test(rule.id) && !rules.has(rule.id) &&
        typeof rule.reason === "string" && rule.reason === rule.reason.trim() &&
        graphemeLength(rule.reason) >= 10 && graphemeLength(rule.reason) <= 240 &&
        !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff\ufffe\uffff]/u.test(rule.reason),
      "Invalid or duplicate editorconfig rule");
      rules.add(rule.id);
    }
  }
  return { policy, names, rules };
}

function policySet(value) {
  if (value?.checkov || value?.editorconfig) {
    return {
      checkov: value.checkov ?? null,
      editorconfig: value.editorconfig ?? null,
    };
  }
  return { checkov: value, editorconfig: null };
}

export function validateContract(contract, policyInput) {
  const policies = policySet(policyInput);
  const checkov = policies.checkov ? validatePolicy(policies.checkov) : null;
  const editorconfig = policies.editorconfig ? validateEditorConfigPolicy(policies.editorconfig) : null;
  exactKeys(contract, ["version", "managedFiles"], "Invalid repository standards contract");
  requireThat(contract.version === CONTRACT_VERSION && contract.managedFiles &&
    typeof contract.managedFiles === "object" && !Array.isArray(contract.managedFiles) &&
    Object.keys(contract.managedFiles).every((key) => ["checkov", "editorconfig"].includes(key)),
  "Invalid repository standards contract");
  const managedFiles = [];
  if (Object.hasOwn(contract.managedFiles, "checkov")) {
    requireThat(checkov, "Checkov policy is unavailable");
    const file = contract.managedFiles.checkov;
    exactKeys(file, ["version", "profiles", "exceptions"], "Invalid managed file declaration");
    requireThat(file.version === checkov.policy.version, "Unknown managed file policy version");
    requireThat(Array.isArray(file.profiles) && file.profiles.length > 0 &&
      file.profiles.length <= checkov.policy.profiles.length &&
      file.profiles.every((name) => typeof name === "string" && checkov.names.has(name)) &&
      new Set(file.profiles).size === file.profiles.length, "Unknown or duplicate Checkov profile");
    requireThat(!file.profiles.some((name) => name.endsWith("-resource-scoped") &&
      file.profiles.includes(name.slice(0, -"-resource-scoped".length))),
    "A resource-scoped profile cannot be combined with its repository-wide profile");
    requireThat(Array.isArray(file.exceptions) && file.exceptions.length <= 128,
      "Invalid Checkov exceptions");
    const selectedRules = new Set(checkov.policy.profiles
      .filter((profile) => file.profiles.includes(profile.name))
      .flatMap((profile) => profile.rules));
    const exceptions = new Map();
    for (const exception of file.exceptions) {
      exactKeys(exception, ["rule", "reason"], "Malformed Checkov exception");
      const reasonLength = typeof exception.reason === "string"
        ? graphemeLength(exception.reason)
        : -1;
      requireThat(typeof exception.rule === "string" && checkov.exceptionRules.has(exception.rule) &&
        !selectedRules.has(exception.rule) && !exceptions.has(exception.rule) &&
        typeof exception.reason === "string" && exception.reason === exception.reason.trim() &&
        reasonLength >= 10 && reasonLength <= 600 &&
        !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff\ufffe\uffff]/u.test(exception.reason),
      "Duplicate, unsupported, or malformed Checkov exception");
      exceptions.set(exception.rule, exception.reason);
    }
    managedFiles.push({ type: "checkov", path: checkov.policy.targetPath, policyVersion: file.version,
      profiles: file.profiles, exceptions });
  }
  if (Object.hasOwn(contract.managedFiles, "editorconfig")) {
    requireThat(editorconfig, "Editorconfig policy is unavailable");
    const file = contract.managedFiles.editorconfig;
    exactKeys(file, ["version", "profiles"], "Invalid managed editorconfig declaration");
    requireThat(file.version === editorconfig.policy.version &&
      Array.isArray(file.profiles) && file.profiles.length > 0 &&
      file.profiles.length <= editorconfig.policy.profiles.length &&
      file.profiles.every((name) => typeof name === "string" && editorconfig.names.has(name)) &&
      new Set(file.profiles).size === file.profiles.length,
    "Unknown managed editorconfig policy version or profile");
    managedFiles.push({ type: "editorconfig", path: editorconfig.policy.targetPath,
      policyVersion: file.version, profiles: file.profiles });
  }
  return { version: contract.version, managedFiles };
}

export function renderCheckov(file, policy) {
  const validated = validateContract({ version: CONTRACT_VERSION, managedFiles: { checkov: {
    version: file.policyVersion ?? file.version,
    profiles: file.profiles,
    exceptions: file.exceptions instanceof Map
      ? [...file.exceptions].map(([rule, reason]) => ({ rule, reason }))
      : file.exceptions,
  } } }, policy).managedFiles[0];
  const selected = new Set(validated.profiles);
  const emitted = new Set();
  const lines = [
    "# Managed by platform-devex repository standards. Do not edit by hand.",
    `# Provenance: ${CONTRACT_VERSION} / ${policy.version}`,
    "# Changes are proposed by pull request and require human review.",
    "soft-fail: false",
    "compact: true",
    "skip-check:",
  ];
  for (const profile of policy.profiles) {
    if (!selected.has(profile.name)) continue;
    lines.push(`  # Profile: ${profile.name}`);
    for (const rule of profile.rules) {
      if (emitted.has(rule)) continue;
      emitted.add(rule);
      lines.push(`  - ${rule}`);
    }
  }
  const exceptionOrder = policy.exceptionRules.filter((rule) => validated.exceptions.has(rule));
  if (exceptionOrder.length) {
    lines.push("  # Approved repository exceptions");
    for (const rule of exceptionOrder) {
      emitted.add(rule);
      lines.push(`  - ${rule} # ${validated.exceptions.get(rule)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderEditorConfig(file, policy) {
  const validated = validateContract({ version: CONTRACT_VERSION, managedFiles: { editorconfig: {
    version: file.policyVersion ?? file.version,
    profiles: file.profiles,
  } } }, { editorconfig: policy }).managedFiles[0];
  const selected = new Set(validated.profiles);
  const lines = [
    policy.beginMarker,
    "# Managed by platform-devex repository standards. Do not edit this section by hand.",
    `# Provenance: ${CONTRACT_VERSION} / ${policy.version}`,
    "[*.{cs,vb}]",
  ];
  for (const profile of policy.profiles) {
    if (!selected.has(profile.name)) continue;
    lines.push(`# Profile: ${profile.name}`);
    for (const rule of profile.rules) {
      lines.push(`# ${rule.reason}`);
      lines.push(`dotnet_diagnostic.${rule.id}.severity = none`);
    }
  }
  lines.push(policy.endMarker);
  return `${lines.join("\n")}\n`;
}

export function applyEditorConfig(current, file, policy) {
  requireThat(current === null || typeof current === "string", "Invalid editorconfig source");
  const section = renderEditorConfig(file, policy);
  if (current === null) return `root = true\n\n${section}`;
  requireThat(!current.includes("\0") && !current.includes("\ufffd") &&
    !/(^|[^\r])\r(?!\n)/.test(current), "Invalid editorconfig source");
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const normalized = current.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const begins = lines.reduce((all, line, index) =>
    line === policy.beginMarker ? [...all, index] : all, []);
  const ends = lines.reduce((all, line, index) =>
    line === policy.endMarker ? [...all, index] : all, []);
  requireThat(begins.length === ends.length && begins.length <= 1 &&
    (!begins.length || begins[0] < ends[0]), "Malformed managed editorconfig section");
  const managed = section.trimEnd().split("\n");
  let result;
  if (begins.length) {
    result = [...lines.slice(0, begins[0]), ...managed, ...lines.slice(ends[0] + 1)];
  } else {
    const withoutTrailingEmpty = [...lines];
    while (withoutTrailingEmpty.at(-1) === "") withoutTrailingEmpty.pop();
    result = [...withoutTrailingEmpty, "", ...managed];
  }
  return `${result.join("\n").replace(/\n+$/u, "")}\n`.replaceAll("\n", eol);
}

function nestedEditorConfigUsesPolicy(path, content, policy) {
  if (path === policy.targetPath || !path.endsWith(`/${policy.targetPath}`)) return false;
  return content.includes(policy.beginMarker) || content.includes(policy.endMarker) ||
    policy.profiles.some((profile) =>
      profile.rules.some((rule) => content.includes(`dotnet_diagnostic.${rule.id}.severity`)));
}

export function generateManagedFiles(contract, policyInput, editorConfigs = new Map()) {
  const policies = policySet(policyInput);
  const validated = validateContract(contract, policies);
  const files = [];
  for (const file of validated.managedFiles) {
    if (file.type === "checkov") {
      files.push({ path: file.path, content: renderCheckov(file, policies.checkov) });
      continue;
    }
    const paths = new Set([file.path]);
    for (const [path, content] of editorConfigs) {
      requireThat(SAFE_PATH.test(path) && typeof content === "string",
        "Invalid editorconfig source map");
      if (nestedEditorConfigUsesPolicy(path, content, policies.editorconfig)) paths.add(path);
    }
    for (const path of [...paths].sort()) {
      files.push({ path, content: applyEditorConfig(editorConfigs.get(path) ?? null,
        file, policies.editorconfig) });
    }
  }
  return files;
}

export function validateCatalog(value, policyInput) {
  requireThat(typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CATALOG_BYTES,
  "Repository standards catalog is missing or exceeds the byte bound");
  let catalog;
  try { catalog = JSON.parse(value); }
  catch { throw new Error("Invalid repository standards catalog JSON"); }
  requireThat(catalog && typeof catalog === "object" && !Array.isArray(catalog),
    "Repository standards catalog must be an object");
  const entries = Object.entries(catalog);
  requireThat(entries.length <= MAX_CATALOG_ENTRIES, "Repository standards catalog exceeds entry bound");
  const validated = Object.create(null);
  for (const [name, contract] of entries) {
    requireThat(REPOSITORY_NAME.test(name), "Invalid repository standards catalog key");
    validateContract(contract, policyInput);
    validated[name] = contract;
  }
  return validated;
}

export function isIncompleteStatus(status) {
  return ["obsolete-pr-needs-human", "stale-pr-needs-branch-update"].includes(status);
}

export async function discoverRepositories(api, owner, selected = "", catalog = {}) {
  requireThat(/^[A-Za-z0-9-]+$/.test(owner) &&
    (!selected || REPOSITORY_NAME.test(selected)), "Invalid repository selection");
  requireThat(catalog && typeof catalog === "object" && !Array.isArray(catalog),
    "Invalid repository standards catalog");
  const rows = await api.pages("/installation/repositories", "repositories", 10);
  const names = rows.filter((repo) => repo.archived === false && repo.fork === false &&
    repo.owner?.login?.toLowerCase() === owner.toLowerCase()).map((repo) => {
    requireThat(REPOSITORY_NAME.test(repo.name), "Invalid installation repository name");
    return repo.name;
  });
  requireThat(names.length <= 256, "Repository matrix exceeds bound");
  requireThat(!selected || Object.hasOwn(catalog, selected),
    "Selected repository is not declared in the repository standards catalog");
  requireThat(!selected || names.includes(selected),
    "Selected repository is not an applicable installation repository");
  return [...new Set(names)]
    .filter((name) => Object.hasOwn(catalog, name) && (!selected || name === selected))
    .sort()
    .map((name) => ({ repo: name, contract: catalog[name] }));
}

function refPath(repository, branch) {
  return `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`;
}

async function optionalGet(api, endpoint) {
  try { return await api.get(endpoint); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

async function openPulls(api, repository) {
  return api.pages(`/repos/${repository}/pulls?state=open`, null, 10);
}

function ownedPull(pulls, repository, bot) {
  const candidates = pulls.filter((pr) => pr.head?.ref === BRANCH || pr.body?.includes(MARKER));
  requireThat(candidates.length <= 1, "Duplicate managed-files pull requests require human reconciliation");
  const pr = candidates[0] ?? null;
  if (pr) {
    requireThat(pr.user?.type === "Bot" && pr.user.login === bot &&
      pr.body?.startsWith(MARKER) && pr.head?.ref === BRANCH &&
      pr.head.repo?.full_name === repository && pr.base?.repo?.full_name === repository,
    "Existing managed-files branch or pull request is not owned by this App");
  }
  return pr;
}

function validateTree(tree) {
  requireThat(tree?.truncated === false && Array.isArray(tree.tree) && tree.tree.length <= 20000,
    "Incomplete or oversized repository tree");
  const paths = new Set();
  for (const item of tree.tree) {
    requireThat(typeof item.path === "string" && item.path.length > 0 && item.path.length <= 500 &&
      !item.path.includes("\0") && !paths.has(item.path) && SHA.test(item.sha),
    "Invalid repository tree entry");
    paths.add(item.path);
  }
  return tree;
}

function compareAncestry(compare, baseSha) {
  requireThat(compare && ["ahead", "behind", "diverged", "identical"].includes(compare.status) &&
    Number.isSafeInteger(compare.ahead_by) && compare.ahead_by >= 0 && compare.ahead_by <= 1_000_000 &&
    Number.isSafeInteger(compare.behind_by) && compare.behind_by >= 0 && compare.behind_by <= 1_000_000 &&
    compare.base_commit?.sha === baseSha && SHA.test(compare.merge_base_commit?.sha),
  "Invalid managed-files comparison ancestry");
  const current = compare.merge_base_commit.sha === baseSha && compare.behind_by === 0 &&
    (compare.status === "identical" && compare.ahead_by === 0 ||
      compare.status === "ahead" && compare.ahead_by > 0);
  const stale = compare.merge_base_commit.sha !== baseSha && compare.behind_by > 0 &&
    (compare.status === "behind" && compare.ahead_by === 0 ||
      compare.status === "diverged" && compare.ahead_by > 0);
  requireThat(current || stale, "Inconsistent managed-files comparison ancestry");
  return {
    current,
    status: compare.status,
    aheadBy: compare.ahead_by,
    behindBy: compare.behind_by,
    mergeBaseSha: compare.merge_base_commit.sha,
  };
}

async function readBlob(api, repository, entry) {
  requireThat(entry.type === "blob" && entry.mode === "100644", "Managed target is not a regular file");
  const blob = await api.get(`/repos/${repository}/git/blobs/${entry.sha}`);
  requireThat(blob.encoding === "base64" && Number.isSafeInteger(blob.size) &&
    blob.size <= MAX_FILE_BYTES && typeof blob.content === "string", "Invalid managed target blob");
  return Buffer.from(blob.content, "base64").toString("utf8");
}

function pullPayload(files, baseSha) {
  const paths = files.map((file) => `- \`${file.path}\``).join("\n");
  return {
    title: "chore: reconcile managed repository standards",
    body: `${MARKER}\n## Managed repository standards\n\n` +
      `Source default-branch revision: \`${baseSha}\`.\n\nManaged files:\n${paths}\n\n` +
      "The listed files or marked sections are managed and may be updated by later proposals. " +
      "This pull request requires human review; platform-devex never merges it or writes the default branch.\n",
  };
}

export async function reconcile({
  api,
  repository,
  bot,
  policy,
  contract,
  dryRun = true,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  requireThat(REPOSITORY.test(repository) && BOT.test(bot), "Invalid repository or App identity");
  const policies = policySet(policy);
  const validated = validateContract(contract, policies);
  const meta = await api.get(`/repos/${repository}`);
  requireThat(meta.full_name === repository && meta.archived === false && meta.fork === false &&
    typeof meta.default_branch === "string" && /^[A-Za-z0-9._/-]+$/.test(meta.default_branch),
  "Repository is not applicable");
  if (!validated.managedFiles.length) return { repository, dryRun, status: "skipped-no-managed-files" };

  const base = await api.get(refPath(repository, meta.default_branch));
  requireThat(SHA.test(base.object?.sha), "Invalid default branch identity");
  const baseSha = base.object.sha;
  const baseTree = validateTree(await api.get(`/repos/${repository}/git/trees/${baseSha}?recursive=1`));
  const editorConfigs = new Map();
  if (validated.managedFiles.some((file) => file.type === "editorconfig")) {
    for (const entry of baseTree.tree.filter((item) =>
      item.path === ".editorconfig" || item.path.endsWith("/.editorconfig"))) {
      editorConfigs.set(entry.path, await readBlob(api, repository, entry));
    }
  }
  const files = generateManagedFiles(contract, policies, editorConfigs);
  const changes = [];
  for (const file of files) {
    const entry = baseTree.tree.find((item) => item.path === file.path);
    const current = editorConfigs.has(file.path)
      ? editorConfigs.get(file.path)
      : entry ? await readBlob(api, repository, entry) : null;
    if (current !== file.content) changes.push(file);
  }
  const result = { repository, baseSha, dryRun, managedFiles: files.map((file) => file.path),
    changes: changes.map((file) => file.path), status: "current" };
  const pulls = await openPulls(api, repository);
  const pr = ownedPull(pulls, repository, bot);
  const head = await optionalGet(api, refPath(repository, BRANCH));
  requireThat(Boolean(pr) === Boolean(head),
    "Orphan managed-files branch or missing pull request branch requires human reconciliation");
  let identical = false;
  if (pr) {
    requireThat(pr.base.ref === meta.default_branch && pr.head.sha === head.object.sha,
      "Managed-files pull request identity changed");
    const allowed = new Set(changes.map((file) => file.path));
    const diff = await api.get(`/repos/${repository}/compare/${baseSha}...${head.object.sha}`);
    const ancestry = compareAncestry(diff, baseSha);
    result.ancestry = ancestry;
    requireThat(Array.isArray(diff.files) && diff.files.length <= changes.length &&
      diff.files.every((file) => allowed.has(file.filename) &&
        ["added", "modified"].includes(file.status) && !file.previous_filename),
    "Existing managed-files pull request contains unowned changes");
    result.pullRequest = pr.number;
    if (!ancestry.current) {
      return { ...result, status: "stale-pr-needs-branch-update" };
    }
    const headTree = validateTree(await api.get(
      `/repos/${repository}/git/trees/${head.object.sha}?recursive=1`));
    identical = diff.files.length === changes.length;
    const expected = new Map(changes.map((file) => [file.path, file.content]));
    for (const changed of diff.files) {
      const entry = headTree.tree.find((item) => item.path === changed.filename);
      requireThat(entry, "Existing managed file is missing from controller branch");
      if (await readBlob(api, repository, entry) !== expected.get(changed.filename)) identical = false;
    }
  }
  if (!changes.length) return { ...result, status: pr ? "obsolete-pr-needs-human" : "current" };
  const payload = pullPayload(files, baseSha);
  if (identical && pr.title === payload.title && pr.body === payload.body) {
    return { ...result, status: "unchanged" };
  }
  if (dryRun) return { ...result, status: identical ? "would-refresh-metadata" : "would-propose" };

  const recheck = async (expectedHead) => {
    const currentMeta = await api.get(`/repos/${repository}`);
    requireThat(currentMeta.full_name === repository && currentMeta.archived === false &&
      currentMeta.fork === false && currentMeta.default_branch === meta.default_branch,
    "Repository identity or default branch changed");
    const currentBase = await api.get(refPath(repository, meta.default_branch));
    requireThat(currentBase.object.sha === baseSha, "Default branch source changed");
    const currentPulls = await openPulls(api, repository);
    const currentPr = ownedPull(currentPulls, repository, bot);
    requireThat(Boolean(currentPr) === Boolean(pr) && (!pr ||
      currentPr.number === pr.number && currentPr.base.ref === meta.default_branch),
    "Managed-files pull request changed");
    requireThat(!pr || currentPr.head.sha === expectedHead,
      "Managed-files pull request head has not propagated");
    const currentHead = await optionalGet(api, refPath(repository, BRANCH));
    requireThat((currentHead?.object.sha ?? null) === expectedHead,
      "Managed-files branch source changed");
  };
  const recheckPublishedCommit = async (expectedHead) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await recheck(expectedHead);
      } catch (error) {
        if (error.message !== "Managed-files pull request head has not propagated" || attempt === 4) throw error;
        await wait(1000 * (attempt + 1));
      }
    }
  };

  let newSha = head?.object.sha ?? null;
  if (!identical) {
    await recheck(newSha);
    if (!head) {
      await api.post(`/repos/${repository}/git/refs`, {
        ref: `refs/heads/${BRANCH}`,
        sha: baseSha,
      });
      newSha = baseSha;
    }
    await recheck(newSha);
    const committed = await api.graphql(`mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid } }
    }`, { input: {
      branch: { repositoryNameWithOwner: repository, branchName: BRANCH },
      expectedHeadOid: newSha,
      message: { headline: "chore: reconcile managed repository standards" },
      fileChanges: { additions: changes.map((file) => ({
        path: file.path,
        contents: Buffer.from(file.content).toString("base64"),
      })) },
    } });
    newSha = committed.createCommitOnBranch?.commit?.oid;
    requireThat(SHA.test(newSha), "Managed commit creation returned no identity");
  }
  await recheckPublishedCommit(newSha);
  const published = pr
    ? await api.patch(`/repos/${repository}/pulls/${pr.number}`, payload)
    : await api.post(`/repos/${repository}/pulls`, {
      ...payload, head: BRANCH, base: meta.default_branch,
    });
  requireThat(published.state === "open" && published.head?.sha === newSha &&
    published.head.ref === BRANCH && published.head.repo?.full_name === repository &&
    published.base?.repo?.full_name === repository &&
    published.base.ref === meta.default_branch && published.base.sha === baseSha,
  "Published managed-files pull request no longer matches reviewed identities");
  return { ...result, status: pr ? identical ? "metadata-updated" : "updated" : "created",
    pullRequest: published.number, headSha: newSha };
}

export class GitHubApi {
  constructor(token) {
    requireThat(Boolean(token), "GitHub App token is required");
    this.token = token;
  }
  async request(method, endpoint, payload) {
    requireThat(endpoint.startsWith("/") && !endpoint.startsWith("//"), "Invalid GitHub endpoint");
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} failed (${response.status}); permissions or races require attention`);
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

async function loadPolicy() {
  return {
    checkov: JSON.parse(await readFile(
      new URL("../standards/checkov/v1.json", import.meta.url), "utf8")),
    editorconfig: JSON.parse(await readFile(
      new URL("../standards/editorconfig/v1.json", import.meta.url), "utf8")),
  };
}

async function main() {
  const api = new GitHubApi(process.env.GH_TOKEN);
  const policy = await loadPolicy();
  if (process.argv[2] === "discover") {
    const catalog = validateCatalog(process.env.REPOSITORY_STANDARDS_CATALOG, policy);
    const targets = await discoverRepositories(
      api, process.env.OWNER, process.env.SELECTED_REPOSITORY, catalog);
    await appendFile(process.env.GITHUB_OUTPUT, `targets=${JSON.stringify(targets)}\n`);
    return;
  }
  requireThat(process.argv[2] === "reconcile" && ["true", "false"].includes(process.env.DRY_RUN ?? "true"),
    "Usage: repository-standards.mjs discover|reconcile; DRY_RUN must be true or false");
  let result;
  try {
    result = await reconcile({
      api,
      repository: process.env.REPOSITORY,
      bot: process.env.APP_BOT,
      policy,
      contract: JSON.parse(process.env.REPOSITORY_STANDARDS_CONTRACT),
      dryRun: process.env.DRY_RUN !== "false",
    });
    if (isIncompleteStatus(result.status)) process.exitCode = 1;
  } catch (error) {
    result = { repository: process.env.REPOSITORY, status: "incomplete", error: error.message };
    process.exitCode = 1;
  }
  await writeFile("repository-standards-result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Managed repository standards\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`);
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Repository standards discovery/controller failed; activity is incomplete");
    process.exitCode = 1;
  });
}
