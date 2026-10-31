# Managed repository standards

`repository-standards.yml` strictly validates the trusted `REPOSITORY_STANDARDS_CATALOG` JSON
variable stored on `platform-devex`, then intersects its keys with active repositories installed
for the shared GitHub App. Uncatalogued installation repositories are never processed, and a
manually selected repository must be both declared and installed. Missing, malformed, oversized
or invalid catalogs fail discovery as incomplete instead of becoming an empty target list.

The workflow uses repository API metadata and blobs only; target repositories are never checked
out and target code is never executed. The GitHub App installation needs Contents and Pull
requests read/write, but no Variables permission. `platform-devex` must provide `GH_APP_ID`,
`GH_APP_INSTALLATION_ID` and `GH_APP_PEM`. The discovery job uses the pinned token action only
to list installed repositories. Each reconcile job creates a short-lived RS256 App JWT in
trusted Node code, validates the App through `/app`, and requests a fresh installation token
scoped to exactly one matrix repository with exact read-only or write Contents/Pull requests
permissions. JWTs, private keys and tokens are never logged; the installation token is masked
before being written to the step output.

## Contract

The catalog is an exact JSON object mapping repository names to contracts:

```json
{
  "platform-status-web": {
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
      },
      "editorconfig": {
        "version": "dotnet-editorconfig-v1",
        "profiles": ["curated-low-noise", "actionable-only"]
      },
      "sonar": {
        "version": "sonar-policy-v1",
        "profiles": ["actionable-only", "common-vendor-assets"],
        "exclusions": [
          {
            "pattern": "Web/wwwroot/less/**",
            "reason": "The reviewed path contains third-party source assets retained for the application build."
          }
        ]
      },
      "eslint": {
        "version": "eslint-ignore-v1",
        "profiles": ["common-vendor-assets"]
      }
    }
  }
}
```

The catalog is bounded to 48 KiB and 256 entries. Every key must be a valid repository name and
every value must pass the existing strict `repository-standards-v1` contract and policy
validation. `managedFiles` has exact `checkov`, `editorconfig`, `sonar` and `eslint` keys and may be `{}` to
declare no managed files. Target paths and file types are controller-owned: repositories
cannot select a path or generator. Unknown contract or policy versions, unknown or duplicate
profiles, extra keys, malformed exceptions and unsafe canonical policy paths fail closed.

The canonical `checkov-v1` policy is `standards/checkov/v1.json`. Profiles contribute ordered,
deduplicated `skip-check` entries. Repository-specific exceptions may use only the separately
approved `CKV_OPENAPI_21` and `CKV_SECRET_6` rules, require a trimmed reason of 10–600 Unicode
grapheme clusters (matching Terraform string-length semantics), and cannot duplicate a selected
profile rule. Reasons reject control characters, Unicode line separators, unpaired UTF-16
surrogates and the noncharacters U+FFFE/U+FFFF so their emitted YAML comments remain single-line
and valid; normal Unicode, including supplementary emoji, is supported. Exceptions render in
canonical policy order after profile rules. Generated `.checkov.yml` files include
ownership/provenance, `soft-fail: false` and `compact: true`.

Two narrower profiles preserve resource-local exemptions without suppressing their controls
repository-wide. `cost-optimised-resource-scoped` retains the ordered `cost-optimised` rules
except `CKV_AZURE_225`; `public-endpoints-resource-scoped` retains `public-endpoints` except
`CKV_AZURE_109` (the Key Vault firewall check). The original profiles are unchanged. Select a scoped variant instead of its
original, never alongside it, through the reviewed platform-workloads catalog. The excluded
global suppression must be justified only on the exceptional Terraform resource: Sitewatch's
FC1 plan or Baremetal's workload secret vaults. Other plans and management/runtime vaults
remain checked. These controls are not added to the repository-global exception allowlist.

The canonical `dotnet-editorconfig-v1` policy is `standards/editorconfig/v1.json`.
`curated-low-noise` suppresses the first reviewed high-volume documentation, code-style,
ConfigureAwait and logging micro-optimisation diagnostics. `actionable-only` extends that
baseline across the remaining documentation, naming, globalization, modernisation,
micro-performance and style diagnostics observed in the estate. It deliberately retains
compiler and nullability failures, resource lifetime, exception and logging correctness,
ASP.NET correctness and xUnit lifecycle diagnostics. The duplicate compiler `CA2016`
cancellation diagnostic is suppressed while Sonar's `S8949` cancellation rule remains visible.
Every suppression has a canonical reason and is intended for staged re-enablement after the
actionable backlog is controlled.

The repository root `.editorconfig` is created when absent. Otherwise the controller appends or
replaces only the exact section between its `BEGIN` and `END` markers, preserving all
repository-owned content. Existing nested `.editorconfig` files are also updated only when they
already contain a managed marker or explicitly set one of the managed diagnostics; generated-code
only nested configurations remain untouched. Missing, duplicated or unbalanced markers fail
closed rather than replacing ambiguous content.

The canonical `sonar-policy-v1` policy is `standards/sonar/v1.json` and renders the whole
`.sonarcloud.json` file. Its `actionable-only` profile suppresses reviewed maintainability,
style, test-heuristic and micro-performance rules. Accessibility heuristics are temporarily
staged out and explicitly documented for progressive re-enablement. Security, vulnerability,
reliability, cancellation, nullability, unsafe-code, CSRF, regular-expression backtracking,
workflow-security and infrastructure rules are not suppressed. `common-vendor-assets` excludes
only package, vendor, `wwwroot/lib` and minified distribution paths.

Repository-specific Sonar exclusions remain workload declarations. Each exclusion requires a
single safe relative glob and a reviewed 10–240 grapheme reason; commas, whitespace,
backslashes, traversal and absolute paths are rejected so the generated file cannot become a
scanner-argument injection surface. The scanner workflow separately validates this generated
format before translating it into Sonar properties.

The canonical `eslint-ignore-v1` policy is `standards/eslint/v1.json` and renders the whole
`.eslintignore` file. It excludes the same high-confidence JavaScript dependency and
distribution paths while leaving first-party DOM and injection findings visible. Both managed
whole-file formats include deterministic provenance and profile selection.

## Pull-request reconciliation

Each matrix contract is immutable trusted workflow input from the validated catalog; reconcile
does not call the target Actions Variables API and does not re-read the contract. A declared
`{ "managedFiles": {} }` is an explicit skip. Drift is proposed only on
`automation/repository-standards` through an App-owned pull request. The managed target is fully
replaced for whole-file policies; marked editorconfig sections preserve content outside their
markers. Before every write, the controller rechecks repository identity,
default branch and source revision, branch identity, pull-request ownership and current head. It
refuses human branches or pull requests, never writes a target default branch, and never merges
or enables auto-merge.

An owned proposal is considered content-identical only when GitHub's compare response proves its
merge base is the reviewed current default revision and it is not behind. If the deterministic
App-owned branch is behind or has diverged, the controller returns
`stale-pr-needs-branch-update`, performs no branch, commit or pull-request writes, and makes the
repository job incomplete. The existing stale-branch updater or a human must update/reconcile the
branch before managed-file reconciliation continues. Missing or inconsistent ancestry evidence
also fails closed. The controller never force-updates refs or resets human or App-owned branches.

Scheduled runs are report-only unless the `platform-devex` repository variable
`REPOSITORY_STANDARDS_ENABLED` is byte-for-byte `true`. Trusted Node code computes this mode;
`TRUE`, `True`, surrounding whitespace and other values remain dry runs. Only exact enablement
causes a schedule to request Contents and Pull requests write permissions and emit
`dry-run=false`. Manual runs default to report-only and request writes only when the dispatch
`dry_run` input is exactly false:

```pwsh
gh workflow run repository-standards.yml -f repository=platform-status-web -f dry_run=true
gh workflow run repository-standards.yml -f repository=platform-status-web -f dry_run=false
```

This documents the controller contract and capability. It does not claim that scheduled writes
are enabled or that rollout to any target repository has occurred.
