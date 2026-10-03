import { loadTestProjects, relativePath, testSourceProject } from "./test-projects.mjs";

export const CHANGE_SCOPE_VERSION = "bounded-test-budget-v1";
export const CHANGE_SCOPE_INSTRUCTIONS = "Choose one logical fix: default to one finding; batch at most four only when an explicit shared root cause or repeated corrective pattern explains every selected finding. A shared directory alone is not a relationship. Limit production changes to the selected findings in one focused area; targeted tests may live in separate test directories. Production and all unverified/non-test changes: at most eight files and 250 added/deleted lines. Verified test-only changes: at most eight files and 750 added/deleted lines. Entire PR: at most 12 files and 1000 added/deleted lines. Only regular C# source in established SDK test projects, verified against immutable head and trusted base metadata, qualifies for the test allowance; names alone are not proof. Other languages, fixtures, configuration and uncertain ownership count against the normal allowance. Renames must be verified on both sides. Never weaken or remove required coverage to fit a budget. Preserve observable functionality, architecture, performance and cost.";
export const changeScopeMarker = (sha) => `<!-- platform-devex-ci-change-scope:${CHANGE_SCOPE_VERSION}:${sha} -->`;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function budgetRisk({ nonTest, tests }) {
  if (![nonTest, tests].every((scope) => scope && count(scope.files) && count(scope.lines) &&
      (scope.files > 0 || scope.lines === 0))) return "Invalid change-budget counts";
  if (nonTest.files > 8 || nonTest.lines > 250) return "Non-test changes exceed the eight-file or 250-line limit";
  if (tests.files > 8 || tests.lines > 750) return "Verified test changes exceed the eight-file or 750-line limit";
  if (nonTest.files + tests.files > 12 || nonTest.lines + tests.lines > 1000) {
    return "PR exceeds the overall 12-file or 1000-line limit";
  }
  return null;
}

export function scopeCounts(files, testFiles = []) {
  const verified = new Set(testFiles.map((file) => file.path));
  const counts = { nonTest: { files: 0, lines: 0 }, tests: { files: 0, lines: 0 } };
  for (const file of files) {
    const scope = verified.has(file.filename) ? counts.tests : counts.nonTest;
    scope.files++;
    scope.lines += file.additions + file.deletions;
  }
  return counts;
}

export function diffRisk(pr, files, testFiles = []) {
  if (![pr.changed_files, pr.additions, pr.deletions].every(count) || !Array.isArray(files) ||
      files.length !== pr.changed_files || new Set(files.map((file) => file.filename)).size !== files.length ||
      files.some((file) => !relativePath(file.filename) || !count(file.additions) || !count(file.deletions) ||
        (file.previous_filename !== undefined && !relativePath(file.previous_filename))) ||
      files.reduce((sum, file) => sum + file.additions, 0) !== pr.additions ||
      files.reduce((sum, file) => sum + file.deletions, 0) !== pr.deletions) {
    return "Incomplete or inconsistent PR/file change counts; withholding scope approval";
  }
  const sensitive = /(^|\/)(\.github\/|CODEOWNERS$|AGENTS\.md$|Dockerfile[^/]*$|\.editorconfig$|[^/]*\.ruleset$|sonar-project\.properties$|scripts\/(?:sonar-policy|test-projects|change-scope)\.mjs$|Directory\.Build\.(props|targets)$|\.terraform|terraform\/|infra\/)/i;
  const unsafe = files.find((file) => [file.filename, file.previous_filename].some((path) => path && sensitive.test(path)));
  return unsafe ? `PR changes a gated path: ${unsafe.filename}` : budgetRisk(scopeCounts(files, testFiles));
}

export async function classifyChangedTests(api, repo, pr, files) {
  const candidates = files.filter((file) => file.filename?.endsWith(".cs") &&
    ["added", "modified", "removed", "renamed"].includes(file.status));
  if (!candidates.length) return [];
  const inventory = await loadTestProjects(api, repo, pr.head?.sha, pr.base?.sha ?? null);
  const verified = [];
  for (const file of candidates) {
    const path = file.filename;
    const project = testSourceProject(inventory, path, file.status === "removed" ? "base" : "head");
    const oldPath = file.previous_filename ?? path;
    const oldProject = file.status === "added" && !file.previous_filename
      ? project : testSourceProject(inventory, oldPath, "base");
    if (project && oldProject && (file.status !== "renamed" || file.previous_filename)) {
      verified.push({ path, project, ...(file.previous_filename ? { previousPath: oldPath, previousProject: oldProject } : {}) });
    } else {
      console.warn(`::warning::${repo}: ${path} has no verified test-only ownership on both sides; counts against the normal budget`);
    }
  }
  return verified;
}

export function scopeReport(files, testFiles) {
  const { nonTest, tests } = scopeCounts(files, testFiles);
  return `Change scope ${CHANGE_SCOPE_VERSION}: non-test/unverified ${nonTest.files}/8 files, ${nonTest.lines}/250 lines; verified tests ${tests.files}/8 files, ${tests.lines}/750 lines; total ${files.length}/12 files, ${nonTest.lines + tests.lines}/1000 lines (additions plus deletions).`;
}
