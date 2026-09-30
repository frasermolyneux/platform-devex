# platform-devex agent brief

## Purpose and ownership

This repository hosts scheduled internal-developer-platform automation. It does not contain
application code. Its scheduled workflow discovers every repository the shared frasermolyneux
GitHub App is installed on and runs self-healing composite actions from the `actions` repository
against each one:

- **stale-branch-sweep** — updates the head branch of open pull requests that have auto-merge
  enabled but have fallen behind their base branch (unsticks Dependabot auto-merge PRs stuck
  "out-of-date with base branch").
- **delegate-failed-checks** — comments `@copilot investigate and resolve the failed checks on
  this pull request` once per failing commit SHA on open, non-draft pull requests with failing
  checks.
- **approve-copilot-workflow-runs** — releases Actions workflow runs stuck awaiting approval
  because they were triggered by a Copilot coding agent commit, after a deterministic CI-file
  allowlist check and an automated Copilot CLI risk review; anything ambiguous is left pending.

The repository itself is provisioned through `platform-workloads` (catalog entry
`terraform/workloads/platform/platform-devex.json`); do not add Terraform here.

## Important paths

- `.github/workflows/self-heal.yml` — the scheduled orchestrator: discovers installation
  repositories, then runs `stale-branch-sweep`, `delegate-failed-checks`, and
  `approve-copilot-workflow-runs` per repository.
- `README.md` — repository overview and manual run instructions.

## Useful commands

```pwsh
gh workflow run self-heal.yml
gh workflow view self-heal.yml
gh run list --workflow self-heal.yml --limit 5
```

There is no local build or test suite; validation is limited to workflow linting and
`gh workflow run` / `gh run watch` against a real run.

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
  CLI risk-review call. Every other step, and every other input on those two steps, continues to
  use the GitHub App token. If this secret is ever removed (empty), delegation comments still
  post (via the `github-token` fallback) but Copilot will not act on them, and
  `approve-copilot-workflow-runs` fails closed (leaves every run pending). If it is instead
  revoked or expired rather than removed, the fallback does not apply for `delegate-failed-checks`
  — the action's `gh api user` lookup fails and the step aborts — so replace or delete the secret
  rather than leaving a revoked value in place.
- Composite actions are referenced by folder-scoped release tags from `actions`
  (e.g. `frasermolyneux/actions/stale-branch-sweep@stale-branch-sweep/v1`). Bump the tag deliberately
  when adopting a new major/minor version; do not float on `main`.
- Do not hard-code repository names in the workflow — the target list is discovered dynamically
  from the GitHub App installation so newly onboarded repositories are picked up automatically.
- This is a scheduled, best-effort self-healing job: failures in one repository (`fail-fast:
  false`) must not block others.

## Authoritative repository docs

- `README.md`
