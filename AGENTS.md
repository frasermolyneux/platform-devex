# platform-devex agent brief

## Purpose and ownership

This repository hosts scheduled internal-developer-platform automation, with a small Node.js
controller for continuous improvement rather than target-application code. Three independent
maintenance workflows discover every repository the shared frasermolyneux GitHub App is installed
on and run locally vendored composite actions against each:

- **stale-branch-sweep** — updates the head branch of every open pull request that is behind its
  base branch, regardless of auto-merge status (also unsticks Dependabot PRs stuck
  "out-of-date with base branch"; does not merge them).
- **delegate-failed-checks** — comments `@copilot investigate and resolve the failed checks on
  this pull request` once per failing commit SHA on open, non-draft pull requests with failing
  checks whose head and base repositories match. Fork-head PRs and PRs with missing repository
  metadata are skipped before a human-PAT comment can be posted; same-repository PRs retain their
  prior handling regardless of author. Caps delegation at 3 attempts per pull request (across all
  commits); once reached, posts a one-time escalation comment instead of re-delegating
  indefinitely, since some failures (e.g. cloud credential/Terraform provider errors) are
  environmental and no code change fixes them.
- **approve-copilot-workflow-runs** — releases Actions workflow runs stuck awaiting approval
  because they were triggered by a Copilot coding agent commit, or by a Dependabot pull request
  (actor `github-actions[bot]`, only trusted when paired with pull request author
  `dependabot[bot]`). It also considers repository-owner-triggered ready-for-review runs only
  when the current PR is a same-repository Copilot PR linked to an active labeled improvement
  issue authored by that owner. All eligible runs pass a deterministic CI-file denylist and an automated Copilot CLI
  risk review of the pending run's event-base-to-head diff when that base is recorded (with a
  logged current-PR-base fallback); anything ambiguous is left pending.
- Each workflow's **summarize** job collects its own per-repository activity (or failures) into
  one run-specific comment on this repository's "Self-heal activity log" tracking issue, using
  the default `github.token` (not the App token) since it only ever writes to this repository.

`.github/workflows/continuous-improvement.yml` separately scans GitHub security and quality
alerts for explicitly opted-in repositories daily, reconciles existing batches hourly, and
leaves final PR review and merge to a human. It uses `scripts/continuous-improvement.mjs` and
its Node tests. An empty `vars.CI_REPOSITORIES` disables the matrix; never default to all App
installation repositories for this workflow.

The repository itself is provisioned through `platform-workloads` (catalog entry
`terraform/workloads/platform/platform-devex.json`); do not add Terraform here.

## Important paths

- `.github/workflows/stale-branches.yml` — discovers installation repositories and runs
  `.github/actions/stale-branch-sweep/action.yml` per repository.
- `.github/workflows/delegate-failed-checks.yml` — discovers installation repositories and runs
  `.github/actions/delegate-failed-checks/action.yml` per repository.
- `.github/workflows/approve-copilot-runs.yml` — discovers installation repositories and runs
  `.github/actions/approve-copilot-workflow-runs/action.yml` per repository.
- `.github/workflows/continuous-improvement.yml` — opt-in daily intake and hourly reconciliation.
- `scripts/continuous-improvement.mjs` — Copilot SDK triage, linked issue/PR reconciliation,
  bounded review fixes and human escalation.
- `README.md` — repository overview and manual run instructions.

## Useful commands

```pwsh
gh workflow run stale-branches.yml
gh workflow run delegate-failed-checks.yml
gh workflow run approve-copilot-runs.yml
gh workflow run continuous-improvement.yml -f mode=intake -f dry_run=true
gh run list --workflow stale-branches.yml --limit 5
npm test
```

Validate with `npm run check`, `npm test`, workflow linting, `git diff --check` and, once the
workflows are on the default branch, `gh workflow run` / `gh run watch` against a real run.

## Contracts and constraints

- Uses the shared GitHub App broker pattern: `vars.GH_APP_ID` / `secrets.GH_APP_PEM` are written
  to this repository by `platform-workloads` (`github_app.enabled: true` in its catalog entry).
- Mint a fresh, repository-scoped installation token per target repository
  (`actions/create-github-app-token` with `repositories: <name>`) rather than reusing one broad
  token across the matrix — least privilege per job.
- `secrets.COPILOT_AGENT_PAT` is a fine-grained personal access token from a human account
  (not the GitHub App), set directly on this repository with `gh secret set` — **never** via
  `platform-workloads` Terraform, which must never manage credentials. It is passed to
  `delegate-failed-checks`' `mention-token` input, because GitHub's Copilot coding agent ignores
  `@copilot` mentions authored by a GitHub App/bot identity and only acts on mentions from a real
  user with write access and Copilot entitlement, and to `approve-copilot-workflow-runs`'
  `copilot-token` input, which needs a human account with Copilot entitlement to authenticate the
  CLI risk-review call. The improvement controller also uses this same token for Copilot issue
  assignment, PR follow-up comments and a restricted, no-tool SDK analysis session; its other
  target-repository operations use a scoped App
  token. Other inputs on the two maintenance actions continue to use the GitHub App token.
  If this secret is ever removed (empty), delegation comments still
  post (via the `github-token` fallback) but Copilot will not act on them, and
  `approve-copilot-workflow-runs` fails closed (leaves every run pending). If it is instead
  revoked or expired rather than removed, the fallback does not apply for `delegate-failed-checks`
  — the action's `gh api user` lookup fails and the step aborts — so replace or delete the secret
  rather than leaving a revoked value in place.
- Maintenance composites were copied locally from `actions`; the delegation copy adds an opt-in
  `same-repository-only` guard enabled by its workflow (default `false` for other callers). Each
  matrix job checks out `platform-devex` at `${{ github.sha }}` with
  `persist-credentials: false` before using the local action path; `contents: read` on the default
  token is needed only for this checkout. Never check out the target repository to execute its
  code as a maintenance action.
- Do not hard-code repository names in the workflow — the target list is discovered dynamically
  from the GitHub App installation so newly onboarded repositories are picked up automatically.
- Each workflow has its own concurrency group and staggered 30-minute schedule. A failure in one
  repository (`fail-fast: false`) must not block others. Failures and missing artifacts must be
  reported as incomplete, not as quiet runs.
- Continuous improvement batches must remain one per repository until the linked issue/PR is
  complete. Triaging requires an explicit opt-in, available scanners and a low-risk bounded SDK
  proposal. It must never treat a missing scanner, absent review, incomplete check set or
  third-party PR as safe; unresolved work is escalated, never auto-merged.
- New batch issues carry the `platform-devex-ci` label in addition to their body marker; query
  this label when locating open/closed batches so unrelated issues in the same repository do not
  exhaust pagination. Do not remove the label from an in-progress issue.
- The improvement controller updates behind branches and marks small, trusted, same-repository
  Copilot draft PRs ready using the human PAT (Contents/Pull requests: write); target workflows
  must run real validation on `ready_for_review`. All-skipped checks are not green. Recheck the
  PR SHA, branch freshness and GitHub merge requirements before handing off for human review.
  Draft PR check failures and non-draft failures outside the sweep's check-run criteria get up
  to three same-SHA deduplicated human-PAT mentions; the separate failed-check action handles
  non-draft check-run failures. Copilot reviews are requested after passing validation;
  unresolved Copilot review threads must be addressed before handoff. Auto-closing issue
  references in the PR description are replaced with `Refs #...` to retain the batch issue
  for post-merge verification, then only the corresponding review thread is resolved.
- The single user-owned `COPILOT_AGENT_PAT` needs Metadata: read, Actions, Contents, Issues
  and Pull requests: read/write on every opted-in repository for the preview issue-assignment
  API, plus account-level Copilot Requests: read for CLI review. Never provision it through
  Terraform. The improvement SDK uses this PAT only as session identity, with no tools or custom
  instructions, rejecting permission requests and stripping tokens from the child environment.
  The scoped App token needs the
  opted-in repository's scanning and issue/PR/check permissions; its installation permissions
  are changed in `platform-workloads`.
- Keep `permissions: {}` at the workflow level. Maintenance discover jobs need no default-token
  permissions; the improvement discover job needs `contents: read` to check out its controller.
  Matrix jobs grant only `contents: read` on the default token to check out local actions; the
  per-repository GitHub App token requests only the action's required repository permissions.
  `summarize` needs
  `issues: write` and `actions: read` on the default token to download artifacts and write within
  `platform-devex`. The improvement workflow grants `contents: read` to its jobs for checkout
  and `issues: write` only to its failure reporter.

## Authoritative repository docs

- `README.md`
