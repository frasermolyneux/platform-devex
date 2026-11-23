import { createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { GitHubApi } from "./repository-standards.mjs";

export const SOURCE_REPOSITORY = "frasermolyneux/platform-workloads";
export const CONSUMER_REPOSITORY = "frasermolyneux/platform-baremetal";
export const SOURCE_PATH = "terraform/ingress/catalog.json";
export const CONSUMER_PATH = "ansible/roles/http_ingress_catalog/files/catalog.json";
export const CONSUMER_SOURCE_PATH = "ansible/roles/http_ingress_catalog/files/source.json";

const SHA = /^[a-f0-9]{40}$/;
const MAX_FILE_BYTES = 256 * 1024;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/;
const PRIVATE_DNS = {
  resolvers: ["100.94.115.109", "100.87.229.111"],
  servers: { ns346663: "100.94.115.109", ns5019527: "100.87.229.111" },
  ttl: 0,
  authorization: "tailscale-identity",
};
const PRIVATE_ROUTES = {
  "idp.molyneux.io": {
    workload: "platform-developer-portal",
    upstream: "platform-developer-portal:8080",
  },
  "radar.molyneux.io": {
    workload: "platform-radar",
    upstream: "platform-radar:8080",
  },
};

function finding(findings, code, message, hostname, source) {
  const safe = (value) => String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`")
    .slice(0, 240);
  findings.push({
    code,
    message: safe(message),
    ...(hostname ? { hostname: safe(hostname) } : {}),
    ...(source ? { source } : {}),
  });
}

function validObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return validObject(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function verifiedContent(file, label) {
  if (file?.type !== "file" || file.encoding !== "base64" ||
      !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES ||
      typeof file.content !== "string" || !SHA.test(file.sha)) {
    throw new Error(`${label} is not a bounded GitHub file`);
  }
  const encoded = file.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`${label} has invalid base64 content`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== file.size || bytes.toString("base64") !== encoded) {
    throw new Error(`${label} has inconsistent content size`);
  }
  const gitSha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (gitSha !== file.sha) throw new Error(`${label} does not match its Git blob identity`);
  return bytes;
}

async function readFileAt(api, repository, path, revision, label) {
  const file = await api.get(`/repos/${repository}/contents/${path}?ref=${encodeURIComponent(revision)}`);
  return { bytes: verifiedContent(file, label), sha: file.sha };
}

function recordPrivateRoute(findings, host, hostname) {
  const metadata = host.target.private_ingress;
  const expectedRoute = PRIVATE_ROUTES[hostname];
  if (!validObject(metadata)) {
    finding(findings, "private-route-invalid", "Required private ingress metadata is missing.", hostname);
    return;
  }
  if (host.target.private !== true || metadata.server !== host.route.server ||
      metadata.profile !== host.route.profile || metadata.upstream !== host.route.upstream ||
      metadata.server !== "ns346663" || metadata.profile !== "shared" ||
      metadata.proxy !== "platform-caddy" || metadata.network !== "platform-ingress" ||
      !exactKeys(metadata, ["server", "profile", "proxy", "network", "listener", "upstream", "trusted_proxy"]) ||
      !exactKeys(metadata.listener, ["bind", "routing", "port"]) ||
      metadata.listener.bind !== "tailscale" || metadata.listener.routing !== "hostname" ||
      metadata.listener.port !== 443 ||
      !exactKeys(metadata.trusted_proxy, ["proxy", "network"]) ||
      metadata.trusted_proxy.proxy !== metadata.proxy ||
      metadata.trusted_proxy.network !== metadata.network ||
      host.workload !== expectedRoute.workload || host.route.server !== "ns346663" ||
      host.route.profile !== "shared" || host.route.upstream !== expectedRoute.upstream) {
    finding(findings, "private-route-invalid",
      "Private ingress metadata does not match the approved Tailscale listener, proxy, network, and upstream contract.",
      hostname);
  }
}

export function validateIngressCatalog(catalog) {
  const findings = [];
  if (!validObject(catalog) || catalog.version !== 1 || !Array.isArray(catalog.hosts)) {
    finding(findings, "catalog-invalid", "Catalog must be a version 1 object with a hosts array.");
    return findings;
  }

  const byHostname = new Map();
  for (const host of catalog.hosts) {
    if (!validObject(host)) {
      finding(findings, "catalog-invalid", "Catalog contains a non-object host entry.");
      continue;
    }
    const hostname = host.hostname;
    if (typeof hostname !== "string" || !HOSTNAME.test(hostname) ||
        !validObject(host.route) || !validObject(host.target) ||
        typeof host.workload !== "string" || !host.workload.trim()) {
      finding(findings, "catalog-invalid", "Host entry has an invalid hostname, owner, route, or target.", hostname);
      continue;
    }
    const owners = byHostname.get(hostname) ?? [];
    owners.push(host.workload);
    byHostname.set(hostname, owners);
    if (!["proxied", "dns-only", "private-only"].includes(host.target.public_mode) ||
        typeof host.target.private !== "boolean" ||
        !(host.target.alias_to === null || typeof host.target.alias_to === "string")) {
      finding(findings, "catalog-invalid", "Host target has an invalid public mode, private flag, or alias.", hostname);
    }
    if (host.target.status_brand != null &&
        (!["mx", "xi"].includes(host.target.status_brand) ||
          host.target.alias_to !== null || host.target.public_mode !== "proxied")) {
      finding(findings, "invalid-alias",
        "Maintenance branding is only valid on proxied canonical hosts.", hostname);
    }
  }

  for (const [hostname, owners] of byHostname) {
    if (owners.length > 1) {
      finding(findings, "duplicate-owner",
        `Hostname is declared more than once (owners: ${[...new Set(owners)].sort().join(", ")}).`,
        hostname);
    }
  }

  for (const host of catalog.hosts.filter((entry) => validObject(entry) && validObject(entry.target))) {
    const hostname = host.hostname;
    const alias = host.target.alias_to;
    if (alias !== null) {
      const target = byHostname.has(alias)
        ? catalog.hosts.find((entry) => entry?.hostname === alias)
        : null;
      if (!target) {
        finding(findings, "invalid-alias", "Alias target is not a catalog hostname.", hostname);
      } else {
        if (target.target?.alias_to !== null) {
          finding(findings, "invalid-alias", "Alias target must be a canonical hostname, not another alias.",
            hostname);
        }
        if (host.target.public_mode !== "private-only" &&
            target.target?.public_mode === "private-only") {
          finding(findings, "invalid-alias", "Public alias cannot target a private-only hostname.", hostname);
        }
      }
    }

    if (Object.hasOwn(host.target, "private_ingress") && host.target.private_ingress !== null) {
      recordPrivateRoute(findings, host, hostname);
    }
  }

  for (const hostname of Object.keys(PRIVATE_ROUTES)) {
    const host = catalog.hosts.find((entry) => entry?.hostname === hostname);
    if (!host) {
      finding(findings, "private-route-invalid", "Required private route is absent from the catalog.", hostname);
    } else if (host.target?.private_ingress === null ||
        host.target?.private_ingress === undefined) {
      recordPrivateRoute(findings, host, hostname);
    }
  }

  const privateDns = catalog.private_dns;
  if (!exactKeys(privateDns, ["resolvers", "servers", "ttl", "authorization"]) ||
      !Array.isArray(privateDns.resolvers) ||
      JSON.stringify([...privateDns.resolvers].sort()) !== JSON.stringify([...PRIVATE_DNS.resolvers].sort()) ||
      !exactKeys(privateDns.servers, Object.keys(PRIVATE_DNS.servers)) ||
      Object.entries(PRIVATE_DNS.servers).some(([server, address]) => privateDns.servers[server] !== address) ||
      privateDns.ttl !== PRIVATE_DNS.ttl ||
      privateDns.authorization !== PRIVATE_DNS.authorization) {
    finding(findings, "private-route-invalid",
      "Private DNS resolver, server, TTL, or identity-authorization baseline has drifted.");
  }

  return findings;
}

function parseSourceRecord(bytes) {
  const source = parseJson(bytes, "Consumer source record");
  if (!exactKeys(source, ["repository", "revision", "path", "blob_sha"]) ||
      source.repository !== SOURCE_REPOSITORY || source.path !== SOURCE_PATH ||
      typeof source.revision !== "string" || !SHA.test(source.revision) ||
      typeof source.blob_sha !== "string" || !SHA.test(source.blob_sha)) {
    throw new Error("Consumer source record is not a valid pinned ingress catalog reference");
  }
  return source;
}

function repositoryMetadata(meta, repository) {
  if (meta?.full_name !== repository || meta.archived !== false || meta.fork !== false ||
      typeof meta.default_branch !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(meta.default_branch)) {
    throw new Error(`${repository} is not an active canonical repository`);
  }
}

export async function auditIngressContract({ workloadsApi, baremetalApi }) {
  const [workloadsMeta, baremetalMeta] = await Promise.all([
    workloadsApi.get(`/repos/${SOURCE_REPOSITORY}`),
    baremetalApi.get(`/repos/${CONSUMER_REPOSITORY}`),
  ]);
  repositoryMetadata(workloadsMeta, SOURCE_REPOSITORY);
  repositoryMetadata(baremetalMeta, CONSUMER_REPOSITORY);
  const consumerRef = await baremetalApi.get(
    `/repos/${CONSUMER_REPOSITORY}/git/ref/heads/${encodeURIComponent(baremetalMeta.default_branch)}`);
  const consumerRevision = consumerRef.object?.sha;
  if (consumerRef.object?.type !== "commit" || typeof consumerRevision !== "string" ||
      !SHA.test(consumerRevision)) {
    throw new Error("Consumer default branch does not resolve to an immutable commit");
  }

  const [sourceRecordFile, consumerFile] = await Promise.all([
    readFileAt(baremetalApi, CONSUMER_REPOSITORY, CONSUMER_SOURCE_PATH,
      consumerRevision, "Consumer source record"),
    readFileAt(baremetalApi, CONSUMER_REPOSITORY, CONSUMER_PATH,
      consumerRevision, "Consumer catalog"),
  ]);
  const sourceRecord = parseSourceRecord(sourceRecordFile.bytes);
  const canonicalFile = await readFileAt(workloadsApi, SOURCE_REPOSITORY,
    SOURCE_PATH, sourceRecord.revision, "Pinned source catalog");
  if (canonicalFile.sha !== sourceRecord.blob_sha) {
    throw new Error("Pinned source catalog blob does not match the consumer source record");
  }

  const drift = !consumerFile.bytes.equals(canonicalFile.bytes);
  const canonicalCatalog = parseJson(canonicalFile.bytes, "Pinned source catalog");
  const consumerCatalog = drift
    ? parseJson(consumerFile.bytes, "Consumer catalog")
    : canonicalCatalog;
  const findings = validateIngressCatalog(canonicalCatalog)
    .map((item) => ({ ...item, source: "pinned-source" }));
  if (drift) {
    finding(findings, "catalog-drift",
      "Consumer catalog bytes differ from the exact pinned platform-workloads source.", undefined, "consumer");
    findings.push(...validateIngressCatalog(consumerCatalog)
      .map((item) => ({ ...item, source: "consumer" })));
  }

  return {
    sourceRepository: SOURCE_REPOSITORY,
    sourceRevision: sourceRecord.revision,
    consumerRepository: CONSUMER_REPOSITORY,
    consumerRevision,
    hosts: Array.isArray(consumerCatalog.hosts) ? consumerCatalog.hosts.length : 0,
    status: findings.length ? "findings" : "current",
    findings,
  };
}

function markdown(result) {
  const lines = [
    "## Shared HTTP ingress contract audit",
    "",
    `Status: **${result.status}**; hosts: ${result.hosts}; source: \`${result.sourceRevision ?? "unavailable"}\`; consumer revision: \`${result.consumerRevision ?? "unavailable"}\`.`,
    "",
    "This read-only audit reports catalog findings; it does not assert live routing or renderer adoption, change configuration, deploy, or authorize cutover.",
  ];
  if (result.findings?.length) {
    lines.push("", "| Source | Check | Host | Finding |", "| --- | --- | --- | --- |");
    for (const item of result.findings) {
      lines.push(`| ${item.source ?? "pinned-source"} | ${item.code} | ${item.hostname ?? "—"} | ${item.message} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const result = await auditIngressContract({
    workloadsApi: new GitHubApi(process.env.WORKLOADS_TOKEN),
    baremetalApi: new GitHubApi(process.env.BAREMETAL_TOKEN),
  });
  await writeFile("http-ingress-contract-result.json", `${JSON.stringify(result, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown(result));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
