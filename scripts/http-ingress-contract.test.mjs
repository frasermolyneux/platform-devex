import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  auditIngressContract,
  CONSUMER_PATH,
  CONSUMER_REPOSITORY,
  CONSUMER_SOURCE_PATH,
  SOURCE_PATH,
  SOURCE_REPOSITORY,
  validateIngressCatalog,
} from "./http-ingress-contract.mjs";

const revision = "a".repeat(40);

function privateIngress(upstream) {
  return {
    server: "ns346663",
    profile: "shared",
    proxy: "platform-caddy",
    network: "platform-ingress",
    listener: { bind: "tailscale", routing: "hostname", port: 443 },
    upstream,
    trusted_proxy: { proxy: "platform-caddy", network: "platform-ingress" },
  };
}

function host(hostname, workload, target = {}, route = {}) {
  return {
    hostname,
    workload,
    zone: "example",
    route: { server: "ns346663", profile: "shared", upstream: `${workload}:8080`, ...route },
    current: { public_mode: null, status: false, private: false },
    target: { public_mode: "proxied", alias_to: null, status_brand: null, private: false, ...target },
  };
}

function catalog() {
  return {
    version: 1,
    private_dns: {
      resolvers: ["100.94.115.109", "100.87.229.111"],
      servers: { ns346663: "100.94.115.109", ns5019527: "100.87.229.111" },
      ttl: 0,
      authorization: "tailscale-identity",
    },
    hosts: [
      host("example.com", "site", { status_brand: "mx" }),
      host("www.example.com", "site", { alias_to: "example.com" }),
      host("idp.molyneux.io", "platform-developer-portal", {
        private: true, private_ingress: privateIngress("platform-developer-portal:8080"),
      }, { upstream: "platform-developer-portal:8080" }),
      host("radar.molyneux.io", "platform-radar", {
        private: true, private_ingress: privateIngress("platform-radar:8080"),
      }, { upstream: "platform-radar:8080" }),
    ],
  };
}

function gitBlob(content) {
  const bytes = Buffer.from(content);
  const sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  return { type: "file", encoding: "base64", size: bytes.length, sha,
    content: bytes.toString("base64") };
}

function fixture({ consumerCatalog = JSON.stringify(catalog()), sourceCatalog = JSON.stringify(catalog()) } = {}) {
  const canonical = gitBlob(sourceCatalog);
  const sourceRecord = gitBlob(JSON.stringify({
    repository: SOURCE_REPOSITORY,
    revision,
    path: SOURCE_PATH,
    blob_sha: canonical.sha,
  }));
  const consumer = gitBlob(consumerCatalog);
  const files = new Map([
    [`${CONSUMER_SOURCE_PATH}?ref=${revision}`, sourceRecord],
    [`${CONSUMER_PATH}?ref=${revision}`, consumer],
    [`${SOURCE_PATH}?ref=${revision}`, canonical],
  ]);
  const makeApi = (repository) => ({
    async get(endpoint) {
      if (endpoint === `/repos/${repository}`) {
        return { full_name: repository, archived: false, fork: false, default_branch: "main" };
      }
      if (endpoint === `/repos/${repository}/git/ref/heads/main`) {
        return { object: { sha: revision, type: "commit" } };
      }
      const prefix = `/repos/${repository}/contents/`;
      if (!endpoint.startsWith(prefix)) throw new Error(`Unexpected request ${endpoint}`);
      const file = files.get(endpoint.slice(prefix.length));
      if (!file) throw new Error(`Unexpected file request ${endpoint}`);
      return structuredClone(file);
    },
  });
  return {
    workloadsApi: makeApi(SOURCE_REPOSITORY),
    baremetalApi: makeApi(CONSUMER_REPOSITORY),
  };
}

test("validates the pinned ingress catalog and its private-route baseline", () => {
  assert.deepEqual(validateIngressCatalog(catalog()), []);
});

test("reports duplicate hostname owners, chained or unsafe aliases, and invalid private routes", () => {
  const value = catalog();
  value.hosts.push(host("example.com", "other-owner"));
  value.hosts[1].target.alias_to = "missing.example";
  value.hosts[0].target.public_mode = "private-only";
  value.hosts[1].target.alias_to = "example.com";
  value.hosts[1].target.public_mode = "proxied";
  value.hosts.push(host("alias.example.com", "site", { alias_to: "www.example.com" }));
  value.hosts.find((entry) => entry.hostname === "radar.molyneux.io")
    .target.private_ingress.trusted_proxy.network = "wrong-network";

  const findings = validateIngressCatalog(value);
  assert.ok(findings.some((item) => item.code === "duplicate-owner" && item.hostname === "example.com"));
  assert.ok(findings.some((item) => item.code === "invalid-alias" &&
    item.hostname === "alias.example.com" && item.message.includes("canonical")));
  assert.ok(findings.some((item) => item.code === "invalid-alias" &&
    item.hostname === "www.example.com" && item.message.includes("private-only")));
  assert.ok(findings.some((item) => item.code === "private-route-invalid" &&
    item.hostname === "radar.molyneux.io"));
});

test("reports private DNS resolver, TTL, and authorization drift", () => {
  const value = catalog();
  value.private_dns.ttl = 30;
  value.private_dns.authorization = "ip-allowlist";
  const findings = validateIngressCatalog(value);
  assert.ok(findings.some((item) => item.code === "private-route-invalid" &&
    item.message.includes("Private DNS")));
});

test("sanitizes catalog-supplied names before publishing findings", () => {
  const value = catalog();
  value.hosts[0].hostname = "example.com|`malformed`";
  value.hosts[1].target.alias_to = "example.com|`malformed`";
  const findings = validateIngressCatalog(value);
  const invalid = findings.find((item) => item.code === "catalog-invalid");
  assert.ok(invalid);
  assert.equal(invalid.hostname, "example.com\\|\\`malformed\\`");
});

test("audits the consumer copy against its exact pinned source without requiring the latest source pin", async () => {
  const f = fixture();
  const result = await auditIngressContract(f);
  assert.equal(result.status, "current");
  assert.equal(result.sourceRepository, SOURCE_REPOSITORY);
  assert.equal(result.consumerRepository, CONSUMER_REPOSITORY);
  assert.equal(result.consumerRevision, revision);
  assert.equal(result.hosts, 4);
  assert.deepEqual(result.findings, []);
});

test("reports consumer catalog byte drift and its invalid alias contract", async () => {
  const consumer = catalog();
  consumer.hosts[1].target.alias_to = "missing.example";
  const f = fixture({ consumerCatalog: JSON.stringify(consumer) });
  const result = await auditIngressContract(f);
  assert.equal(result.status, "findings");
  assert.ok(result.findings.some((item) => item.code === "catalog-drift" && item.source === "consumer"));
  assert.ok(result.findings.some((item) => item.code === "invalid-alias" &&
    item.source === "consumer" && item.hostname === "www.example.com"));
});

test("workflow is report-only, read-only on targets, and follows repository workflow conventions", async () => {
  const workflow = await readFile(new URL("../.github/workflows/http-ingress-contract.yml", import.meta.url), "utf8");
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /permission-contents: read/g);
  assert.match(workflow, /repositories: platform-workloads/);
  assert.match(workflow, /repositories: platform-baremetal/);
  assert.match(workflow, /run: node scripts\/http-ingress-contract\.mjs/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /actions: read/);
  assert.doesNotMatch(workflow, /permission-contents: write|terraform apply|ansible-playbook|deployment-guard/i);
  assert.match(workflow, /status != "current"/);
  assert.doesNotMatch(workflow, /gh\s+pr\s+merge\b|\/merges\b|enablePullRequestAutoMerge/);
});
