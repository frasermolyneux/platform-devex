"""Compile reviewed publication routes; stage patches without writing target worktrees."""

import argparse
import base64
import copy
import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote

import yaml


SCHEMA = "publication-guard-installation-v1"
GUARD_SHA = "a5feb7a0c74bd1c6db001344eb494bb5803e7576"
GUARD_TAG = "repository-publication-origin/v1.0.0"
GUARD = f"frasermolyneux/actions/repository-publication-origin@{GUARD_SHA}"
GUARD_FILES = {
    "origin.mjs": "5227ca43c3b26b42101dff2e5f5617f020074f64012cbfa8c90af95bce43f21d",
    "action.yml": "bb0e16af3027c1f9cf3681852dffa6b377f09d7a010e94fd6253a275588e32a6",
}
RECIPES_DIGEST = "a582daacc9f2c01a02c5f7fd43aef829a62a212514ead29c0182a239653081ce"
CLOSURE_DIGEST = "d08ffe5f5d3ffac95e13af5db959409613bc805c99bec738514f21732adf719a"
JOB = "publication-origin"
EXEMPT = {"41-bovet-street", "CoD4x_Server", "portal-bots", "status-pages"}
WORKFLOW = re.compile(r"\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml")
HEX40 = re.compile(r"[a-f0-9]{40}")
HEX64 = re.compile(r"[a-f0-9]{64}")


class Refusal(ValueError):
    pass


def require(condition, category):
    if not condition:
        raise Refusal(category)


def digest(content):
    return hashlib.sha256(content).hexdigest()


def blob(content):
    return hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate-json-key")
        result[key] = value
    return result


def read_json(filename, expected_digest=None):
    data = Path(filename).read_bytes()
    require(expected_digest is None or digest(data) == expected_digest, "authority-digest-mismatch")
    return json.loads(data, object_pairs_hook=no_duplicates)


def parse(text):
    require("\t" not in text and "\0" not in text and not text.startswith("\ufeff"), "unsupported-yaml")
    for event in yaml.parse(text, Loader=yaml.BaseLoader):
        require(not isinstance(event, yaml.events.AliasEvent) and not getattr(event, "anchor", None),
                "yaml-alias-or-anchor")
    node = yaml.compose(text, Loader=yaml.BaseLoader)

    def value(item):
        if isinstance(item, yaml.ScalarNode):
            require(item.tag == "tag:yaml.org,2002:str", "unsupported-yaml-tag")
            return item.value
        if isinstance(item, yaml.SequenceNode):
            require(item.tag == "tag:yaml.org,2002:seq", "unsupported-yaml-tag")
            return [value(child) for child in item.value]
        require(isinstance(item, yaml.MappingNode), "unsupported-yaml")
        require(item.tag == "tag:yaml.org,2002:map", "unsupported-yaml-tag")
        pairs = [(value(key), value(child)) for key, child in item.value]
        require(all(isinstance(key, str) and key != "<<" for key, _ in pairs), "unsupported-yaml-key")
        return no_duplicates(pairs)

    return value(node), node


def mapping(node):
    require(isinstance(node, yaml.MappingNode) and not node.flow_style, "unsupported-flow-mapping")
    return {key.value: (key, value) for key, value in node.value}


def needs(job):
    result = job.get("needs", [])
    if isinstance(result, str):
        result = [result]
    require(isinstance(result, list) and all(isinstance(item, str) and
            re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", item) for item in result), "dynamic-or-invalid-needs")
    require(len(set(result)) == len(result), "duplicate-needs")
    return result


def check_graph(jobs):
    visiting, complete = set(), set()

    def visit(name):
        require(name in jobs, "missing-dependency")
        require(name not in visiting, "cyclic-dependency")
        if name in complete:
            return
        visiting.add(name)
        for dependency in needs(jobs[name]):
            visit(dependency)
        visiting.remove(name)
        complete.add(name)

    for name in jobs:
        visit(name)


def scoped(repository):
    require(isinstance(repository, str) and
            re.fullmatch(r"frasermolyneux/[A-Za-z0-9_.-]+", repository), "excluded-owner")
    name = repository.split("/")[1]
    require(not name.startswith("xi-") and name not in EXEMPT and
            name != "baremetal-workload-canary", "excluded-repository")
    return name


def blocker(repository, path, document, routes):
    if not any(route["classification"] == "publication" for route in routes.values()):
        return None
    events = document.get("on")
    require(isinstance(events, dict), "ambiguous-events")
    if repository == "frasermolyneux/molyneux-me" and path == ".github/workflows/deploy-prd.yml":
        return "guard-missing-approved-dependency-dispatch-lineage"
    if "workflow_run" in events:
        return "guard-missing-direct-producer-definition-binding"
    if set(events) - {"push", "workflow_dispatch", "schedule"}:
        return "guard-unsupported-existing-publication-event"
    return None


def guard_job(app_id):
    return f"""  {JOB}:
    name: Verify original publication origin
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
      pull-requests: read
    outputs:
      publication-allowed: ${{{{ steps.origin.outputs.publication-allowed }}}}
    steps:
      - name: Resolve immutable original origin
        id: origin
        uses: {GUARD}
        with:
          github-token: ${{{{ github.token }}}}
          app-id: '{app_id}'
          allow-app-authored-merges: 'false'
          trusted-producers: '[]'
      - name: Require a proved publication origin
        shell: bash
        env:
          PUBLICATION_ALLOWED: ${{{{ steps.origin.outputs.publication-allowed }}}}
        run: |
          if [[ "$PUBLICATION_ALLOWED" != "true" ]]; then
            echo "::error::Publication held: original origin is denied or incomplete."
            exit 1
          fi

"""


def expression(original):
    require(isinstance(original, str) and original.strip(), "invalid-job-if")
    result = original.strip()
    if result.startswith("${{"):
        require(result.endswith("}}"), "invalid-job-if")
        result = result[3:-2].strip()
    require("${{" not in result and "}}" not in result, "ambiguous-job-if")
    return result


def transform(text, declaration, repository, app_id):
    expected, _ = parse(declaration["content"])
    routes = declaration["jobs"]
    require(isinstance(expected.get("jobs"), dict) and
            set(expected["jobs"]) == set(routes), "incomplete-job-declarations")
    require(JOB not in expected["jobs"], "reserved-job-collision")
    for name, route in routes.items():
        require(route["classification"] in {"publication", "readonly", "existing-controller"},
                "unclassified-job")
        require(route["definition"] == expected["jobs"][name], "job-definition-mismatch")
        require(isinstance(route.get("effects"), list) and
                digest(canonical(route["effects"]).encode()) == route.get("effectDigest"),
                "missing-or-changed-effect-declaration")
        require(route["classification"] != "publication" or route["effects"], "missing-publication-effects")
    check_graph(expected["jobs"])
    reason = blocker(repository, declaration["path"], expected, routes)
    if reason:
        raise Refusal(reason)
    publishing = [name for name, route in routes.items() if route["classification"] == "publication"]
    if not publishing:
        require(text == declaration["content"], "changed-unreviewed-workflow")
        return text
    _, root = parse(declaration["content"])
    root_fields = mapping(root)
    jobs_node = root_fields["jobs"][1]
    job_nodes = mapping(jobs_node)
    require(all(key.start_mark.column == 2 for key, _ in job_nodes.values()), "unsupported-job-indentation")
    newline = "\r\n" if "\r\n" in declaration["content"] else "\n"
    require(newline == "\n" or "\n" not in declaration["content"].replace("\r\n", ""),
            "mixed-line-endings")
    offsets = [0]
    offsets.extend(match.end() for match in re.finditer("\n", declaration["content"]))
    edits = []
    gated = copy.deepcopy(expected)
    for name in publishing:
        job = expected["jobs"][name]
        fields = mapping(job_nodes[name][1])
        require("uses" in job or isinstance(job.get("steps"), list), "invalid-job-shape")
        old_if = expression(job.get("if", "success()"))
        new_if = f"${{{{ ({old_if}) && needs.{JOB}.result == 'success' && needs.{JOB}.outputs.publication-allowed == 'true' }}}}"
        new_needs = needs(job) + [JOB]
        additions = []
        for field, replacement in [("if", new_if), ("needs", new_needs)]:
            rendered = f"{field}: {json.dumps(replacement, ensure_ascii=False)}"
            if field in fields:
                key, item = fields[field]
                end = item.end_mark.index
                if item.end_mark.line > key.start_mark.line and item.end_mark.column <= key.start_mark.column:
                    end = offsets[item.end_mark.line]
                    rendered += newline
                edits.append((key.start_mark.index, end, rendered))
            else:
                additions.append("    " + rendered + newline)
            gated["jobs"][name][field] = replacement
        if additions:
            start = offsets[job_nodes[name][1].start_mark.line]
            edits.append((start, start, "".join(additions)))
    generated_guard = guard_job(app_id).replace("\n", newline)
    insertion = offsets[jobs_node.start_mark.line]
    edits.append((insertion, insertion, generated_guard))
    generated = declaration["content"]
    for start, end, replacement in sorted(edits, reverse=True):
        generated = generated[:start] + replacement + generated[end:]
    gated["jobs"][JOB] = parse("jobs:\n" + guard_job(app_id))[0]["jobs"][JOB]
    observed, _ = parse(generated)
    require(observed == gated, "yaml-preservation-verification-failed")
    require(text in {declaration["content"], generated}, "changed-unreviewed-workflow")
    return generated


def inventory(recipes_path, closure_path, output):
    recipes = read_json(recipes_path, RECIPES_DIGEST)
    closure = read_json(closure_path, CLOSURE_DIGEST)
    require(recipes["schema"] == "estate-analysis-recipe-sources-v1" and
            closure["schema"] == "estate-semantic-job-closure-v1" and
            not closure["unresolved"], "unreviewed-authority")
    require(len(recipes["targets"]) == 50 and len(closure["jobs"]) == 802 and
            sum(job["potentialPublication"] for job in closure["jobs"]) == 277 and
            len(closure["workflowRunEdges"]) == 14, "authority-count-mismatch")
    directory = new_output(output)
    receipts = []
    for target in recipes["targets"]:
        if target["profile"].get("exemption"):
            continue
        scoped(target["repository"])
        workflows = []
        for source in target["sources"]:
            if source["kind"] != "workflow":
                continue
            document, _ = parse(source["content"])
            routes = {}
            for job in closure["jobs"]:
                if job["repository"] != target["repository"] or job["workflow"] != source["path"]:
                    continue
                require(job["job"] not in routes and job["sourceSha"] == target["sourceSha"] and
                        job["workflowBlobSha"] == source["blobSha"], "ambiguous-source-binding")
                definition = document["jobs"][job["job"]]
                old_if = definition.get("if")
                require(old_if == job["if"] and needs(definition) == job["needs"] and
                        document["on"] == job["triggers"], "original-gate-mismatch")
                classification = "publication" if job["potentialPublication"] else (
                    "existing-controller" if job["existingExplicitDependencyDispatch"] else "readonly")
                routes[job["job"]] = {"classification": classification, "definition": definition,
                                     "effects": job["effects"],
                                     "effectDigest": digest(canonical(job["effects"]).encode())}
            require(set(routes) == set(document["jobs"]), "incomplete-reviewed-job-closure")
            require(blob(source["content"].encode()) == source["blobSha"], "source-blob-mismatch")
            workflows.append({"path": source["path"], "blobSha": source["blobSha"],
                              "content": source["content"], "jobs": routes})
        manifest = {"schema": SCHEMA, "repository": target["repository"], "repositoryId": target["repositoryId"],
                    "visibility": target["visibility"], "defaultBranch": target["defaultBranch"],
                    "originalSourceSha": target["sourceSha"], "guardSha": GUARD_SHA,
                    "recipeDigest": RECIPES_DIGEST, "closureDigest": CLOSURE_DIGEST,
                    "scopeNames": sorted(item["repository"].split("/")[1] for item in recipes["targets"]),
                    "workflows": workflows,
                    "runtimeSources": [binding for binding in closure["ownedBindings"]
                                       if binding["repository"] == target["repository"]],
                    "workflowRunEdges": [edge for edge in closure["workflowRunEdges"]
                                         if edge["repository"] == target["repository"]]}
        data = (json.dumps(manifest, indent=2) + "\n").encode()
        filename = f"{target['repositoryId']}.json"
        (directory / filename).write_bytes(data)
        counts = {}
        for workflow in workflows:
            document, _ = parse(workflow["content"])
            reason = blocker(target["repository"], workflow["path"], document, workflow["jobs"]) or "candidate"
            counts[reason] = counts.get(reason, 0) + sum(
                route["classification"] == "publication" for route in workflow["jobs"].values())
        receipts.append({"manifest": filename, "sha256": digest(data), "routes": counts})
    require(len(receipts) == 46, "applicable-scope-mismatch")
    (directory / "inventory.json").write_text(json.dumps({"targets": receipts}, indent=2) + "\n", encoding="utf8")
    return {"applicableTargets": len(receipts), "publicationRoutes": 277, "workflowRunEdges": 14}


def command(arguments, cwd=None):
    result = subprocess.run(arguments, cwd=cwd, capture_output=True, check=False, text=True, encoding="utf8")
    require(result.returncode == 0, "metadata-or-worktree-command-failed")
    return result.stdout.strip()


def github(endpoint):
    return json.loads(command(["gh", "api", endpoint]), object_pairs_hook=no_duplicates)


def fresh_target(manifest, catalog_sha, expected_head, root):
    name = scoped(manifest["repository"])
    require(HEX40.fullmatch(catalog_sha) and HEX40.fullmatch(expected_head), "immutable-revision-required")
    require(github("repos/frasermolyneux/platform-workloads/commits/main")["sha"] == catalog_sha,
            "catalog-revision-changed")
    tree = github(f"repos/frasermolyneux/platform-workloads/git/trees/{catalog_sha}?recursive=1")
    require(tree.get("truncated") is False, "incomplete-catalog-tree")
    rows = [item for item in tree["tree"] if item["type"] == "blob" and
            item["path"].startswith("terraform/workloads/") and "/examples/" not in item["path"] and
            item["path"].endswith(".json")]
    names = [Path(item["path"]).stem for item in rows]
    xi_names = [item for item in names if item.startswith("xi-")]
    require(len(names) == len(set(names)) == 61 and len(xi_names) == 11 and
            len(manifest["scopeNames"]) == 50 and
            sorted(item for item in names if not item.startswith("xi-")) == manifest["scopeNames"],
            "catalog-disposition-scope-changed")
    candidates = [item for item in rows if item["path"].endswith("/" + name + ".json")]
    require(len(candidates) == 1, "uncatalogued-or-ambiguous-target")
    catalog = github(f"repos/frasermolyneux/platform-workloads/contents/{candidates[0]['path']}?ref={catalog_sha}")
    require(catalog.get("sha") == candidates[0]["sha"], "catalog-source-mismatch")
    row = json.loads(base64.b64decode(catalog["content"]), object_pairs_hook=no_duplicates)
    require(row["name"] == name and row["github"]["visibility"] == manifest["visibility"],
            "catalog-name-or-visibility-mismatch")
    metadata = github(f"repos/{manifest['repository']}")
    require(metadata["id"] == manifest["repositoryId"] and metadata["full_name"] == manifest["repository"] and
            metadata["visibility"] == manifest["visibility"] and
            metadata["private"] == (manifest["visibility"] == "private") and
            metadata["default_branch"] == manifest["defaultBranch"] and
            metadata["archived"] is False and metadata["fork"] is False, "target-identity-changed")
    require(github(f"repos/{manifest['repository']}/commits/{manifest['defaultBranch']}")["sha"] == expected_head,
            "target-default-head-changed")
    require(command(["git", "rev-parse", "HEAD"], root) == expected_head, "worktree-head-mismatch")
    origin = command(["git", "remote", "get-url", "origin"], root)
    require(origin in {f"https://github.com/{manifest['repository']}.git",
                       f"https://github.com/{manifest['repository']}",
                       f"git@github.com:{manifest['repository']}.git"}, "worktree-origin-mismatch")
    app = row["github"].get("github_app", {})
    require(app.get("enabled") is True and re.fullmatch(r"[1-9][0-9]*", str(app.get("app_id", ""))),
            "missing-catalog-app-identity")
    return str(app["app_id"])


def verify_release():
    tag = github("repos/frasermolyneux/actions/git/ref/tags/" + GUARD_TAG)
    require(tag["object"]["type"] == "commit" and tag["object"]["sha"] == GUARD_SHA, "guard-release-moved")


def uses_in(document):
    jobs = document.get("jobs", {})
    require(isinstance(jobs, dict), "ambiguous-jobs")
    steps = document.get("runs", {}).get("steps", [])
    for job in jobs.values():
        require(isinstance(job, dict), "ambiguous-job")
        if "uses" in job:
            yield job["uses"]
        steps = steps + job.get("steps", [])
    for step in steps:
        require(isinstance(step, dict), "ambiguous-step")
        if "uses" in step:
            yield step["uses"]


def verify_sources(manifest, root):
    identities, primitives = {}, {}
    for workflow in manifest["workflows"]:
        for route in workflow["jobs"].values():
            for effect in route["effects"]:
                require(effect.get("kind") in {"inline", "primitive", "executor"} and
                        isinstance(effect.get("chain"), list), "unclassified-executor")
                if effect["kind"] == "primitive":
                    use = effect["uses"]
                    require(HEX40.fullmatch(effect.get("sourceSha", "")), "unbound-primitive-source")
                    primitives.setdefault(use, set()).add(effect["sourceSha"])
                for entry in effect["chain"][1:]:
                    if "repository" in entry and "path" in entry:
                        identity = (entry["repository"], entry["path"], entry["sourceSha"])
                        require(HEX40.fullmatch(entry["sourceSha"]) and HEX40.fullmatch(entry["blobSha"]),
                                "unbound-inherited-source")
                        require(identity not in identities or identities[identity] == entry["blobSha"],
                                "ambiguous-inherited-source")
                        identities[identity] = entry["blobSha"]
    resolved = {}

    def resolve(use):
        require(isinstance(use, str), "unclassified-invocation")
        if use.startswith("./"):
            relative = use[2:].rstrip("/")
            possible = [(repository, path, sha) for repository, path, sha in identities
                        if repository == manifest["repository"] and
                        path in {relative, relative + "/action.yml", relative + "/action.yaml"}]
            require(len(possible) == 1, "unbound-local-invocation")
            return
        match = re.fullmatch(r"([A-Za-z0-9_-]+/[A-Za-z0-9_.-]+)(/[A-Za-z0-9_./-]+)?@([A-Za-z0-9_./-]+)", use)
        require(match is not None and all(segment not in {"", ".", ".."} for segment in
                (match[2] or "/action.yml").lstrip("/").split("/")), "unclassified-invocation")
        repository, path, ref = match[1], (match[2] or "").lstrip("/"), match[3]
        if use not in resolved:
            resolved[use] = ref if HEX40.fullmatch(ref) else github(
                f"repos/{repository}/commits/{quote(ref, safe='')}")["sha"]
        source_sha = resolved[use]
        if use in primitives:
            require(primitives[use] == {source_sha}, "primitive-reference-changed")
            return
        possible = [(owner, source_path, sha) for owner, source_path, sha in identities if owner == repository and
                    source_path in {path, path + "/action.yml", path + "/action.yaml"} and sha == source_sha]
        require(len(possible) == 1, "inherited-reference-changed-or-unbound")

    for identity, expected_blob in identities.items():
        repository, path, sha = identity
        require(re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", repository) and
                re.fullmatch(r"[A-Za-z0-9_./-]+", path) and
                all(segment not in {"", ".", ".."} for segment in path.split("/")), "unsafe-source-path")
        if repository == manifest["repository"]:
            filename = root.joinpath(*path.split("/"))
            require(filename.is_file() and not filename.is_symlink() and
                    filename.resolve().is_relative_to(root), "missing-local-inherited-source")
            data = filename.read_bytes()
        else:
            result = github(f"repos/{repository}/contents/{path}?ref={sha}")
            require(result.get("sha") == expected_blob, "inherited-definition-mismatch")
            data = base64.b64decode(result["content"])
        require(blob(data) == expected_blob, "inherited-definition-changed")
        if path.endswith((".yml", ".yaml")):
            document, _ = parse(data.decode("utf8"))
            for use in uses_in(document):
                resolve(use)
    for workflow in manifest["workflows"]:
        document, _ = parse(workflow["content"])
        for use in uses_in(document):
            resolve(use)
    require(isinstance(manifest.get("runtimeSources"), list), "missing-runtime-source-declarations")
    for binding in manifest["runtimeSources"]:
        require(binding["repository"] == manifest["repository"], "foreign-runtime-source")
        path = binding["path"]
        require(isinstance(path, str) and re.fullmatch(r"[A-Za-z0-9_./-]+", path) and
                all(segment not in {"", ".", ".."} for segment in path.split("/")),
                "unsafe-runtime-source-path")
        filename = root.joinpath(*path.split("/"))
        require(filename.is_file() and not filename.is_symlink() and filename.resolve().is_relative_to(root) and
                blob(filename.read_bytes()) == binding["blobSha"], "owned-runtime-source-changed")


def new_output(output):
    path = Path(output)
    require(not path.exists(), "output-already-exists")
    path.mkdir(parents=True)
    return path


def unified_patch(before, after, path):
    result = []
    for line in difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                     fromfile="a/" + path, tofile="b/" + path):
        result.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
    return result


def plan(manifest_path, manifest_digest, worktree, output, catalog_sha, expected_head):
    require(HEX64.fullmatch(manifest_digest), "approved-manifest-digest-required")
    manifest = read_json(manifest_path, manifest_digest)
    require(manifest["schema"] == SCHEMA and manifest["guardSha"] == GUARD_SHA and
            manifest["recipeDigest"] == RECIPES_DIGEST and manifest["closureDigest"] == CLOSURE_DIGEST,
            "unsupported-manifest-authority")
    require(type(manifest["repositoryId"]) is int and 0 < manifest["repositoryId"] < 2**53 and
            manifest["visibility"] in {"public", "private"}, "invalid-target-identity")
    scoped(manifest["repository"])
    root = Path(worktree).resolve(strict=True)
    destination = Path(output).resolve()
    require(root != destination and root not in destination.parents, "output-inside-target-worktree")
    declarations = manifest["workflows"]
    paths = [item["path"] for item in declarations]
    require(len(set(paths)) == len(paths) and all(WORKFLOW.fullmatch(item) for item in paths),
            "ambiguous-workflow-declarations")
    live_paths = {path.relative_to(root).as_posix() for path in (root / ".github" / "workflows").iterdir()
                  if path.suffix in {".yml", ".yaml"}}
    require(live_paths == set(paths), "new-or-missing-workflow")
    verify_release()
    app_id = fresh_target(manifest, catalog_sha, expected_head, root)
    verify_sources(manifest, root)
    patch, failures, transformed, unchanged = [], [], 0, 0
    snapshots = {}
    for declaration in sorted(declarations, key=lambda item: item["path"]):
        path = root.joinpath(*declaration["path"].split("/"))
        require(path.is_file() and not path.is_symlink() and
                path.resolve().is_relative_to(root), "unsafe-workflow-file")
        require(blob(declaration["content"].encode()) == declaration["blobSha"], "declared-source-blob-mismatch")
        text = path.read_bytes().decode("utf8")
        snapshots[declaration["path"]] = text
        try:
            generated = transform(text, declaration, manifest["repository"], app_id)
        except Refusal as error:
            failures.append({"workflow": declaration["path"], "category": str(error),
                             "publicationRoutes": sum(route["classification"] == "publication"
                                                      for route in declaration["jobs"].values())})
            continue
        if generated == text:
            unchanged += 1
        else:
            transformed += sum(route["classification"] == "publication" for route in declaration["jobs"].values())
            patch.extend(unified_patch(text, generated, declaration["path"]))
    fresh_target(manifest, catalog_sha, expected_head, root)
    verify_release()
    verify_sources(manifest, root)
    for path, text in snapshots.items():
        require(root.joinpath(*path.split("/")).read_bytes().decode("utf8") == text, "worktree-source-changed")
    receipt = {"schema": SCHEMA, "manifestDigest": manifest_digest, "catalogSha": catalog_sha,
               "expectedHead": expected_head, "guardSha": GUARD_SHA, "guardTag": GUARD_TAG,
               "candidatePublicationRoutes": transformed, "unchangedWorkflows": unchanged,
               "blockedWorkflows": failures, "complete": not failures, "runtimeAcceptance": False,
               "patchSha256": digest("".join(patch).encode())}
    directory = new_output(output)
    (directory / "publication-guard.patch").write_bytes("".join(patch).encode())
    (directory / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf8")
    return {"complete": not failures, "candidatePublicationRoutes": transformed, "blockedWorkflows": len(failures),
            "runtimeAcceptance": False}


def fetch_helper(output):
    verify_release()
    files = {}
    for filename, expected in GUARD_FILES.items():
        result = github(f"repos/frasermolyneux/actions/contents/repository-publication-origin/{filename}?ref={GUARD_SHA}")
        data = base64.b64decode(result["content"], validate=False)
        require(digest(data) == expected and blob(data) == result["sha"], "guard-definition-digest-mismatch")
        files[filename] = data
    directory = new_output(output)
    for filename, data in files.items():
        (directory / filename).write_bytes(data)
    return {"guardSha": GUARD_SHA, "verifiedFiles": len(files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="mode", required=True)
    capture = subparsers.add_parser("inventory", help="Compile the frozen reviewed authority into local manifests")
    capture.add_argument("--recipes", required=True)
    capture.add_argument("--closure", required=True)
    capture.add_argument("--out", required=True)
    staging = subparsers.add_parser("plan", help="Recheck live authority and emit a local patch; never apply it")
    for argument in ["manifest", "manifest-sha256", "worktree", "out", "catalog-sha", "expected-head"]:
        staging.add_argument("--" + argument, required=True)
    fetch = subparsers.add_parser("fetch-helper", help="Fetch only the immutable reviewed metadata helper for contract tests")
    fetch.add_argument("--out", required=True)
    arguments = vars(parser.parse_args())
    mode = arguments.pop("mode")
    try:
        if mode == "inventory":
            result = inventory(arguments["recipes"], arguments["closure"], arguments["out"])
        elif mode == "fetch-helper":
            result = fetch_helper(arguments["out"])
        else:
            result = plan(arguments["manifest"], arguments["manifest_sha256"], arguments["worktree"],
                          arguments["out"], arguments["catalog_sha"], arguments["expected_head"])
        print(json.dumps(result, sort_keys=True))
        return 2 if result.get("complete") is False else 0
    except Refusal as error:
        print(f"Publication installation incomplete: {error}.", file=sys.stderr)
        return 2
    except (KeyError, TypeError, OSError, UnicodeError, json.JSONDecodeError, yaml.YAMLError):
        print("Publication installation incomplete: input, metadata or declaration validation failed.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
