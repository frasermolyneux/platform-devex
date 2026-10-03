import assert from "node:assert/strict";
import test from "node:test";
import { classifySonarFindings, isTestStyleCandidate, SONAR_POLICY_VERSION, verifiedTestProject } from "./sonar-policy.mjs";

const project = "src/Checks/Checks.csproj";
const source = "src/Checks/Regression.cs";
const xml = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="18" /><PackageReference Include="xunit" Version="2" /><PackageReference Include="xunit.runner.visualstudio" /></ItemGroup></Project>';
const finding = {
  id: "sonarcloud:One", source: "sonarcloud", rule: "external_roslyn:IDE0058",
  type: "CODE_SMELL", sonarSeverity: "INFO", severity: "info", path: source,
};
const blob = (path, mode = "100644") => ({ path, mode, type: "blob" });
const file = (content) => ({ type: "file", encoding: "base64", size: Buffer.byteLength(content),
  content: Buffer.from(content).toString("base64") });

function repository() {
  const state = {
    head: { truncated: false, tree: [blob(project), blob(source)] },
    base: { truncated: false, tree: [blob(project)] },
    content: { [`head:${project}`]: xml, [`base:${project}`]: xml },
    calls: [],
  };
  const api = { request: async (path) => {
    state.calls.push(path);
    const tree = path.match(/\/git\/trees\/(head|base)\?recursive=1$/);
    if (tree) return state[tree[1]];
    const request = new URL(path, "https://api.github.com");
    const name = decodeURIComponent(request.pathname.split("/contents/")[1]);
    const key = `${request.searchParams.get("ref")}:${name}`;
    if (!(key in state.content)) throw new Error(`GET ${path} HTTP 404`);
    const content = state.content[key];
    if (content instanceof Error) throw content;
    return typeof content === "string" ? file(content) : content;
  } };
  return { state, api };
}

test("only the six approved exact INFO code-smell rules qualify, never severity alone", () => {
  for (const rule of ["CS1591", "IDE0058", "IDE0022", "IDE0046", "IDE0300", "IDE0305"]) {
    assert.equal(isTestStyleCandidate({ ...finding, rule: `external_roslyn:${rule}` }), true);
  }
  for (const change of [
    { rule: "external_roslyn:CA1305" }, { rule: "external_roslyn:CA1861" }, { rule: "external_roslyn:xUnit2032" },
    { rule: "external_roslyn:unknown" }, { rule: "csharpsquid:IDE0058" }, { source: "code-scanning" },
    { sonarSeverity: "MINOR" }, { sonarSeverity: undefined }, { type: "BUG" }, { type: "VULNERABILITY" },
    { impacts: [{ softwareQuality: "SECURITY", severity: "LOW" }] },
    { impacts: [{ softwareQuality: "RELIABILITY", severity: "LOW" }] },
    { impacts: [{ softwareQuality: "MAINTAINABILITY", severity: "MEDIUM" }] },
    { impacts: {} }, { impacts: null },
  ]) assert.equal(isTestStyleCandidate({ ...finding, ...change }), false, JSON.stringify(change));
  assert.equal(isTestStyleCandidate({ ...finding,
    impacts: [{ softwareQuality: "MAINTAINABILITY", severity: "LOW" }] }), true);
});

test("literal established test tooling is verified; names, commented packages and custom wiring are not", () => {
  assert.equal(verifiedTestProject(xml), true);
  for (const [framework, adapter] of [["xunit.v3", "xunit.runner.visualstudio"],
    ["NUnit", "NUnit3TestAdapter"], ["MSTest.TestFramework", "MSTest.TestAdapter"]]) {
    assert.equal(verifiedTestProject(xml.replace('"xunit"', `"${framework}"`)
      .replace('"xunit.runner.visualstudio"', `"${adapter}"`)), true);
  }
  for (const content of [
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>',
    xml.replace("Microsoft.NET.Test.Sdk", "Production.Sdk"),
    xml.replace("xunit.runner.visualstudio", "MissingAdapter"),
    xml.replace('<PackageReference Include="xunit" Version="2" />', "<!-- xunit package -->"),
    xml.replace("<ItemGroup>", '<ItemGroup Condition="false">'),
    xml.replace("</Project>", '<Import Project="custom.props" /></Project>'),
    xml.replace("</Project>", '<ItemGroup><Compile Remove="Regression.cs" /></ItemGroup></Project>'),
    xml.replace("</Project>", "<PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>"),
    xml.replace("</Project>", "<PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup></Project>"),
    xml.replace("</Project>", "<PropertyGroup><istestproject>false</istestproject></PropertyGroup></Project>"),
    xml.replace("</Project>", '<ItemGroup><PackageReference Remove="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>'),
    xml.replace('<PackageReference Include="Microsoft.NET.Test.Sdk" Version="18" />',
      '<!-- <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18" /> -->'),
  ]) assert.equal(verifiedTestProject(content), false, content);
});

test("new C# test source is verified against both head and trusted base, with src-relative path resolution", async () => {
  const { state, api } = repository();
  const raw = [finding, { ...finding, id: "sonarcloud:Two", path: "Checks/Regression.cs" }];
  const result = await classifySonarFindings(api, "owner/repo", "head", raw, "base");
  assert.equal(result.version, SONAR_POLICY_VERSION);
  assert.equal(result.raw, raw);
  assert.deepEqual(result.blocking, []);
  assert.equal(result.advisory.length, 2);
  assert.ok(result.advisory.every((item) => item.repositoryPath === source && item.testProject === project));
  assert.equal(state.calls.filter((path) => path.includes("/contents/")).length, 2, "metadata shared across findings");
});

test("production, fake/new test projects, overlapping ownership and ambiguous source paths remain blocking", async () => {
  for (const scenario of ["production", "new-project", "overlap", "duplicate-source", "symlink", "missing-source", "conditional", "shared-override", "cross-project-compile"]) {
    const { state, api } = repository();
    if (scenario === "production") state.content[`head:${project}`] = state.content[`base:${project}`] = xml.replace("Microsoft.NET.Test.Sdk", "Production.Sdk");
    if (scenario === "new-project") state.base.tree = [];
    if (scenario === "overlap") {
      state.head.tree.push(blob("Root.csproj")); state.content["head:Root.csproj"] = xml;
    }
    if (scenario === "duplicate-source") state.head.tree.push(blob("Checks/Regression.cs"));
    if (scenario === "symlink") state.head.tree[1].mode = "120000";
    if (scenario === "missing-source") state.head.tree.pop();
    if (scenario === "conditional") state.content[`base:${project}`] = xml.replace("<ItemGroup>", '<ItemGroup Condition="false">');
    if (scenario === "shared-override") {
      state.head.tree.push(blob("Directory.Build.props"));
      state.content["head:Directory.Build.props"] = "<Project><PropertyGroup><IsTestProject>false</IsTestProject></PropertyGroup></Project>";
    }
    if (scenario === "cross-project-compile") {
      state.head.tree.push(blob("src/App/App.csproj"));
      state.content["head:src/App/App.csproj"] = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="../Checks/*.cs" /></ItemGroup></Project>';
    }
    const value = scenario === "duplicate-source" ? { ...finding, path: "Checks/Regression.cs" } : finding;
    const result = await classifySonarFindings(api, "owner/repo", "head", [value], "base");
    assert.deepEqual(result.advisory, [], scenario);
    assert.deepEqual(result.blocking, [value], scenario);
  }
});

test("metadata failures are explicit and can never turn unknown classification into advisory", async () => {
  for (const scenario of ["404", "encoding", "missing-size", "truncated", "permission", "limit", "no-base"]) {
    const { state, api } = repository();
    if (scenario === "404") delete state.content[`base:${project}`];
    if (scenario === "encoding") state.content[`base:${project}`] = { ...file(xml), encoding: "none" };
    if (scenario === "missing-size") state.content[`base:${project}`] = { ...file(xml), size: undefined };
    if (scenario === "truncated") state.head.truncated = true;
    if (scenario === "permission") state.content[`base:${project}`] = new Error("GET metadata HTTP 403");
    if (scenario === "limit") state.head.tree.push(...Array.from({ length: 32 }, (_, n) => blob(`other${n}/Project.csproj`)));
    const run = () => classifySonarFindings(api, "owner/repo", "head", [finding], scenario === "no-base" ? null : "base");
    if (["truncated", "permission", "limit"].includes(scenario)) {
      await assert.rejects(run(), /inventory|HTTP 403/);
    } else {
      const result = await run();
      assert.deepEqual(result.blocking, [finding], scenario);
      assert.deepEqual(result.advisory, [], scenario);
    }
  }
});

test("ineligible findings need no repository lookup and stay raw/blocking", async () => {
  const { state, api } = repository();
  const findings = [{ ...finding, rule: "external_roslyn:CA1305" }, { ...finding, path: "src/a.test.js" }];
  const result = await classifySonarFindings(api, "owner/repo", "head", findings, "base");
  assert.deepEqual(result.blocking, findings);
  assert.equal(result.raw, findings);
  assert.deepEqual(state.calls, []);
});

test("SDK-excluded output/hidden files and custom output paths cannot masquerade as compiled test source", async () => {
  for (const folder of ["obj", "bin", "node_modules", ".generated"]) {
    const { state, api } = repository();
    const path = `src/Checks/${folder}/Regression.cs`;
    state.head.tree[1].path = path;
    const item = { ...finding, path };
    const result = await classifySonarFindings(api, "owner/repo", "head", [item], "base");
    assert.deepEqual(result.blocking, [item]);
    assert.deepEqual(result.advisory, []);
  }
  assert.equal(verifiedTestProject(xml.replace("</Project>",
    "<PropertyGroup><BaseIntermediateOutputPath>custom/</BaseIntermediateOutputPath></PropertyGroup></Project>")), false);
});
