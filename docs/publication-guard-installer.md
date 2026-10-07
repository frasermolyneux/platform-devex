# Publication guard migration installer

This is an **output-only migration tool**, not a publisher, merge controller or rollout
completion claim. It never applies its patch, writes target worktrees, changes settings,
retrieves credential values or creates tokens. Execute only from a trusted local migration
workspace using existing authorized `gh` authentication. No Terraform is added here.

## Reviewed authority and scope

`scripts/publication_guard.py inventory` compiles the frozen, fully reviewed original recipe
and semantic job closure into one explicitly bound manifest per applicable repository.
Both input SHA-256 digests are pinned in the installer. It does not classify source by
matching command text, branch names, labels, actor names or an absence of matches.
Manifests retain each complete workflow, exact git blob, original job definitions,
resolved effect declarations, inherited source identities and owned runtime source bindings.

The authority contains 50 catalog dispositions: 46 applicable and four exempt. It excludes
all `xi-*`, uncatalogued repositories, the archived canonical `portal-bots`, upstream
`CoD4x_Server`, documentation/data-only `41-bovet-street` and empty `status-pages`.
Before staging, the installer re-reads the complete current catalog tree (61 non-example
rows, including 11 excluded `xi-*`), its current main SHA, the target catalog row, immutable
repository ID/name, personal ownership, visibility, default branch and current head.
It refuses missing/ambiguous names, changed dispositions, forks, archives and a wrong
worktree/origin. It makes no ownership or visibility changes.

## Installation interface

Python 3.12+, Node 22, Git and authenticated `gh` are required. Install the sole Python
dependency with `python -m pip install -r .\scripts\publication-guard-requirements.txt`.
Use paths to the authorized frozen session artifacts; never commit or publish them.

```powershell
python .\scripts\publication_guard.py inventory `
  --recipes <frozen-analysis-canonical-recipe-sources.json> `
  --closure <frozen-analysis-semantic-job-closure.json> `
  --out .\publication-inventory

python .\scripts\publication_guard.py plan `
  --manifest .\publication-inventory\<repositoryId>.json `
  --manifest-sha256 <approved-digest-from-inventory.json> `
  --worktree <separate-current-target-worktree> `
  --catalog-sha <actual-reviewed-current-platform-workloads-main-SHA> `
  --expected-head <actual-current-target-default-branch-SHA> `
  --out .\publication-stage\<repositoryId>
```

Outputs must be new directories, outside the target worktree. `inventory.json` records
manifest digests and per-category counts; approve the exact manifest digest through the
normal migration review. Do not hand-edit classifications, source bindings or gates to
force a pass. Changed current workflows, new workflows, changed owned runtime files or
changed floating inherited/primitive references need renewed semantic review and a bounded
installer/authority update, not a fallback to the old before-state.

`plan` rechecks live head/catalog/identity and source files before recording a receipt.
It emits `publication-guard.patch` and `receipt.json`; stdout contains only safe counts,
not private source or repository names. Exit 0 means a complete **candidate patch**;
exit 2 means incomplete/refused, including partial plans with useful root patches.
Receipts include manifest/head/catalog/guard/patch digests, explicit per-workflow blockers,
and `runtimeAcceptance: false`. Private patches/manifests contain private source: keep
them locally and in the owning repository's governed PR only, never public artifacts.

After reviewing the receipt, recheck head/catalog/source again in the installation
workstream and run `git apply --check <patch>` before applying in that separate worktree.
The tool itself has no apply mode. Apply only the listed workflow patch, preserving
unrelated work such as portal-environments RBAC changes. Re-running against the exact
generated guard is idempotent; modified/pre-existing non-identical guards are refused.
Remove generated inventories, stages and fetched helper copies after retaining appropriate
owning-repository acceptance evidence. They are installation artifacts, not repository code.

## Generated contract and mandatory blockers

Every supported effectful job, including a job-level inherited workflow call, receives
one additional metadata-only origin dependency. Its `if` is the original expression
conjoined with a successful guard and explicit `publication-allowed == 'true'`; its original
`needs` remain in order. Existing event filters, workflow/job defaults, environment approvals,
permissions, change detection, Terraform gates, sequencing, steps and readonly jobs are
otherwise unchanged and semantically compared after surgical YAML edits. Untouched text
and comments are retained; replaced multiline `if`/`needs` values become quoted/flow YAML.
Ambiguous aliases, duplicates, dynamic/missing dependencies and unsupported shapes refuse.

The guard is `frasermolyneux/actions/repository-publication-origin` at immutable
`a5feb7a0c74bd1c6db001344eb494bb5803e7576`, verified against released
`repository-publication-origin/v1.0.0`. The installer adds no competing origin classifier.
The shared helper alone verifies immutable original actor/source metadata and current
write/maintain/admin permission. A genuine original human push is sufficient independently
of PR merger identity. Human manual/scheduled positives remain; bot/App, rerun actor
substitution, unknown origins and dependency pushes cannot authorize publication.
Denied or missing output explicitly fails the metadata guard with a diagnostic, rather
than turning skipped publication into a quiet successful workflow. No cloud/OIDC permission,
source checkout, human PAT, publication token or cross-repository proof upload is added.

Frozen structural fixtures transform **217 of 277 potential publication jobs**. These
numbers are not current-target installation or real publication acceptance:

| Blocked original jobs | Mandatory shared capability / review |
| --- | --- |
| 14 across all 14 `workflow_run` edges | The released helper verifies exact producer definitions for intermediate chained runs, but not a direct root producer. Exact source/workflow definition binding must cover **every** edge, with reviewed ancestor proof and target-only relay artifacts. No relay is installed or guessed here. |
| 42 existing PR-triggered publication jobs | The helper rejects PR events, including existing human-authorized development deployment. Preserve those positives through a reviewed bounded shared origin feature before guarding these workflows; silently removing configured PR publication is not a migration. |
| 4 in molyneux-me `deploy-prd.yml` | The helper has no verified original Dependabot-controller-to-dispatch lineage capability. Require the exact approved controller definition/run/attempt, eligible same-repository PR, immutable author/merge identities, merged SHA and linked target workflow. The controller, Terraform-plan waits and original dispatches remain untouched. |

Current drift or missing source/App authority can block additional candidates. No blocked
repository may change dependency merge identity. All applicable local and hosted checks,
full exact-head Copilot review, meaningful conversation resolution, governed merge and
genuine target event/origin/environment/publication acceptance remain separate requirements.

## Tests

The installer introduces maintained Python in platform-devex. The separate catalog/caller
workstream must add Python to this repository's declared profile and applicable native
analysis before claiming full-profile estate acceptance. This PR wires executable Python
regression tests, not that catalog capability change.

`npm test` runs the Python unit/local Git-patch suite through the existing Node test runner.
The new `Publication installer tests` workflow installs pinned PyYAML, runs `npm run check`
and `npm test`, and tests the actual hash-verified shared helper interface:

```powershell
python .\scripts\publication_guard.py fetch-helper --out .\publication-helper-contract
$env:PUBLICATION_ORIGIN_DIRECTORY = '.\publication-helper-contract'
npm run check
npm test
```

Without that environment variable, only the network-dependent immutable-helper contract
test is explicitly skipped. Fixtures prove deterministic transformation, preservation,
fail-closed refusal and local patch application, not genuine target publication.
