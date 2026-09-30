# platform-devex

Internal developer platform automation: scheduled workflows for PR self-healing, stale-branch updates, and Copilot delegation on failed checks across frasermolyneux repositories.

## What it does

`.github/workflows/self-heal.yml` runs every 30 minutes (and on demand via `workflow_dispatch`):

1. **Discover** — mints a GitHub App installation token and lists every repository the shared
   frasermolyneux GitHub App is installed on (no static repo list to maintain).
2. **Sweep** — for each discovered repository, mints a repository-scoped installation token and
   runs three composite actions from [`frasermolyneux/actions`](https://github.com/frasermolyneux/actions):
   - [`stale-branch-sweep`](https://github.com/frasermolyneux/actions/tree/main/stale-branch-sweep) —
     updates the head branch of open pull requests that have auto-merge enabled but have fallen
     behind their base branch. This unsticks Dependabot PRs stuck "out-of-date with base branch".
   - [`delegate-failed-checks`](https://github.com/frasermolyneux/actions/tree/main/delegate-failed-checks) —
     comments `@copilot investigate and resolve the failed checks on this pull request` once per
     failing commit SHA, so Copilot can pick up the fix.
   - [`approve-copilot-workflow-runs`](https://github.com/frasermolyneux/actions/tree/main/approve-copilot-workflow-runs) —
     finds Actions workflow runs stuck awaiting approval because they were triggered by a Copilot
     coding agent commit, and releases the ones that pass a deterministic CI-file denylist plus an
     automated Copilot CLI risk review. Anything touching workflow/action/Dockerfile/CODEOWNERS
     files, or that the CLI review doesn't clearly approve, is left pending for a human.

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
same human account, to produce its risk-review verdict. Since `self-heal.yml` otherwise runs
entirely on the shared GitHub App's installation tokens, `delegate-failed-checks` and
`approve-copilot-workflow-runs` are also given a fine-grained personal access token
(`secrets.COPILOT_AGENT_PAT`) so the delegation comment is authored by a human account (and
Copilot actually responds to it) and the CLI review call authenticates successfully. Everything
else — discovery, `stale-branch-sweep`, the read-only lookups inside the other two steps, the
release call inside `approve-copilot-workflow-runs`, its audit comment (always posted via
`github-token`, never the PAT), and `delegate-failed-checks`' own fallback comment when the PAT
is absent — continues to use the GitHub App token.

`platform-workloads` must never manage credentials, so this PAT is **not** provisioned through
Terraform. Set it directly as a repository secret:

```pwsh
gh secret set COPILOT_AGENT_PAT --repo frasermolyneux/platform-devex
```

Use a fine-grained PAT scoped to the target repositories, owned by an account that has Copilot
entitlement and write access to those repositories, with:

- Repository permissions — `Pull requests: Read and write` (GitHub treats
  `POST .../issues/{n}/comments` as a pull requests permission, not an issues one) — used by
  `delegate-failed-checks` to post the delegation comment as a human.
- Account permissions — `Copilot Requests: Read` — used by `approve-copilot-workflow-runs` to
  authenticate the CLI risk review.

Rotate it like any other credential; if the secret is missing (empty), `delegate-failed-checks`
falls back to the GitHub App token and still posts comments, but Copilot will not act on them,
and `approve-copilot-workflow-runs` fails closed (leaves every run pending) since it cannot
authenticate the CLI. If the PAT is instead revoked or expired (a non-empty but invalid value),
the fallback does not apply: `delegate-failed-checks`'s `gh api user` lookup fails and that step
aborts, so remove or replace the secret rather than leaving a revoked value in place.

## Running manually

```pwsh
gh workflow run self-heal.yml --repo frasermolyneux/platform-devex
gh run list --workflow self-heal.yml --repo frasermolyneux/platform-devex --limit 5
```
