# Reviewed Terraform CLI updates

`terraform-cli-updates.yml` is a deterministic metadata-only maintenance controller.
Dependabot remains the only Terraform provider/module updater. This controller
does not run target code, HCL, Terraform, providers, package installers or cloud
authentication. It never edits workflows, locks, constraints or merge/publication
machinery, changes merge identities, auto-merges, or deploys.

## Approval before activation

The committed `scripts/terraform-cli-policy.json` records the owner-approved
baseline **1.17.0** (21 October 2026) and `approvedMinor: "1.17"`, with no
root compatibility reviews yet. The owner reviewed its Go 1.26.10 build and
CVE-2026-111943 fix; that is not a blanket claim about every advisory/feature.
This is deliberately **not activated for scheduled writes**. Official release
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
For each discovered root, the artifact reports a SHA-256 `sourceDigest` over
the sorted `[repository-relative path, Git blob SHA]` pairs of **every direct-root
`.tf` and `.tf.json` file**, including override files. Read those exact sources
at the reported base commit, assess all `required_version` constraints and
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
      "rationale": "Record the exact reviewed constraints, override handling and compatibility conclusion"
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
roots or 512 source files per root fail closed. Metadata responses are bounded
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

The reviewed ops-clock file has no Sunday 00:37 UTC allocation. This workflow
proposes `37 0 * * 0`, before the per-repository Sunday update window. **The parent
rollout must record the central slot in `.github-copilot/docs/ops-clock.md` before
activation**; this implementation changes only `platform-devex`.

Scheduled runs remain read-only until the owner explicitly sets repository
variable `TF_CLI_UPDATES_ENABLED=true` after target/compatibility approvals and
permission/CI acceptance. Manual dispatch defaults to dry run:

```pwsh
gh workflow run terraform-cli-updates.yml --repo frasermolyneux/platform-devex -f dry_run=true
gh workflow run terraform-cli-updates.yml --repo frasermolyneux/platform-devex -f repository=platform-monitoring -f dry_run=true
```

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
