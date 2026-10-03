import { loadTestProjects, relativePath, testSourceProject } from "./test-projects.mjs";
export { verifiedTestProject } from "./test-projects.mjs";

export const SONAR_POLICY_VERSION = "test-style-advisory-v1";
const TEST_STYLE_RULES = new Set([
  "external_roslyn:CS1591", "external_roslyn:IDE0058", "external_roslyn:IDE0022",
  "external_roslyn:IDE0046", "external_roslyn:IDE0300", "external_roslyn:IDE0305",
]);
export const SONAR_POLICY_INSTRUCTIONS = `Sonar policy ${SONAR_POLICY_VERSION}: require zero blocking new findings. Only INFO CODE_SMELL findings from ${[...TEST_STYLE_RULES].join(", ")} in verified existing test-project source are advisory. All other findings, production code and uncertain classification remain blocking, including CA1305, CA1861 and xUnit2032. Advisory findings remain visible and are not fixed or selected for autonomous cleanup. Never suppress diagnostics, change analyzer/policy configuration or drop coverage to meet this policy. Run existing CI-equivalent analyzer checks/configuration available locally before the final report; a clean build or formatter alone may not cover those diagnostics. For hosted-only analysis, identify the real current-head CI checks separately from executed local commands; never invent a local pass or add credentials/infrastructure to reproduce them. The controller verifies actual hosted results separately. Apply safe existing formatting fixes within the scope cap, without new tooling or infrastructure.`;

export const sonarPolicyMarker = (sha) => `<!-- platform-devex-ci-sonar-policy:${SONAR_POLICY_VERSION}:${sha} -->`;

export function isTestStyleCandidate(finding) {
  return finding.source === "sonarcloud" && finding.type === "CODE_SMELL" &&
    finding.sonarSeverity === "INFO" && TEST_STYLE_RULES.has(finding.rule) &&
    (finding.impacts === undefined || (Array.isArray(finding.impacts) &&
      finding.impacts.every((impact) => impact?.softwareQuality === "MAINTAINABILITY" &&
        ["INFO", "LOW"].includes(impact.severity))));
}

const regular = (item) => item.type === "blob" && ["100644", "100755"].includes(item.mode);

export async function classifySonarFindings(api, repo, ref, findings, baseRef = ref) {
  const result = { version: SONAR_POLICY_VERSION, raw: findings, blocking: [], advisory: [] };
  const candidates = findings.filter((finding) => isTestStyleCandidate(finding) &&
    relativePath(finding.path) && finding.path.endsWith(".cs"));
  if (!candidates.length) return { ...result, blocking: findings };
  const inventory = await loadTestProjects(api, repo, ref, baseRef);
  if (!inventory) return { ...result, blocking: findings };
  const { head } = inventory;
  for (const finding of findings) {
    let project;
    let repositoryPath;
    if (isTestStyleCandidate(finding) && relativePath(finding.path) && finding.path.endsWith(".cs") &&
        !head.ambiguous && !inventory.base.ambiguous) {
      const matches = head.tree.filter((item) => regular(item) &&
        (item.path === finding.path || (!finding.path.startsWith("src/") && item.path === `src/${finding.path}`)));
      if (matches.length === 1) {
        repositoryPath = matches[0].path;
        project = testSourceProject(inventory, repositoryPath);
      }
    }
    if (project) result.advisory.push({ ...finding, repositoryPath, testProject: project });
    else {
      result.blocking.push(finding);
      if (isTestStyleCandidate(finding)) {
        console.warn(`::warning::${repo}: ${finding.id} has no unambiguous verified test-project source; remains blocking`);
      }
    }
  }
  return result;
}
