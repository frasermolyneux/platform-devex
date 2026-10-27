# Managed repository standards

`repository-standards.yml` discovers active repositories installed for the shared GitHub App and
reads each target repository's `REPOSITORY_STANDARDS` Actions variable. It uses repository API
metadata and blobs only; target repositories are never checked out and target code is never
executed.

## Contract

The variable is strict JSON with this shape:

```json
{
  "version": "repository-standards-v1",
  "managedFiles": {
    "checkov": {
      "version": "checkov-v1",
      "profiles": ["base", "cost-optimised"],
      "exceptions": [
        {
          "rule": "CKV_OPENAPI_21",
          "reason": "The generated OpenAPI document cannot express this reviewed constraint."
        }
      ]
    }
  }
}
```

`managedFiles` has exact keys. It may be `{}` to opt into no managed files. The Checkov target
path and file type are controller-owned: repositories cannot select a path or generator.
Unknown contract or policy versions, unknown or duplicate profiles, extra keys, malformed
exceptions and unsafe canonical policy paths fail closed.

The canonical `checkov-v1` policy is `standards/checkov/v1.json`. Profiles contribute ordered,
deduplicated `skip-check` entries. Repository-specific exceptions may use only the separately
approved `CKV_OPENAPI_21` and `CKV_SECRET_6` rules, require a trimmed reason of 10–600 characters,
and cannot duplicate a selected profile rule. Exceptions render in canonical policy order after
profile rules. Generated `.checkov.yml` files include ownership/provenance, `soft-fail: false`
and `compact: true`.

## Pull-request reconciliation

Missing variables and `{ "managedFiles": {} }` are explicit skips. Drift is proposed only on
`automation/repository-standards` through an App-owned pull request. The managed target is fully
replaced in that proposal. Before every write, the controller rechecks repository identity,
default branch and source revision, variable content, branch identity, pull-request ownership and
current head. It refuses human branches or pull requests, never writes a target default branch,
and never merges or enables auto-merge.

Scheduled runs are report-only unless the `platform-devex` repository variable
`REPOSITORY_STANDARDS_ENABLED` is exactly `true`. Only then does a schedule request target
Contents and Pull requests write permissions and set `DRY_RUN=false`. Manual runs default to
report-only and may explicitly request writes:

```pwsh
gh workflow run repository-standards.yml -f repository=platform-status-web -f dry_run=true
gh workflow run repository-standards.yml -f repository=platform-status-web -f dry_run=false
```

This documents the controller contract and capability. It does not claim that scheduled writes
are enabled or that rollout to any target repository has occurred.
