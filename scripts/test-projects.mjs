import { posix } from "node:path";

export const relativePath = (path) => typeof path === "string" && path.length > 0 &&
  !path.startsWith("/") && !path.includes("\\") && !path.includes(":") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
const within = (file, directory) => directory === "." || file.startsWith(`${directory}/`);
const defaultSource = (path) => !path.split("/").some((part) =>
  part.startsWith(".") || /^(bin|obj|node_modules)$/i.test(part));
const regular = (item) => item.type === "blob" && ["100644", "100755"].includes(item.mode);
const stripComments = (xml) => xml.replace(/<!--[\s\S]*?-->/g, "");
// Linked source and custom MSBuild composition can make nominal test source production code too.
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

export async function loadTestProjects(api, repo, ref, baseRef = ref) {
  if (typeof ref !== "string" || !ref || typeof baseRef !== "string" || !baseRef) {
    console.warn(`::warning::${repo}: immutable source/base references unavailable; test-source classification remains unverified`);
    return null;
  }
  const snapshots = new Map();
  let bytes = 0;
  for (const revision of new Set([ref, baseRef])) {
    const tree = await api.request(`/repos/${repo}/git/trees/${encodeURIComponent(revision)}?recursive=1`);
    if (tree.truncated !== false || !Array.isArray(tree.tree) ||
        tree.tree.some((item) => !relativePath(item?.path))) throw new Error(`${repo}: incomplete test-project inventory`);
    const projects = tree.tree.filter((item) => /\.(cs|fs|vb)proj$/.test(item.path));
    const configs = tree.tree.filter((item) => /(^|\/)Directory\.Build\.(props|targets)$/.test(item.path));
    if (projects.length + configs.length > 32) throw new Error(`${repo}: test-project inventory exceeds 32 metadata files`);
    const metadata = new Map(await Promise.all([...projects, ...configs].map(async (item) => {
      if (!regular(item)) return [item.path, null];
      const path = item.path.split("/").map(encodeURIComponent).join("/");
      let file;
      try {
        file = await api.request(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(revision)}`);
      } catch (error) {
        if (!error.message.endsWith("HTTP 404")) throw error;
        console.warn(`::warning::${repo}: missing project metadata ${item.path}; test-source classification remains unverified`);
        return [item.path, null];
      }
      if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" ||
          !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 64_000) return [item.path, null];
      const decoded = Buffer.from(file.content, "base64");
      if (decoded.length !== file.size) return [item.path, null];
      const content = decoded.toString("utf8");
      bytes += Buffer.byteLength(content);
      if (bytes > 180_000) throw new Error(`${repo}: test-project metadata exceeds 180 KB`);
      return [item.path, content];
    })));
    snapshots.set(revision, { tree: tree.tree, projects, metadata,
      ambiguous: [...metadata].some(([path, content]) => content === null || customCompilation(stripComments(content)) ||
        (/Directory\.Build\.(props|targets)$/.test(path) && /<IsTestProject\b/i.test(stripComments(content)))) });
  }
  return { head: snapshots.get(ref), base: snapshots.get(baseRef) };
}

export function testSourceProject(inventory, path, revision = "head") {
  if (!inventory || !relativePath(path) || !path.endsWith(".cs") || !defaultSource(path) ||
      inventory.head.ambiguous || inventory.base.ambiguous) return null;
  const snapshot = inventory[revision];
  if (!snapshot.tree.some((item) => item.path === path && regular(item))) return null;
  const owners = inventory.head.projects.filter((item) => within(path, posix.dirname(item.path)));
  const baseOwners = inventory.base.projects.filter((item) => within(path, posix.dirname(item.path)));
  if (owners.length !== 1 || baseOwners.length !== 1 || owners[0].path !== baseOwners[0].path ||
      !owners[0].path.endsWith(".csproj")) return null;
  const project = owners[0].path;
  return verifiedTestProject(inventory.head.metadata.get(project)) &&
    verifiedTestProject(inventory.base.metadata.get(project)) ? project : null;
}
