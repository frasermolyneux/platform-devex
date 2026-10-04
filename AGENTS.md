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
  checks only when authored by Copilot on a `copilot/` branch (including improvement batches)
  or by Dependabot on a `dependabot/` branch, with both head and base in the target repository.
  Human PRs, unknown bots, forks and missing origin metadata are skipped before any delegation
  or escalation comment; labels or branch names alone never authorize them.
  Caps delegation at 3 attempts per pull request (across all
  commits); once reached, posts a one-time escalation comment instead of re-delegating
  indefinitely, since some failures (e.g. cloud credential/Terraform provider errors) are
  environmental and no code change fixes them.
- **approve-copilot-workflow-runs** — releases Actions workflow runs stuck awaiting approval
  because they were triggered by a Copilot coding agent commit, or by a Dependabot pull request
  (actor `github-actions[bot]`, only trusted when paired with pull request author
  `dependabot[bot]`). It also considers repository-owner-triggered ready-for-review runs only
  when the current PR is a same-repository Copilot PR linked to an active labeled improvement
  issue authored by that owner. All eligible runs pass a deterministic CI-file denylist and an automated no-tool Copilot SDK
  risk review of the pending run's event-base-to-head diff when that base is recorded (with a
  logged current-PR-base fallback); anything ambiguous is left pending. Release only the latest
  original `pull_request` event per workflow for the current non-draft head, including all
  statuses when selecting the latest event. Never order by rerun time/attempt: old draft
  snapshots can skip jobs and cancel newer real validation. Recheck current PR/run state before release.
  Capture the final SDK message and require exactly one typed JSON object, rejecting duplicate
  keys. Retry malformed protocol output once, never a valid risk block; persist valid blocks
  per head/base. Log only safe category/attempt/byte diagnostics. Update owned audit comments
  on transitions with retained history; audit failures must report incomplete activity.
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
  SDK risk-review call. The improvement controller also uses this same token for Copilot issue
  assignment, PR follow-up comments, branch updates, ready-for-review transitions, review
  requests, verified thread resolution and restricted no-tool SDK analysis/verification.
  Target reads, description/evidence and audit publication, and bounded validation recovery
  use a scoped App token. Other inputs on the two maintenance actions continue to use the GitHub App token.
  If this secret is ever removed (empty), delegation comments still
  post (via the `github-token` fallback) but Copilot will not act on them, and
  `approve-copilot-workflow-runs` fails closed (leaves every run pending). If it is instead
  revoked or expired rather than removed, the fallback does not apply for `delegate-failed-checks`
  — the action's `gh api user` lookup fails and the step aborts — so replace or delete the secret
  rather than leaving a revoked value in place.
- Maintenance composites were copied locally from `actions`; the delegation copy enforces
  automated-PR eligibility via its local `eligibility.mjs` before failed-check handling. Each
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
  complete. Triaging requires an explicit opt-in, available scanners and a bounded low- or
  medium-risk, behavior-preserving SDK proposal. Read public SonarCloud code-smell findings
  from the verified `<owner>_<repository>` project (optionally authenticate with `SONAR_TOKEN`
  for private projects); never mistake an unknown project, incomplete paging or analysis older
  than the default-branch tip for a clean scan.
  Diversify sampled rules and record before/after counts; wait for a post-merge Sonar analysis
  before resolving SonarCloud findings. Keep `SONAR_TOKEN` out of the SDK environment. Missing
  scanners, absent review, incomplete checks and third-party PRs are never safe; never auto-merge.
  Before human handoff, require zero blocking new SonarCloud PR findings under the shared
  `test-style-advisory-v1` policy in `scripts/sonar-policy.mjs`; a green quality gate alone is
  insufficient. Only its six exact INFO Roslyn style/documentation CODE_SMELL rules in
  verified existing test-project source are advisory. Production code, other rules,
  security/reliability and unknown classification still block. Preserve raw counts and
  post-merge target-ID verification; advisory never means fixed. Version handoffs and report
  raw/blocking/advisory counts. Never let an improvement PR expand the policy. Use bounded
  repairs or escalate/narrow, never suppress analyzers or drop required coverage to meet caps.
  Withdraw previous handoffs when the head, escalation or quality state invalidates them.
- Keep the shared continuous-improvement test requirements consistent in SDK intake, generated
  issue acceptance criteria, agent assignment and repair/review comments. Require focused
  added/extended unit/regression tests, integration tests for affected boundaries and Playwright
  tests for affected UI journeys when already used; backend-only changes do not need browser
  tests. If existing coverage suffices, name the exact tests and explain why no additions are
  needed. PR descriptions must identify test changes, applicable layers, commands and results.
  Run locally available existing CI-equivalent analyzer checks before the final report;
  passing build/format checks alone may not cover CI diagnostics. Identify hosted-only checks
  separately from executed local commands; never invent execution or add credentials/infrastructure.
  Reuse existing tooling; never introduce unrelated test setup or omit coverage to meet scope
  limits. Apply `bounded-test-budget-v1` in `scripts/change-scope.mjs`: non-test/unverified
  changes at most eight files/250 added+deleted lines; verified test source at most eight
  files/750 lines; entire PR at most 12 files/1,000 lines. Test source may be in separate
  directories, but its allowance requires unambiguous existing C# SDK test-project proof
  at immutable head and trusted base via `scripts/test-projects.mjs`, not a test-like name.
  Check both sides of renames; count unknown languages, fixtures and configuration normally.
  Per-file counts must match PR totals. Report actual category counts and verified paths
  in handoffs. Larger budgets never authorize weaker assertions, new infrastructure or
  unrelated test churn. Testing blockers require human guidance, and human review assesses
  coverage adequacy.
- Intake defaults to one finding/one logical fix, not a daily quota. At most four findings
  in one directory need an explicit shared root cause or repeated corrective pattern,
  concrete per-finding changes and separate non-test/test estimates. Multi-finding plans
  must share a scanner/rule, or explain a shared root cause for different rules in one file.
  Correlated locations/rules alone are not semantic proof. Reject malformed plans explicitly.
  Keep one active batch per repository and human final merge; never start another to meet
  a daily throughput target or reset existing repair/review budgets.
- Keep no-tool SDK intake explicitly planning-only: supplied source/configuration and
  controller metadata support estimates, not fabricated execution. Implementation, clean-tree
  reports and actual tests/CI belong to later stages. One malformed-protocol retry is allowed
  on unchanged default-branch/batch state; never reroll a valid skip/risk veto or an SDK error.
  Recheck source SHA and active batches before issue creation; log only safe failure categories.
- New batch issues carry the `platform-devex-ci` label in addition to their body marker; query
  this label when locating open/closed batches so unrelated issues in the same repository do not
  exhaust pagination. Do not remove the label from an in-progress issue.
- The improvement controller updates behind branches and marks small, trusted, same-repository
  Copilot draft PRs ready using the human PAT (Contents/Pull requests: write); target workflows
  must run real validation on `ready_for_review`. All-skipped checks and Copilot's own
  agent/review jobs are not passing validation. Cancelled checks are orchestration failures,
  never Copilot code-fix requests. Rerun only the latest current-head PR event, previously
  released by this App, with its scoped Actions: write token. Reserve each attempt on the batch
  issue before the API call; trust only this App's markers and cap retries at two per run/head.
  Never rerun active or approval-required runs, and recheck PR/head/origin/run state before
  writing. Ignore obsolete cancelled contexts only with a newer successful event of that
  workflow; real checks and merge requirements still gate handoff. Unmapped cancellations,
  uncertain retry outcomes and exhausted budgets require human attention. Recheck the
  PR SHA, branch freshness and GitHub merge requirements before handing off for human review.
  Draft PR check failures and non-draft failures outside the sweep's check-run criteria get up
  to three same-SHA deduplicated human-PAT mentions; the separate failed-check action handles
  non-draft check-run failures. Request Copilot reviews after passing validation using the
  entitled human PAT, not the App token (which can silently ignore a successful request).
  Verify a new human-authored Copilot review-request timeline event before writing the per-head
  marker; legacy App-request markers must not suppress a verified request. Publish authenticated,
  current-head test evidence into the controller-owned PR section; normalized reports must
  preserve actual reported commands/results, never invent execution. Metadata-only evidence
  requests do not consume code repair attempts. Compare every unresolved Copilot conversation,
  including outdated/old-head threads, against current source, full patches and test wiring
  before resolving with the human PAT. Independently assess coverage with zero conversations.
  Human/mixed threads block handoff and are never resolved automatically. Metadata repairs and
  resolutions require a fresh completed review even at the same SHA. Recheck evidence, origin,
  head, conversations and CI before writes/handoff. A narrowly verified complete successful
  roll-up may allow UNSTABLE human handoff, never BLOCKED/unknown/incomplete protections.
  Owner resume markers must name the exact latest App escalation and never reset budgets.
  Replace auto-closing issue references with `Refs #...` for post-merge verification.
- The single user-owned `COPILOT_AGENT_PAT` needs Metadata: read, Actions, Contents, Issues
  and Pull requests: read/write on every opted-in repository for the preview issue-assignment
  API, plus account-level Copilot Requests: read for CLI review. Never provision it through
  Terraform. The improvement SDK uses this PAT only as session identity, with no tools or custom
  instructions, rejecting permission requests and stripping tokens from the child environment.
  The scoped App token needs the
  opted-in repository's scanning and issue/PR/check permissions plus Actions: write for bounded
  workflow recovery; its installation permissions
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
- `docs/plans/estate-analysis-alignment.md` - planned estate-wide analysis migration; not the
  current runtime contract until implemented.
