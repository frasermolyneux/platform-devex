# Reviewed Terraform CLI updates

`terraform-cli-updates.yml` is a deterministic metadata-only maintenance controller.
Dependabot remains the only Terraform provider/module updater. This controller
does not run target code, HCL, Terraform, providers, package installers or cloud
authentication. It never edits workflows, locks, constraints or merge/publication
machinery, changes merge identities, auto-merges, or deploys.

## Approval before activation

The committed `scripts/terraform-cli-policy.json` records the owner-approved
baseline **1.17.0** (21 October 2026) and `approvedMinor: "1.17"`, with
31 source-bound root compatibility reviews across 29 consumer repositories.
The owner reviewed its Go 1.26.10 build and
CVE-2026-111943 fix; that is not a blanket claim about every advisory/feature.
The explicit estate rollout request and release review authorize this central
baseline/minor policy. They do **not** prove source compatibility for every root
or successful validation/state-backed plans. No root approval is inferred from
the estate request, an existing 1.17.0 pin, or validation reported as still running.
The owner has admitted the weekly scheduler using
`TF_CLI_UPDATES_ENABLED=true`; it takes effect when this workflow is merged onto
the default branch. Root compatibility remains an independent, fail-closed gate.
Official release
discovery is not itself a security/support approval. Review the official
Terraform releases, HashiCorp security bulletins (including fixed-version
mappings), support policy and relevant release notes before choosing one exact
stable baseline/minor through a reviewed policy PR. Never infer that an old observed pin
or the numerically newest release is the right baseline. No dispatch input can
override the approved policy or silently jump minor versions. Within the approved
minor, the newest official stable patch at or above the baseline is selected for
a PR only, subject to each root's reviewed compatibility approval. A future minor
requires a reviewed central policy change. Setting both approval fields to `null`
pauses all proposals without disabling read-only discovery.

Discovery reads only the newest 100 official `hashicorp/terraform` GitHub
release records once per run, without sending its App token to the public release
request. All matrix jobs use that same trusted workflow-output snapshot.
Drafts, prereleases and malformed tags cannot become candidates. The explicit
approved baseline must appear in this bounded stable set; older baselines outside
that window require operator attention, not unbounded searching or fallback.
The result reports the latest *observed* stable release separately from the
approved target and does not claim it is the latest secure/supported version.

Compatibility uses **manual source-bound review**, not a partial HCL parser.
For each discovered root, the artifact reports its immutable default-branch
`baseSha` and a SHA-256 `sourceDigest` over
the sorted `[repository-relative path, Git blob SHA]` pairs of **every repository
`.tf` and `.tf.json` file**, including local modules and overrides. This is
deliberately conservative: any Terraform source change invalidates every root's
approval, even when a particular root does not use that file. Do not reuse a
direct-root-only digest from the earlier design. Read those exact sources at
the reported base commit, assess all `required_version` constraints and
overrides, and add an approval, for example:

```json
{
  "schemaVersion": 1,
  "approvedTarget": "1.17.0",
  "approvedMinor": "1.17",
  "approval": "Record actual owner review of vendor bulletins, release and support policy here",
  "compatibility": {
    "owner/repository/terraform": {
      "sourceDigest": "<64 lowercase hex characters from the dry-run result>",
      "reviewedMinor": "1.17",
      "allowedTargets": [],
      "rationale": "Reviewed <actual base commit>, root/module sources and overrides: <actual effective constraints and conclusion>. Source review only; no state-backed plan claimed."
    }
  }
}
```

This is a schema illustration, **not a root compatibility approval**. Unknown,
incompatible or changed sources block the entire repository's proposal, avoiding
partial multi-root updates. A root already at the approved target needs no new
edit or compatibility claim. Any source-file change invalidates prior approval
for a future update; renew it through the central policy PR. Separate per-root
`reviewedMinor` permits stable patches only when **all** source constraints permit
that complete minor range. Omit it and use exact `allowedTargets` for restrictive
constraints/exceptions; a newer patch outside an exact review blocks instead of
trying older versions. The controller
does not silently select an alternate target or downgrade newer pins.

The actual configuration key is `compatibility`, not `compatibilityReviews`.
Each key is `<owner>/<repository>/<root>`; use `.` for a repository-root pin,
and distinct entries for `terraform`, `terraform-sub`, `edge` and nested roots.
`sourceDigest` must be 64 lowercase hexadecimal characters; `allowedTargets`
is required even when empty (at most ten exact stable versions), and `rationale`
must contain at least 20 characters after trimming surrounding whitespace.
At least one of `reviewedMinor` or nonempty `allowedTargets` is required. For an exact-only
approval omit `reviewedMinor` and set `"allowedTargets": ["1.17.0"]`.

### Evidence required to populate a root

For each root, supply these independently verifiable inputs in a reviewed
central policy PR:

1. The repository/root, immutable `baseSha` and `sourceDigest` from a real run.
   Recompute the digest from the complete tree at that commit, using the same
   sorted path/blob-SHA pairs, if producing evidence independently of the run.
   Future pin-only changes do not invalidate the digest; source changes do.
2. A review of the root and its module dependencies in the complete repository
   source snapshot, including overrides, identifying every effective
   `required_version` constraint (or its verified absence). Terraform also
   enforces child-module CLI constraints. Record the commit, exact constraints,
   override handling and conclusion in `rationale`, with review evidence in the policy PR.
   For example, a verified `>= 1.15.6` or `>= 1.14.3` with no additional
   restrictions admits all stable 1.17 patches. Do not extrapolate that conclusion
   to another root, a child module or an unexamined override. For external modules,
   verify the exact immutable source/version and its CLI constraints; unresolved
   or mutable dependency compatibility cannot justify a whole-minor approval.
3. Choose the complete reviewed minor only if all constraints allow that entire
   stable patch line; otherwise enumerate only exact verified targets. Unknown
   syntax/semantics or incomplete source review remains unapproved.

Static source compatibility is sufficient to authorize a **pin-update proposal**;
it does not require claiming that a state-backed plan has already succeeded.
Validation and actual root plans are separate, current-head acceptance evidence
before human merge. Attach real commands, outcomes and CI/run links when those
checks have completed; never substitute a planned/running check for success.

### Reviewed estate source snapshot

On 25 October 2026 the parent completed the separate source review and supplied
`terraform-cli-static-compatibility-proof.json`, SHA-256
`debc17a031efe2f0926afe10c321e94c05df1c157cb284a849d1da7b76d50d8a`.
It records 29 immutable repository commits, 31 roots and 464 Terraform source
path/mode/blob identities. Each complete GitHub tree at those commits was read
and admitted using this controller's `rootSources`; every supplied Terraform
identity and declared root matched. All sources are regular `100644` files within
the declared roots; the complete trees passed the symlink/submodule refusal.
Digests were recomputed with the controller's canonical `sourceDigest` algorithm.

The parent's full source review found exactly one `required_version` per root:
`>= 1.15.6`, except `platform-status-web/terraform` retains `>= 1.14.3`.
There are no module blocks, override files, Terraform JSON files or additional
narrowing constraints. Those reviewed requirements admit every stable 1.17 patch.
The committed `compatibility` map therefore has 31 `reviewedMinor: "1.17"`
entries; each rationale records its actual source commit, constraint, absence
of modules/overrides/JSON and static-only conclusion. This is source-review
approval, **not production compatibility or state-backed plan approval**.

These entries apply once the consumer default branches contain the reviewed
source identities. Merge commits and pin/lock/tfvars-only changes do not alter
the digest. Any tracked `.tf`/`.tf.json` change still invalidates the affected
repository's reviews; new roots and repositories require their own review.
No approval is granted to `actions` or other new test/sample roots.

### Baseline validation evidence

The parent supplied `terraform-rollout-lock-results.json`, SHA-256
`6747333f04fb2950dfb6e82716f0d6c96f7c418bf7576cf22e9e09889c333852`,
on 25 October 2026. That snapshot records 31 roots across 29 repositories, all
using CLI 1.17.0 with `valid: true` after backend-disabled initialization,
and 31 provider-lock SHA-256 values. It is baseline validation evidence, not an
execution by this controller, source-bound whole-minor approval or a state-backed
plan. The snapshot contains no immutable source commit or compatibility digest.

The parent subsequently confirmed all 31 current root formatting checks pass;
the historical `demo-manager` tfvars formatting difference was fixed separately
without a semantic change. Do not treat the old snapshot's 30/31 formatting flag
as a current failure. Its two warning records remain historical diagnostics,
not state-plan evidence. The parent owns current-head validation and state-backed
plans; none are fabricated by the compatibility approvals above.

## Discovery and permissions

Discovery uses the existing `GH_APP_ID`/`GH_APP_PEM` broker with a Metadata: read
installation token. It enumerates at most 1,000 installation repositories,
excluding archived repositories, forks and different owners; at most 256 active
repositories enter the matrix. Optional manual selection must be an applicable
installed repository, not a hard-coded estate list.

Each matrix job mints a fresh **single-repository** App token: Contents and Pull
requests: read in dry-run mode, write only for an explicitly admitted writer run.
Checks and Commit statuses: read report existing PR failures without changing CI.
GitHub Metadata: read is implicit. The App installation must grant Contents and
Pull requests: write plus those two read permissions on actual targets for writer mode; missing access is reported
as incomplete, never retried using a broad PAT. No Workflows, Actions, cloud or
Copilot credentials are requested. The default token only checks out this
controller; the summary job uses Actions: read and Issues: write on
`platform-devex` for private result collection and the existing activity-log issue.
App permission governance belongs to `platform-workloads`.

The controller reads the current immutable default-branch tree (up to 20,000
entries, never accepting truncation), not a target checkout. Every
`.terraform-version` pin must be a safe regular file with adjacent direct-root
Terraform source. This covers `terraform`, `terraform-sub`, `edge`, repository
root and other explicitly pinned execution roots, not just the usual directory.
Unpinned roots are not bootstrapped: the estate standards rollout owns their
initial pins/locks. Symlinks, unsafe locations, invalid exact pins, more than 32
roots, 512 direct source files per root or 2,048 repository Terraform sources
fail closed. Repository Terraform sources must be regular files, not symlinks.
Any tracked repository symlink or git submodule also blocks a pinned repository:
directory indirections can hide local-module sources outside the reviewed tree.
This conservative refusal also covers indirections unrelated to a particular root;
flatten/vendor the reviewed sources or reconcile manually instead of bypassing it.
Metadata responses are bounded
to 2 MiB, pin blobs to 64 bytes, API calls to 30 seconds and paginated collections
to ten pages. Jobs have explicit timeouts.

## PR lifecycle and races

One fixed branch, `automation/terraform-cli`, and one App-authored marked PR per
repository are allowed. Existing branches/PRs must match the App identity,
same-repository origin and default base. Duplicate, unowned or orphan branches
stop for human reconciliation. The complete base/head trees must agree outside
the current pin paths; the bounded API changed-file list must contain only
modified pin files, no renames. Stale bases with unrelated changes need the
existing branch sweep or human refresh; they are never force-pushed.

Before branch creation, commit creation and PR publication, recheck repository
applicability, default-branch SHA, PR identity and branch head. GraphQL
`createCommitOnBranch` uses `expectedHeadOid` for atomic head compare-and-swap.
Only planned pin additions (existing file replacements) enter the commit.
Repeated runs with the same source/target/head produce no writes. New approved
targets update the same owned PR. Obsolete PRs and incompatible changes require
human reconciliation rather than automatic closing or replacing reviews.
The publication response must still match the reviewed base branch/SHA,
committed head branch/SHA and repository origin. A retarget or base movement
observed during publication is incomplete activity, not a successful update.

GitHub offers no transaction locking both default and update refs: a change
after the last read can still occur. Post-commit rechecks catch observed races
before publication; an interrupted/failed first publication can leave an orphan
branch, which subsequent runs refuse to adopt automatically. Inspect its
commit/diff and remove it manually only after confirming no useful PR/work is
lost, then retry. Never weaken the ownership checks to recover.

PR metadata does not prove validation: result `mergeableState` may be unknown
(the list API need not return it). Read-only Checks/Commit statuses snapshots
report failures/pending/missing states; `observed-success` does not prove required
checks, relevant plans, reviews or coverage completeness. Failed snapshots fail
the job without delegating repairs or merging. Inspect actual PR checks, review outcomes and relevant root
plans before human merge. Missing/failed checks are not green. Existing required
checks, environments, publication-origin safeguards and merge identities remain
unchanged. Merging pin changes can trigger existing target deployment workflows.

## Schedule, dry run and urgent operation

The parent rollout has registered **Sunday 00:37 UTC** in
`.github-copilot/docs/ops-clock.md`, before the per-repository Sunday update
window. This workflow uses `37 0 * * 0`; this implementation changes only
`platform-devex`. Ensure the registered clock change has landed before activation.

GitHub Actions `on.schedule` in `.github/workflows/terraform-cli-updates.yml` is
the actual native scheduler, not an ops-clock-document trigger. The owner-approved
repository variable `TF_CLI_UPDATES_ENABLED=true` has been registered, so Sunday
runs are admitted to propose updates once this workflow is on the default branch.
They still require current source-bound compatibility approval, ownership/race
checks and human merge; unknown or changed source reviews cannot authorize a pin change.
Setting that variable to `false` pauses scheduled writes while retaining read-only
discovery; it does not remove the cron. Manual dispatch defaults to dry run:

```pwsh
gh workflow run terraform-cli-updates.yml --repo frasermolyneux/platform-devex -f dry_run=true
gh workflow run terraform-cli-updates.yml --repo frasermolyneux/platform-devex -f repository=platform-monitoring -f dry_run=true
```

Run these only after the workflow has merged to the default branch; a feature
branch dispatch is not a substitute for production admission. The first discovery
step rejects every non-default-branch ref, including explicit writer dispatches,
before checkout or App token minting; rejected refs cannot publish audit comments.
Start with the
single-repository dry run, inspect its artifacts/activity-log summary, then run
discovery across the installation. An estate rollout merged at the selected
target should report `current`, no changed paths and `compatibility: "reviewed"`
for each of the 31 roots whose source identities still match. Unreviewed roots
remain `compatibility: "unknown"`. A root needing an edit without approval reports `blocked`;
it must not propose a PR. Repositories without pins report `not-applicable`.
No target branches, commits or PRs should be written; the controller's own
activity-log comment is expected.

Confirm successful installation discovery and each single-repository token mint,
complete tree/pin/PR/check/status reads where applicable, and matching expected
versus collected artifacts. A successful dry run proves the requested **read**
scopes, not Contents/Pull requests **write**. Verify installation-granted write
permissions through App governance or an already-successful repository-scoped
writer-token mint using this same broker; do not broaden dry-run credentials or
perform target writes merely to test access. Existing writer-token evidence does
not replace running this new workflow. A human `gh` token rejected by the App-only
installation-inspection API is not proof that the App lacks target permissions.

For an urgent reviewed security target, first merge the reviewed central policy,
then use `-f dry_run=false` and optionally select a repository. This bypasses only
the weekly timing/activation variable, not compatibility, ownership, race or human
merge/deployment controls. There is no arbitrary-version override or auto deploy.
Workflows must be on the default branch before these production invocations.

Every target uploads a metadata-only result and writes a job summary; summaries
report expected versus collected artifacts and fail on incomplete jobs/downloads.
The existing Self-heal activity log receives one run-specific metadata summary.
Invalid pins, unknown approvals, missing permissions, races and orphan branches
are visible failures, not quiet successful updates. Detailed per-root digests and
gap diagnostics stay in this private controller repository's run artifacts.

## Validation

```pwsh
node --test scripts/terraform-cli.test.mjs
npm run check
npm test
git diff --check
```

Tests cover multi-root detection, invalid pins, stable-release filtering,
source-bound compatibility, downgrade refusal, bounded discovery/paging,
allowlist/origin enforcement, duplicate/idempotent PRs and base/head/PR races.
They use metadata API fixtures, not target execution or cloud access.
