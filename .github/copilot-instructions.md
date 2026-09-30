# Copilot Instructions

## Repository purpose and layout

This repository is the internal developer platform automation surface. It contains no
application code — only a scheduled GitHub Actions workflow that runs self-healing composite
actions (from the `actions` repository) across every repository the shared frasermolyneux
GitHub App is installed on.

- `.github/workflows/self-heal.yml` — discovers installation repositories, then runs
  `stale-branch-sweep` and `delegate-failed-checks` per repository on a schedule and via
  `workflow_dispatch`.
- The repository itself is provisioned by `platform-workloads`
  (`terraform/workloads/platform/platform-devex.json`); do not add Terraform to this repository.

## Validation

There is no application build or test suite. Validate workflow changes by:

```powershell
git diff --check
```

- Re-read the whole workflow after editing to confirm YAML structure, `needs`, and
  `matrix`/`fromJson` wiring stay correct.
- Prefer a `workflow_dispatch` run (or `act`, if available) over guessing at YAML correctness.

## Conventions

- Use `actions/create-github-app-token` with `owner: ${{ github.repository_owner }}` and a
  `repositories:` scope, minting a fresh token per target repository rather than reusing one
  broad token.
- Reference composite actions from `actions` by folder-scoped release tag
  (e.g. `frasermolyneux/actions/stale-branch-sweep@stale-branch-sweep/v1`), never `@main`.
- Keep `permissions: {}` at the workflow level; grant only the token scopes each step actually
  needs.
- Keep `fail-fast: false` on the sweep matrix so one repository's failure does not cancel others.
- Do not hard-code target repository names — the list must come from the GitHub App
  installation so newly onboarded repositories are automatically covered.
- Do not commit secrets, tokens, or private keys. `GH_APP_PEM` is an Actions secret managed by
  `platform-workloads`, not repository content. `COPILOT_AGENT_PAT` is a fine-grained personal
  access token set directly on this repository (never via `platform-workloads`, which must never
  manage credentials); it exists solely so `delegate-failed-checks` can post `@copilot` mentions
  that Copilot's coding agent will actually act on (mentions from the GitHub App/bot identity are
  ignored).
