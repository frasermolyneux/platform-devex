# platform-devex

Internal developer platform automation: scheduled workflows for PR self-healing, stale-branch updates, and Copilot delegation on failed checks across frasermolyneux repositories.

## What it does

`.github/workflows/self-heal.yml` runs every 30 minutes (and on demand via `workflow_dispatch`):

1. **Discover** — mints a GitHub App installation token and lists every repository the shared
   frasermolyneux GitHub App is installed on (no static repo list to maintain).
2. **Sweep** — for each discovered repository, mints a repository-scoped installation token and
   runs two composite actions from [`frasermolyneux/actions`](https://github.com/frasermolyneux/actions):
   - [`stale-branch-sweep`](https://github.com/frasermolyneux/actions/tree/main/stale-branch-sweep) —
     updates the head branch of open pull requests that have auto-merge enabled but have fallen
     behind their base branch. This unsticks Dependabot PRs stuck "out-of-date with base branch".
   - [`delegate-failed-checks`](https://github.com/frasermolyneux/actions/tree/main/delegate-failed-checks) —
     comments `@copilot investigate and resolve the failed checks on this pull request` once per
     failing commit SHA, so Copilot can pick up the fix.

## Provisioning

The `platform-devex` GitHub repository itself is provisioned by `platform-workloads`
(`terraform/workloads/platform/platform-devex.json`), which also writes the `GH_APP_ID` variable
and `GH_APP_PEM` secret used to mint installation tokens here. This repository does not contain
any Terraform.

## Running manually

```pwsh
gh workflow run self-heal.yml --repo frasermolyneux/platform-devex
gh run list --workflow self-heal.yml --repo frasermolyneux/platform-devex --limit 5
```
