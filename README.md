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
  commit SHA on an open, non-draft PR. This workflow opts into `same-repository-only`: it skips
  fork-head PRs (and PRs with missing head/base repository metadata) **before** posting a
  human-PAT `@copilot` comment, while continuing to handle same-repository PRs regardless of
  author. It caps delegation at 3 attempts per PR across all commits; once reached, it posts a
  one-time human escalation rather than re-delegating indefinitely. Environmental failures
  (such as cloud credentials or Terraform provider auth) need a human.
- `.github/workflows/approve-copilot-runs.yml` runs `approve-copilot-workflow-runs`, which reviews
  workflow runs pending approval after Copilot coding agent commits, or Dependabot PRs recorded as
  actor `github-actions[bot]` **only** when the PR author is `dependabot[bot]`. Its deterministic
  CI-file denylist and Copilot CLI risk review use the pending run's event-time base and head
  commits when recorded (with a logged fallback to the current PR base if the event base is
  absent); ambiguous or unsafe changes remain pending for a human.

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

For each opted-in repository, the workflow reads open default-branch CodeQL/code-scanning and
Dependabot alerts, samples short source-file excerpts, and asks the Copilot SDK for a bounded
impact analysis. It creates an issue **only** for a low-risk proposal with at most three alerts
in one directory; critical alerts and broad or uncertain work remain for a human. Stale alerts
whose source files no longer exist on the default branch are skipped with a warning. Eligible
issues are assigned to Copilot, with a requirement to preserve functionality, architecture and
cost and run the target repository's relevant unit, integration and Playwright tests. Batch issues
carry a `platform-devex-ci` label so reconciliation does not page through unrelated issue history.
The improvement reconciler handles failed checks on its **draft** Copilot PRs and non-draft
failures outside the sweep's check-run criteria (at most three attempts); the separate
failed-check workflow handles non-draft check-run failures. It waits for automatic Copilot review of
draft PRs, or requests a fresh review on a ready PR, delegates inline review findings at most
twice, and escalates stalled, oversized, CI-changing or unresolved work.
When checks pass and the latest review has no inline findings, it posts a handoff containing
alert IDs, changed files and check names. **A human reviews and merges the PR.** After merging,
the controller waits for the target alerts to disappear on the default branch before closing
the issue. An incomplete run is reported on this repository's "Continuous improvement activity
log" issue; unavailable scanners are never treated as clean results.

Before opting in a repository:

1. Ensure its test and scan workflows run on Copilot PRs and enforce the desired branch checks.
   Enable automatic Copilot code review for draft PRs and new pushes if the handoff should
   happen before a human marks the PR ready; otherwise the draft remains pending until a
   human does so. A Copilot `COMMENTED` review without inline findings is **not** a formal
   approval: the final review and merge are always human decisions.
   The workflow reads GitHub code-scanning/SARIF and Dependabot alerts; external services such
   as SonarCloud require a separate integration. Both alert sources are required by default.
   If only one is intentionally configured, set `CI_SCAN_SOURCES` to `code-scanning` or
   `dependabot`. A source that *is* configured but returns an error pauses intake.
2. Grant the shared GitHub App **Security events: read** (code scanning), **Dependabot alerts:
   read** (vulnerability alerts), **Issues: write**, **Pull requests: write**, **Checks: read**,
   **Commit statuses: read**, and **Contents: read** on opted-in repositories. The App is
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
the improvement controller's Copilot issue assignment and PR follow-up comments, and the
restricted SDK analysis session. The
improvement controller uses its scoped App token for target reads and review requests;
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
