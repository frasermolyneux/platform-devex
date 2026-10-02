# platform-devex

Internal developer platform automation: separate maintenance workflows for PR branch updates,
Copilot delegation and trusted pending workflow runs, plus opt-in continuous improvement across
frasermolyneux repositories.

## What it does

Three independent workflows run every 30 minutes on staggered schedules, or on demand via
`workflow_dispatch`. Each discovers the repositories where the shared frasermolyneux GitHub App is
installed, mints a fresh repository-scoped token per matrix job, and runs a local composite action
from `.github/actions/`:

- `.github/workflows/stale-branches.yml` runs `stale-branch-sweep`, which updates **all** open pull
  request branches that are behind their base branch, whether or not auto-merge is enabled. This
  also unsticks Dependabot PRs that are "out-of-date with base branch"; it does not merge PRs.
- `.github/workflows/delegate-failed-checks.yml` runs `delegate-failed-checks`, which comments
  `@copilot investigate and resolve the failed checks on this pull request` once per failing
  commit SHA on an open, non-draft **automated** PR: either Copilot-authored on a `copilot/`
  branch (including continuous-improvement batches), or Dependabot-authored on a `dependabot/`
  branch. Both head and base must belong to the target repository. Human-authored PRs, unknown
  bots, forks and missing origin metadata are skipped **before** checking failures or posting
  delegation/escalation comments. A branch name, label or Copilot assignment alone does not opt
  a human PR in. It caps delegation at 3 attempts per PR across all commits; once reached, it posts a
  one-time human escalation rather than re-delegating indefinitely. Environmental failures
  (such as cloud credentials or Terraform provider auth) need a human.
- `.github/workflows/approve-copilot-runs.yml` runs `approve-copilot-workflow-runs`, which reviews
  workflow runs pending approval after Copilot coding agent commits, or Dependabot PRs recorded as
  actor `github-actions[bot]` **only** when the PR author is `dependabot[bot]`. Its deterministic
  CI-file denylist and Copilot CLI risk review use the pending run's event-time base and head
  commits when recorded (with a logged fallback to the current PR base if the event base is
  absent). Runs triggered when the repository owner marks an improvement PR ready are also
  eligible **only** for a current, same-repository Copilot PR linked to an open, labeled batch
  issue authored by that owner; they pass the same denylist and risk review. Ambiguous or unsafe
  changes remain pending for a human. Only the latest original `pull_request` event per
  workflow on the current, non-draft PR head can be released. Older draft events are skipped
  even if rerun more recently; reruns preserve their original draft snapshot and can otherwise
  cancel current validation through workflow concurrency. The PR and latest run are rechecked
  immediately before release.

Each matrix tolerates other repositories failing (`fail-fast: false`). Each workflow uploads
activity or failure results per repository and posts one run-specific comment to the existing
`platform-devex` "Self-heal activity log" issue; quiet successful runs post nothing, while
incomplete runs are called out explicitly. Separate concurrency groups prevent overlapping runs of the same workflow without blocking the
other two.

### Opt-in continuous improvement

`.github/workflows/continuous-improvement.yml` runs a daily intake at 05:17 UTC and reconciles
existing batches hourly. It only processes repositories explicitly listed in the
`CI_REPOSITORIES` repository variable (comma-separated **repository names**, not owner/repo).
When this variable is unset, the matrix is empty and **no issues or PRs are created**. At most
two opted-in repositories run concurrently; each repository has one active issue/PR batch at a
time. A manual `workflow_dispatch` can select `intake` or `reconcile`, one opted-in repository,
and a dry run (enabled by default for manual runs).

For each opted-in repository, the workflow reads open default-branch CodeQL/code-scanning,
Dependabot and SonarCloud **code-smell** findings. It samples up to 12 source excerpts from
different rule/directory groups (not merely the first dozen alerts), and asks the Copilot SDK
for an actionable, behavior-preserving quality or security improvement. It creates an issue
only for a bounded low- or medium-risk proposal with at most four findings in one directory.
Critical/blocker alerts, CI/infrastructure/auth changes and uncertain behavior remain for a
human. A proposed PR may touch at most eight files and 250 changed lines; gated paths are
always escalated. Stale alerts whose source files no longer exist on the default branch are
skipped with a warning; SonarCloud paths relative to a scanned `src` directory are resolved
against GitHub before sampling. Eligible issues are assigned to Copilot, with a requirement to preserve
observable functionality, architecture, performance and cost and run the target repository's
relevant unit, integration and Playwright tests. Batch issues
carry a `platform-devex-ci` label so reconciliation does not page through unrelated issue history.
Each issue records open-finding counts by scanner at intake. After human merge, the controller
waits for the selected findings to disappear on the default branch and, for SonarCloud
findings, for an analysis newer than the merge. It comments with before/after counts and the
net change (which may reflect unrelated new findings) before closing the issue; a passing
PR check alone never counts as a resolved finding.
The improvement reconciler checks that its trusted, same-repository Copilot PR has a small,
non-sensitive diff, updates its branch if behind, and marks a draft ready for review. This
triggers repositories whose validation workflows skip drafts but run on `ready_for_review`.
Skipped-only checks and Copilot's own agent/review jobs do not count as passing validation.
Cancelled checks are handled as orchestration failures, not requests for code changes: the
controller retries only the latest current-head workflow event that was already released by
the trusted App, using that repository's App token. Retries are capped at two per run/head,
with an App-authored reservation on the batch issue before each API call. Active or
approval-required runs are left alone. Obsolete cancelled contexts may be ignored only when
the same workflow has a newer successful event; real passing checks and GitHub merge
requirements still apply. Unmappable cancellations, uncertain retry outcomes and exhausted
budgets escalate to a human. It handles failed checks on drafts and non-draft
failures outside the sweep's check-run criteria (at most three attempts); the separate
failed-check workflow handles non-draft check-run failures. After real validation passes, it
requests a review of the latest commit from Copilot, delegates inline findings at most twice,
and escalates stalled, oversized, CI-changing or unresolved work. If Copilot used an
auto-closing reference to the batch issue, the controller changes it to `Refs #...` so the
issue stays open through post-merge verification; it resolves Copilot's corresponding
review thread only after correcting the description. Other unresolved Copilot threads
are delegated, not silently ignored. It rechecks the PR's SHA,
branch freshness and GitHub merge requirements before posting a human handoff containing
alert IDs, changed files and passing check names. Optional skipped jobs are not reported as
passing. The pending-run approval gate releases the PR's validation runs only after the
separate CI-file denylist and restricted Copilot CLI risk review. **A human reviews and merges the PR.** After merging,
the controller verifies the target alerts are gone before closing
the issue. An incomplete run is reported on this repository's "Continuous improvement activity
log" issue; unavailable scanners are never treated as clean results.

Before opting in a repository:

1. Ensure its test and scan workflows run on ready Copilot PRs (including the
   `ready_for_review` event if they skip drafts) and enforce the desired branch checks.
   The controller requests Copilot review after passing validation, including after new
   commits; automatic draft review is not required. A Copilot `COMMENTED` review without
   inline findings is **not** a formal approval: the final review and merge are always
   human decisions.
   Code scanning, Dependabot and SonarCloud are required by default. The nine currently
   opted-in repositories use public SonarCloud projects named `<owner>_<repository>`, which
   can be read without a new secret. For private SonarCloud projects, set this repository's
   `SONAR_TOKEN` secret to a SonarQube Cloud token with project browse permission. The token
   is stripped from the Copilot SDK child process. Missing/inaccessible projects and
   truncated, failed or stale scans (last analysis predates the default-branch tip) are never
   treated as zero findings. To deliberately disable a
   source, set `CI_SCAN_SOURCES` to a comma-separated subset of `code-scanning,dependabot,sonarcloud`;
   disabling the source of an in-flight batch prevents post-merge verification.
2. Grant the shared GitHub App **Security events: read** (code scanning), **Dependabot alerts:
   read** (vulnerability alerts), **Issues: write**, **Pull requests: write**, **Checks: read**,
   **Commit statuses: read**, **Contents: read**, and **Actions: write** (bounded validation
   recovery) on opted-in repositories. The App is
   provisioned by `platform-workloads`; change its permissions there, not by adding Terraform
   here. If token minting fails, no batch is created and the failure is reported.
3. Expand the existing `COPILOT_AGENT_PAT` fine-grained token to cover all opted-in
   repositories. Its owner needs Copilot entitlement and write access to each one. GitHub's
   preview issue-assignment API requires a **user token**, not the App installation token.
   Grant the repository permissions listed below, then update the existing secret if the
   token was rotated. To configure the opt-in after provisioning:

```pwsh
gh variable set CI_REPOSITORIES --body "first-repo,second-repo" --repo frasermolyneux/platform-devex
gh workflow run continuous-improvement.yml -f mode=intake -f repository=first-repo -f dry_run=true --repo frasermolyneux/platform-devex
```

The SDK uses the existing user-owned `COPILOT_AGENT_PAT` only as a per-session identity; the
token is stripped from the SDK child process's environment. Its restricted session has no tools,
rejects all permission requests, loads no custom instructions, and makes one time-limited analysis
request under the SDK's minimum supported 30-credit **soft** session limit (one response can
exceed the limit). Usage is billed to the PAT owner's Copilot seat. GitHub App installation
tokens are minted separately per opted-in repository. The opt-in guard does not authorize external
contributions: the improvement path only follows trusted Copilot PRs from the same repository.

## Provisioning

The `platform-devex` GitHub repository itself is provisioned by `platform-workloads`
(`terraform/workloads/platform/platform-devex.json`), which also writes the `GH_APP_ID` variable
and `GH_APP_PEM` secret used to mint installation tokens here. This repository does not contain
any Terraform.

### Why a personal access token is also required

GitHub's Copilot coding agent only acts on `@copilot` mentions posted by a real human user with
write access and Copilot entitlement — it silently ignores mentions authored by a GitHub App or
other bot identity. It also gates Copilot's own pushes behind manual workflow-run approval the
same way it gates first-time-contributor forks, and the `approve-copilot-workflow-runs` release
step (`.../actions/runs/{id}/rerun`) still needs an authenticated Copilot CLI call, run under the
same human account, to produce its risk-review verdict. Since the maintenance workflows otherwise
run on the shared GitHub App's installation tokens, one fine-grained personal access token
(`secrets.COPILOT_AGENT_PAT`) is used for the delegation comment, the CLI risk-review call,
the improvement controller's Copilot issue assignment, PR follow-up comments,
ready-for-review transition, branch updates and review-thread resolution, and the
restricted SDK analysis session. The improvement controller uses its scoped App token
for target reads, review requests and bounded cancelled-validation reruns;
discovery, `stale-branch-sweep`, the maintenance actions' read-only lookups, the pending-run
release call and audit comment, and the delegation fallback comment use the App token.

`platform-workloads` must never manage credentials, so this PAT is **not** provisioned through
Terraform. Set it directly as a repository secret:

```pwsh
gh secret set COPILOT_AGENT_PAT --repo frasermolyneux/platform-devex
```

Use a **user-owned fine-grained PAT** with Copilot entitlement and write access, selecting
every repository opted into improvement or maintained by the shared workflows:

- **Repository permissions:** Metadata: read; Actions, Contents, Issues, and Pull requests:
  read and write. These are GitHub's documented permissions for
  [assigning Copilot to an issue via the API](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api#using-the-issues-api).
  Pull requests: read/write also allows human-authored `@copilot` comments on PRs.
- **Account permission:** Copilot Requests: read, for the
  [Copilot CLI risk review](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/troubleshoot-copilot-cli-auth#token-expired-or-revoked).

Expanding the existing token grants its other consumers these additional repository permissions
too; keep its repository selection limited to the repositories these workflows manage. If you
rotate it rather than editing its permissions, update `COPILOT_AGENT_PAT` with the command above.

Rotate it like any other credential; if the secret is missing (empty), `delegate-failed-checks`
falls back to the GitHub App token and still posts comments, but Copilot will not act on them,
and `approve-copilot-workflow-runs` fails closed (leaves every run pending) since it cannot
authenticate the CLI. If the PAT is instead revoked or expired (a non-empty but invalid value),
the fallback does not apply: `delegate-failed-checks`'s `gh api user` lookup fails and that step
aborts, so remove or replace the secret rather than leaving a revoked value in place.

## Running manually

```pwsh
gh workflow run stale-branches.yml --repo frasermolyneux/platform-devex
gh workflow run delegate-failed-checks.yml --repo frasermolyneux/platform-devex
gh workflow run approve-copilot-runs.yml --repo frasermolyneux/platform-devex
gh workflow run continuous-improvement.yml -f mode=reconcile -f dry_run=true --repo frasermolyneux/platform-devex
gh run list --workflow stale-branches.yml --repo frasermolyneux/platform-devex --limit 5
gh run list --workflow delegate-failed-checks.yml --repo frasermolyneux/platform-devex --limit 5
gh run list --workflow approve-copilot-runs.yml --repo frasermolyneux/platform-devex --limit 5
gh run list --workflow continuous-improvement.yml --repo frasermolyneux/platform-devex --limit 5
```
