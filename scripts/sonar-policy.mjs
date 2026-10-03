import { posix } from "node:path";

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

const relativePath = (path) => typeof path === "string" && path.length > 0 &&
  !path.startsWith("/") && !path.includes("\\") && !path.includes(":") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
const within = (file, directory) => directory === "." || file.startsWith(`${directory}/`);
const defaultSource = (path) => !path.split("/").some((part) =>
  part.startsWith(".") || /^(bin|obj|node_modules)$/i.test(part));
const regular = (item) => item.type === "blob" && ["100644", "100755"].includes(item.mode);
const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, "");
// Linked source and custom MSBuild composition can make a nominal test file production code too.
const customCompilation = (xml) => /<!DOCTYPE|<!ENTITY|<(?:Import|Choose|Target|Compile|EnableDefault(?:Items|CompileItems)|DefaultItemExcludes(?:InProjectFolder)?|DefaultLanguageSourceExtension|OverrideDefaultCompileItems|BaseOutputPath|BaseIntermediateOutputPath|OutputPath|IntermediateOutputPath)\b|<PackageReference\b[^>]*\b(?:Remove|Update)\s*=/i.test(xml);

export function verifiedTestProject(content) {
  const xml = stripComments(content);
  if (customCompilation(xml) || /\bCondition\s*=/i.test(xml) ||
      !/<Project\s+Sdk=["']Microsoft\.NET\.Sdk["']\s*>/.test(xml) ||
      [...xml.matchAll(/<IsTestProject>([^<]*)<\/IsTestProject>/gi)].some((match) => match[1].trim().toLowerCase() !== "true")) return false;
  const packages = [...xml.matchAll(/<PackageReference\s+Include=["']([^"']+)["'][^>]*>/g)]
    .map((match) => match[1]);
  return packages.includes("Microsoft.NET.Test.Sdk") && [
    ["xunit", "xunit.runner.visualstudio"], ["xunit.v3", "xunit.runner.visualstudio"],
    ["NUnit", "NUnit3TestAdapter"], ["MSTest.TestFramework", "MSTest.TestAdapter"],
  ].some(([framework, adapter]) => packages.includes(framework) && packages.includes(adapter));
}

export async function classifySonarFindings(api, repo, ref, findings, baseRef = ref) {
  const result = { version: SONAR_POLICY_VERSION, raw: findings, blocking: [], advisory: [] };
  const candidates = findings.filter((finding) => isTestStyleCandidate(finding) &&
    relativePath(finding.path) && finding.path.endsWith(".cs"));
  if (!candidates.length) return { ...result, blocking: findings };
  if (typeof ref !== "string" || !ref || typeof baseRef !== "string" || !baseRef) {
    console.warn(`::warning::${repo}: immutable source/base references unavailable; Sonar classification remains blocking`);
    return { ...result, blocking: findings };
  }
  const snapshots = new Map();
  let bytes = 0;
  for (const revision of new Set([ref, baseRef])) {
    const tree = await api.request(`/repos/${repo}/git/trees/${encodeURIComponent(revision)}?recursive=1`);
    if (tree.truncated !== false || !Array.isArray(tree.tree) ||
        tree.tree.some((item) => !relativePath(item?.path))) throw new Error(`${repo}: incomplete Sonar test-project inventory`);
    const projects = tree.tree.filter((item) => /\.(cs|fs|vb)proj$/.test(item.path));
    const configs = tree.tree.filter((item) => /(^|\/)Directory\.Build\.(props|targets)$/.test(item.path));
    if (projects.length + configs.length > 32) throw new Error(`${repo}: Sonar test-project inventory exceeds 32 metadata files`);
    const metadata = new Map(await Promise.all([...projects, ...configs].map(async (item) => {
      if (!regular(item)) return [item.path, null];
      const path = item.path.split("/").map(encodeURIComponent).join("/");
      let file;
      try {
        file = await api.request(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(revision)}`);
      } catch (error) {
        if (!error.message.endsWith("HTTP 404")) throw error;
        console.warn(`::warning::${repo}: missing Sonar project metadata ${item.path}; classification remains blocking`);
        return [item.path, null];
      }
      if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" ||
          !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 64_000) return [item.path, null];
      const decoded = Buffer.from(file.content, "base64");
      if (decoded.length !== file.size) return [item.path, null];
      const content = decoded.toString("utf8");
      bytes += Buffer.byteLength(content);
      if (bytes > 180_000) throw new Error(`${repo}: Sonar test-project metadata exceeds 180 KB`);
      return [item.path, content];
    })));
    snapshots.set(revision, { tree: tree.tree, projects, metadata,
      ambiguous: [...metadata].some(([path, content]) => content === null || customCompilation(stripComments(content)) ||
        (/Directory\.Build\.(props|targets)$/.test(path) && /<IsTestProject\b/i.test(stripComments(content)))) });
  }
  const head = snapshots.get(ref);
  const base = snapshots.get(baseRef);
  for (const finding of findings) {
    let project;
    let repositoryPath;
    if (isTestStyleCandidate(finding) && relativePath(finding.path) && finding.path.endsWith(".cs") &&
        !head.ambiguous && !base.ambiguous) {
      const matches = head.tree.filter((item) => regular(item) &&
        (item.path === finding.path || (!finding.path.startsWith("src/") && item.path === `src/${finding.path}`)));
      if (matches.length === 1 && defaultSource(matches[0].path)) {
        repositoryPath = matches[0].path;
        const owners = head.projects.filter((item) => within(repositoryPath, posix.dirname(item.path)));
        if (owners.length === 1 && owners[0].path.endsWith(".csproj")) {
          const path = owners[0].path;
          const baseOwners = base.projects.filter((item) => within(repositoryPath, posix.dirname(item.path)));
          if (baseOwners.length === 1 && baseOwners[0].path === path &&
              verifiedTestProject(head.metadata.get(path)) && verifiedTestProject(base.metadata.get(path))) project = path;
        }
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
