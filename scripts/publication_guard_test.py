import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
import uuid

import publication_guard as installer


SOURCE = """# Original workflow comment
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
  schedule:
    - cron: '0 1 * * 5'
permissions: {}
env:
  MODE: retained
defaults:
  run:
    shell: pwsh
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo validation
  publish:
    # Original environment approval and ordering
    if: |
      !failure() && !cancelled() &&
      needs.build.result == 'success'
    needs:
      - build
    environment: Production
    permissions:
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - run: echo publication
  report:
    if: always()
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - run: echo readonly
"""


def declaration(content=SOURCE, publishing=("publish",), path=".github/workflows/deploy.yml"):
    document, _ = installer.parse(content)
    routes = {}
    for name, definition in document["jobs"].items():
        effects = [{"kind": "inline", "chain": [], "roles": ["synthetic-reviewed-effect"],
                    "contentSha256": "a" * 64}]
        routes[name] = {"classification": "publication" if name in publishing else "readonly",
                        "definition": definition, "effects": effects,
                        "effectDigest": installer.digest(installer.canonical(effects).encode())}
    return {"path": path, "blobSha": installer.blob(content.encode()), "content": content, "jobs": routes}


def transform(source=SOURCE, declared=None, repository="frasermolyneux/synthetic"):
    return installer.transform(source, declared or declaration(), repository, "2973523")


class TransformationTests(unittest.TestCase):
    def test_preserves_entire_document_except_explicit_gated_fields(self):
        generated = transform()
        before, _ = installer.parse(SOURCE)
        after, _ = installer.parse(generated)
        publish = after["jobs"]["publish"]
        self.assertEqual(publish["needs"], ["build", installer.JOB])
        self.assertIn(installer.expression(before["jobs"]["publish"]["if"]), publish["if"])
        self.assertIn("needs.publication-origin.result == 'success'", publish["if"])
        publish["if"] = before["jobs"]["publish"]["if"]
        publish["needs"] = before["jobs"]["publish"]["needs"]
        del after["jobs"][installer.JOB]
        self.assertEqual(before, after)
        self.assertIn("# Original workflow comment", generated)
        self.assertIn("# Original environment approval and ordering", generated)
        self.assertEqual(transform(generated), generated)

    def test_original_scalar_if_and_needs_and_inline_comments(self):
        source = SOURCE.replace("if: |\n      !failure() && !cancelled() &&\n      needs.build.result == 'success'",
                                "if: ${{ always() && needs.build.result == 'success' }} # keep this")
        source = source.replace("needs:\n      - build", "needs: build # preserve need comment")
        generated = transform(source, declaration(source))
        self.assertIn("# keep this", generated)
        self.assertIn("# preserve need comment", generated)
        self.assertIn("(always() && needs.build.result == 'success')", generated)

    def test_missing_if_and_needs_retain_success_semantics(self):
        source = "on:\n  workflow_dispatch:\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo synthetic\n"
        after, _ = installer.parse(transform(source, declaration(source)))
        self.assertEqual(after["jobs"]["publish"]["needs"], [installer.JOB])
        self.assertIn("(success())", after["jobs"]["publish"]["if"])

    def test_effectful_inherited_workflow_is_gated_without_changing_call(self):
        source = "on:\n  push:\njobs:\n  publish:\n    uses: owner/shared/.github/workflows/release.yml@" + "a" * 40 + "\n    secrets: inherit\n"
        after, _ = installer.parse(transform(source, declaration(source)))
        self.assertEqual(after["jobs"]["publish"]["uses"], installer.parse(source)[0]["jobs"]["publish"]["uses"])
        self.assertEqual(after["jobs"]["publish"]["secrets"], "inherit")
        self.assertEqual(after["jobs"]["publish"]["needs"], [installer.JOB])

    def test_crlf_and_no_final_newline(self):
        source = SOURCE.replace("\n", "\r\n").rstrip("\r\n")
        generated = transform(source, declaration(source))
        self.assertNotIn("\n", generated.replace("\r\n", ""))
        self.assertFalse(generated.endswith("\n"))
        self.assertEqual(transform(generated, declaration(source)), generated)

    def test_changed_gates_source_and_unrelated_fields_refused(self):
        for source in [SOURCE.replace("Production", "Development"), SOURCE.replace("always()", "success()"),
                       SOURCE.replace("branches: [main]", "branches: [release]"),
                       SOURCE.replace("echo publication", "echo changed")]:
            with self.subTest(source=source):
                with self.assertRaisesRegex(installer.Refusal, "changed-unreviewed"):
                    transform(source)
        generated = transform()
        with self.assertRaisesRegex(installer.Refusal, "changed-unreviewed"):
            transform(generated.replace("allow-app-authored-merges: 'false'", "allow-app-authored-merges: 'true'"))

    def test_missing_ambiguous_effect_and_job_declarations_refused(self):
        edits = [
            lambda d: d["jobs"].pop("report"),
            lambda d: d["jobs"]["publish"].update(classification="unknown"),
            lambda d: d["jobs"]["publish"].update(effectDigest="b" * 64),
            lambda d: d["jobs"]["publish"].update(definition={}),
            lambda d: d["jobs"]["publish"].update(effects=[]),
        ]
        for edit in edits:
            d = declaration()
            edit(d)
            with self.assertRaises(installer.Refusal):
                transform(declared=d)

    def test_missing_dynamic_duplicate_and_cyclic_dependencies_refused(self):
        for replacement in ["missing", "${{ inputs.job }}", "[build, build]", "publish"]:
            source = SOURCE.replace("needs:\n      - build", "needs: " + replacement)
            with self.subTest(replacement=replacement):
                with self.assertRaises(installer.Refusal):
                    transform(source, declaration(source))

    def test_unclassified_yaml_aliases_duplicates_and_flow_maps_refused(self):
        for source in ["on: {}\njobs: {publish: {runs-on: ubuntu-latest, steps: []}}",
                       SOURCE + "\npermissions: {}\n",
                       SOURCE.replace("runs-on: ubuntu-latest", "runs-on: &runner ubuntu-latest", 1),
                       SOURCE.replace("MODE: retained", "MODE: !unsafe retained")]:
            with self.assertRaises(installer.Refusal):
                transform(source, declaration(source))
        with self.assertRaisesRegex(installer.Refusal, "duplicate-json"):
            json.loads('{"jobs":{}, "jobs":{}}', object_pairs_hook=installer.no_duplicates)

    def test_workflow_run_direct_and_relay_are_blocked_not_assumed_root(self):
        for workflow_name in ["Quality", "Publish Demo Images"]:
            source = SOURCE.replace("  push:\n    branches: [main]",
                                    f"  workflow_run:\n    workflows: ['{workflow_name}']\n    types: [completed]")
            with self.assertRaisesRegex(installer.Refusal, "direct-producer-definition"):
                transform(source, declaration(source))

    def test_dependency_dispatch_exception_is_refused_not_bot_allowlisted(self):
        d = declaration(path=".github/workflows/deploy-prd.yml")
        with self.assertRaisesRegex(installer.Refusal, "approved-dependency-dispatch-lineage"):
            transform(declared=d, repository="frasermolyneux/molyneux-me")
        source = SOURCE.replace("  push:\n    branches: [main]", "  pull_request:")
        with self.assertRaisesRegex(installer.Refusal, "unsupported-existing-publication-event"):
            transform(source, declaration(source))

    def test_generated_guard_is_metadata_only_and_denial_fails_explicitly(self):
        generated = installer.guard_job("2973523")
        self.assertIn(installer.GUARD, generated)
        self.assertIn('PUBLICATION_ALLOWED" != "true"', generated)
        self.assertIn("exit 1", generated)
        self.assertNotIn("github.actor", generated)
        self.assertNotIn("github.triggering_actor", generated)
        self.assertNotIn("checkout", generated)
        self.assertNotIn("COPILOT", generated)
        self.assertNotIn("upload", generated)
        permissions = installer.parse("jobs:\n" + generated)[0]["jobs"][installer.JOB]["permissions"]
        self.assertEqual(permissions, {"contents": "read", "actions": "read", "pull-requests": "read"})

    def test_existing_nonidentical_guard_collision_refused(self):
        source = SOURCE.replace("  report:", "  publication-origin:")
        with self.assertRaisesRegex(installer.Refusal, "reserved-job-collision"):
            transform(source, declaration(source))

    def test_excluded_scope(self):
        for repository in ["frasermolyneux/xi-canary", "frasermolyneux/baremetal-workload-canary",
                           "frasermolyneux/41-bovet-street", "frasermolyneux/CoD4x_Server",
                           "frasermolyneux/portal-bots", "frasermolyneux/status-pages", "other/target"]:
            with self.assertRaises(installer.Refusal):
                installer.scoped(repository)


class PlanningTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(".publication-guard-test-" + uuid.uuid4().hex).resolve()
        self.root = self.directory / "target"
        (self.root / ".github" / "workflows").mkdir(parents=True)
        (self.root / ".github" / "workflows" / "deploy.yml").write_bytes(SOURCE.encode())
        self.manifest = {"schema": installer.SCHEMA, "repository": "frasermolyneux/synthetic",
                         "repositoryId": 1, "visibility": "private", "defaultBranch": "main",
                         "guardSha": installer.GUARD_SHA, "recipeDigest": installer.RECIPES_DIGEST,
                         "closureDigest": installer.CLOSURE_DIGEST, "workflows": [declaration()],
                         "scopeNames": sorted(list(installer.EXEMPT) + ["synthetic"] +
                                              [f"fixture-{index}" for index in range(45)]),
                         "runtimeSources": []}
        self.manifest_path = self.directory / "manifest.json"
        self.write_manifest()
        self.fresh = patch.object(installer, "fresh_target", return_value="2973523").start()
        self.release = patch.object(installer, "verify_release").start()

    def tearDown(self):
        patch.stopall()
        shutil.rmtree(self.directory)

    def write_manifest(self):
        data = json.dumps(self.manifest).encode()
        self.manifest_path.write_bytes(data)
        self.manifest_digest = hashlib.sha256(data).hexdigest()

    def plan(self):
        return installer.plan(self.manifest_path, self.manifest_digest, self.root, self.directory / "out",
                              "a" * 40, "b" * 40)

    def test_plan_stages_patch_never_writes_target_and_private_summary_has_no_source(self):
        summary = self.plan()
        self.assertEqual((self.root / ".github" / "workflows" / "deploy.yml").read_bytes(), SOURCE.encode())
        self.assertEqual(summary["candidatePublicationRoutes"], 1)
        self.assertTrue(summary["complete"])
        self.assertEqual(self.fresh.call_count, 2)
        self.assertEqual(self.release.call_count, 2)
        for private_detail in ["frasermolyneux", "echo publication", "Production", "MODE"]:
            self.assertNotIn(private_detail, json.dumps(summary))
        receipt = json.loads((self.directory / "out" / "receipt.json").read_text())
        patch_bytes = (self.directory / "out" / "publication-guard.patch").read_bytes()
        self.assertEqual(receipt["patchSha256"], installer.digest(patch_bytes))
        self.assertFalse(receipt["runtimeAcceptance"])

    def test_actual_git_patch_applies_and_second_plan_is_idempotent(self):
        self.plan()
        patch_file = self.directory / "out" / "publication-guard.patch"
        installer.command(["git", "apply", "--check", str(patch_file)], self.root)
        installer.command(["git", "apply", str(patch_file)], self.root)
        shutil.rmtree(self.directory / "out")
        summary = self.plan()
        self.assertEqual(summary["candidatePublicationRoutes"], 0)
        self.assertEqual((self.directory / "out" / "publication-guard.patch").read_bytes(), b"")

    def test_actual_git_patch_preserves_crlf_and_missing_final_newline(self):
        source = SOURCE.replace("\n", "\r\n").rstrip("\r\n")
        self.manifest["workflows"] = [declaration(source)]
        self.write_manifest()
        filename = self.root / ".github" / "workflows" / "deploy.yml"
        filename.write_bytes(source.encode())
        self.plan()
        patch_file = self.directory / "out" / "publication-guard.patch"
        installer.command(["git", "apply", "--check", str(patch_file)], self.root)
        installer.command(["git", "apply", str(patch_file)], self.root)
        self.assertEqual(filename.read_bytes().decode(), transform(source, declaration(source)))

    def test_new_workflow_and_wrong_authority_refused_without_output(self):
        (self.root / ".github" / "workflows" / "unknown.yml").write_text("on: {}\njobs: {}", encoding="utf8")
        with self.assertRaisesRegex(installer.Refusal, "new-or-missing-workflow"):
            self.plan()
        self.assertFalse((self.directory / "out").exists())
        self.manifest_digest = "0" * 64
        with self.assertRaisesRegex(installer.Refusal, "authority-digest"):
            self.plan()

    def test_partial_plan_has_explicit_incomplete_receipt(self):
        source = SOURCE.replace("  push:\n    branches: [main]", "  workflow_run:\n    workflows: [Quality]")
        d = declaration(source, path=".github/workflows/relay.yml")
        self.manifest["workflows"].append(d)
        (self.root / ".github" / "workflows" / "relay.yml").write_bytes(source.encode())
        self.write_manifest()
        self.assertFalse(self.plan()["complete"])
        receipt = json.loads((self.directory / "out" / "receipt.json").read_text())
        self.assertEqual(receipt["blockedWorkflows"][0]["category"],
                         "guard-missing-direct-producer-definition-binding")

    def test_source_edit_during_metadata_recheck_refused(self):
        def recheck(*_):
            if self.fresh.call_count == 2:
                (self.root / ".github" / "workflows" / "deploy.yml").write_text("changed", encoding="utf8")
            return "2973523"
        self.fresh.side_effect = recheck
        with self.assertRaisesRegex(installer.Refusal, "worktree-source-changed"):
            self.plan()
        self.assertFalse((self.directory / "out").exists())

    def test_inherited_floating_and_owned_runtime_sources_must_still_match(self):
        use = "owner/shared@v1"
        effects = [{"kind": "primitive", "uses": use, "sourceSha": "a" * 40, "chain": []}]
        self.manifest["workflows"][0]["jobs"]["publish"]["effects"] = effects
        with patch.object(installer, "github", return_value={"sha": "b" * 40}):
            with self.assertRaisesRegex(installer.Refusal, "primitive-reference-changed"):
                # Verify a declaration of the actual invocation, not a name heuristic.
                self.manifest["workflows"][0]["content"] = SOURCE.replace(
                    "- run: echo publication", "- uses: " + use)
                installer.verify_sources(self.manifest, self.root)
        self.manifest["runtimeSources"] = [{"repository": self.manifest["repository"],
                                            "path": "script.ps1", "blobSha": "a" * 40}]
        self.manifest["workflows"][0]["content"] = SOURCE
        with self.assertRaisesRegex(installer.Refusal, "owned-runtime-source-changed"):
            installer.verify_sources(self.manifest, self.root)

    def test_inherited_definition_and_nested_primitive_positive_binding(self):
        import base64
        use = "owner/shared/.github/workflows/release.yml@v1"
        primitive = "actions/synthetic@" + "b" * 40
        shared = f"on:\n  workflow_call:\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: {primitive}\n"
        source = f"on:\n  push:\njobs:\n  publish:\n    uses: {use}\n"
        effects = [{"kind": "primitive", "uses": primitive, "sourceSha": "b" * 40,
                    "chain": [{}, {"repository": "owner/shared", "path": ".github/workflows/release.yml",
                                  "sourceSha": "a" * 40, "blobSha": installer.blob(shared.encode())}]}]
        self.manifest["workflows"] = [declaration(source)]
        self.manifest["workflows"][0]["jobs"]["publish"]["effects"] = effects
        responses = [{"sha": installer.blob(shared.encode()),
                      "content": base64.b64encode(shared.encode()).decode()}, {"sha": "a" * 40}]
        with patch.object(installer, "github", side_effect=responses):
            installer.verify_sources(self.manifest, self.root)
        responses[1] = {"sha": "c" * 40}
        with patch.object(installer, "github", side_effect=responses):
            with self.assertRaisesRegex(installer.Refusal, "inherited-reference-changed-or-unbound"):
                installer.verify_sources(self.manifest, self.root)

    def test_catalog_and_live_immutable_repository_identity(self):
        row = {"name": "synthetic", "github": {"visibility": "private",
                                              "github_app": {"enabled": True, "app_id": "2973523"}}}
        import base64
        metadata = {"id": 1, "full_name": "frasermolyneux/synthetic", "visibility": "private",
                    "private": True, "default_branch": "main", "archived": False, "fork": False}
        tree = [{"type": "blob", "path": f"terraform/workloads/platform/{name}.json", "sha": "c" * 40}
                for name in self.manifest["scopeNames"] + [f"xi-{index}" for index in range(11)]]
        responses = [{"sha": "a" * 40}, {"truncated": False, "tree": tree},
                     {"sha": "c" * 40, "content": base64.b64encode(json.dumps(row).encode()).decode()},
                     metadata, {"sha": "b" * 40}]
        patch.stopall()
        with patch.object(installer, "github", side_effect=responses), patch.object(
                installer, "command", side_effect=["b" * 40, "https://github.com/frasermolyneux/synthetic.git"]):
            self.assertEqual(installer.fresh_target(self.manifest, "a" * 40, "b" * 40, self.root), "2973523")
        for change in [{"id": 2}, {"visibility": "public"}, {"full_name": "other/synthetic"},
                       {"archived": True}, {"fork": True}]:
            changed = copy.deepcopy(responses)
            changed[3].update(change)
            with patch.object(installer, "github", side_effect=changed):
                with self.assertRaisesRegex(installer.Refusal, "target-identity-changed"):
                    installer.fresh_target(self.manifest, "a" * 40, "b" * 40, self.root)
        changed = copy.deepcopy(responses)
        changed[1]["tree"].append({"type": "blob", "path": "terraform/workloads/new/new.json", "sha": "d" * 40})
        with patch.object(installer, "github", side_effect=changed):
            with self.assertRaisesRegex(installer.Refusal, "catalog-disposition-scope-changed"):
                installer.fresh_target(self.manifest, "a" * 40, "b" * 40, self.root)


if __name__ == "__main__":
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    unittest.main()
