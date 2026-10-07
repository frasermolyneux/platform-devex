# Estate analysis alignment plan

**Status:** execution in progress; default-branch rollout and acceptance are not complete.
**Scope snapshot:** 2026-10-04.
**Completion goal:** every applicable repository managed by `platform-workloads` uses the
same supported analysis contract, with current and visible results, updated documentation,
and no remaining migration adapters or obsolete analysis configuration.

This is one estate-wide migration, not a pilot or an opt-in experiment. Dependency ordering
and bounded deployment concurrency do not reduce the final repository scope.

### Verified shared-backend milestone

The selected-local backend is released, not the full estate implementation.
`frasermolyneux/actions#44` normally merged at
`2e388b178cf570c33177a0a875cd65ecd5ee2001` after passing exact-head checks and the
complete Copilot review, including previously-missed findings. Published immutable
packages are `repository-analysis/v1.0.0`, `repository-analysis-local/v1.1.0`,
`repository-analysis-sarif/v1.0.1` and `repository-analysis-state/v1.0.1`.

The [merged-head public execution](https://github.com/frasermolyneux/actions/actions/runs/37292665701)
completed all four selected local tools and their actual GitHub native processing.
All six pinned analyzers also passed genuine hosted fixtures. A real private
different-repository caller successfully used the immutable released reusable workflow:
all five selected tools, positive source coverage, foreign-definition/current-source/run
binding and the returned private aggregate passed. Native publishing was genuinely skipped;
the separate live-private denial produced the exact expected policy error. Detailed private
reports remain in their origin, not this public plan. The temporary acceptance draft and
branch were retired **without merge**, leaving its default branch unchanged.

This is backend acceptance, not a production pilot or partial estate adoption.
Every result explicitly retains `fullProfileEvidence: false`. Production CodeQL integration,
estate-wide Sonar provider/coverage import, authenticated freshness reuse, catalog-governed caller activation,
publication guards, all applicable default callers, consumption and retirement remain
outstanding. No App dependency-merge identity or Sonar Automatic Analysis cutover has occurred.

The owner approved a temporary **lint-only** compatibility adapter for released
actionlint 1.7.12, which cannot parse GitHub's commit-bound `$/` references. It preserves
the checksum-pinned released linter, normal rules, diagnostics and failures; only supported
literal metadata references are translated in an isolated copy. It is not a runtime or
legacy-caller migration fallback. The shared Actions linting documentation owns its removal
condition: adopt a checksum-pinned released parser with native support and equivalent
positive/negative/hosted acceptance, then remove the adapter and tests.
This adapter adds maintained Python to `actions`; its final profile must therefore include
Python, Bandit and public CodeQL Python, without rewriting the original before-state ledger.

### Verified native-analysis and prerequisite progress

The [merged-main six-family CodeQL execution](https://github.com/frasermolyneux/actions/actions/runs/37354246115)
completed actual Actions, JavaScript, Python, SDK .NET, Windows .NET Framework and C++
extraction and queries. Maintained public source passed independent native processing;
compiled fixtures did not publish source databases or native findings. Archived source is
bound to the originating checkout, including a shared archive root. Raw SARIF result counts
include diagnostics and are not native security-alert counts. This remains integration
acceptance, not a released production CodeQL engine or a complete repository profile.
Its actual push source is `c4dcaf4142a2e56a5c50af52c7c9eb8c441ebfab`, the normally
merged `frasermolyneux/actions#46` source. All nine extraction/native proofs were
independently checked against the actual run and native analyses. Maintained Actions,
JavaScript and Python extraction covers 18, 98 and four files respectively; SDK,
Framework and C++ fixtures cover two, one and two. These are archive counts, not
evaluated-line coverage. The Actions and Python native analyses have zero findings;
JavaScript has two visible incomplete-sanitization findings in the unchanged Terraform
comment formatter. The final PR execution had zero native findings under its PR identity;
that is not a zero-findings claim for the default branch. Earlier candidate evidence
is retained under its own source/run identity, not relabeled.

`frasermolyneux/actions#46` normally merged after passing exact-head checks, 86 coupled
contracts and a complete current-head Copilot review with no outstanding findings.
The [actual release](https://github.com/frasermolyneux/actions/actions/runs/37354246009)
published immutable `repository-analysis-sonar/v1.0.0`,
`repository-analysis-context/v1.0.3`, `repository-analysis-local/v1.1.1`,
`repository-analysis-sarif/v1.0.2`, `repository-analysis-state/v1.0.2`,
`repository-analysis/v1.0.1` and `dotnet-test/v1.1.1`. Their release source is the
actual merged commit above; prior private acceptance is not acceptance of these new tags.

The first real different-repository SDK Sonar component adoption,
`frasermolyneux/dotnet-caching#19`, normally merged at
`ef0f830972195b39816249d1f902b4ead632f4dd` after actual exact-head checks, complete
review and preservation of its required native CodeQL producer.
The original immutable admission passed and the genuine protected `quality / Code Quality`
context was confirmed, but its first [preparation](https://github.com/frasermolyneux/dotnet-caching/actions/runs/37354836665)
failed with Node exit 13 before scanning or coverage collection. A fresh-process
regression reproduced a circular ESM evaluation wait: the Sonar entrypoint awaited
its main function while that function imported a build validator that imports Sonar.
`frasermolyneux/actions#47` normally merged the isolated root-cause repair at
`37c6a8a3461d7cfe61907b4ef450a248578a9009` after all checks, complete exact-head
review and 54 focused coupled contracts on both hosted OS families, including direct
prepare/authorize/verify subprocess regressions. Its
[actual release](https://github.com/frasermolyneux/actions/actions/runs/37356225728)
published `repository-analysis-sonar/v1.0.1` at that exact merged source. The foreign
caller uses this real repaired tag. The
[repaired PR run](https://github.com/frasermolyneux/dotnet-caching/actions/runs/37356405371)
completed actual scanner preparation, native installation, build, 94 passing unit
tests, coverage collection, scanner end and independently bound task verification.
Its real coverage report contains 1,702 selected lines and 1,247 covered lines; PR
coverage remains **collected**, not default-branch import evidence. That run and its
review belong to logical head `1f58c5a3c1cbdea6965c97cb10f01ea28fe2d5d4`, not a later
adoption head. That review identified the removed original CodeQL producer, which was
restored in a separate CodeQL-only call at the reviewed immutable shared source,
with original SDK/build/test selections and no Sonar credential or duplicate Sonar task.

The [final adoption-head run](https://github.com/frasermolyneux/dotnet-caching/actions/runs/37357618375)
uses actual PR-merge source `c7c0a8287012fc05424f5290f4c37ec69278f562` containing
logical head `6b2069711a7b67f1497f5e87d516ff4299df7596`. Sonar task evidence and native
CodeQL analysis `1895820171` independently match that source; CodeQL 2.27.1 executed
52 rules with zero findings. All applicable checks passed, the complete exact-head
review had no findings, and both concrete review threads were resolved before normal
merge. No scan requirement was weakened to adopt the component.

The [actual merged-default push](https://github.com/frasermolyneux/dotnet-caching/actions/runs/37358286308)
completed the new Sonar producer and existing native CodeQL at the exact merged source.
Sonar analysis `2b9b26b8-0f08-40a0-8ff7-6f49b5c2e691` has verified **imported**
coverage: 745 provider-measured lines, 517 covered. The bound native report retains
1,702 selected lines, 1,247 covered and 94 passing executed tests; collection and
provider populations are reported separately, not asserted equal. Historical
provider measures, analysis revision/date and task are tied to that exact default source.
Default CodeQL analysis `1895856097` also matches the merged source and has zero
findings across 52 rules.

The `actions` producer's actual scanner installation/build fixtures and
source/origin/coverage contracts passed under their own identity. The separate foreign
PR/default task and positive default import above are genuine, not inferred from
installation or fixture builds. This accepts the SDK Sonar component, **not the full
repository profile or 46-repository rollout**; the Sonar component proof retains
`fullProfileEvidence: false`. The preserved CodeQL-only caller must remain active
until the production native engine actually replaces it with verified current-source
results, then be retired before estate closeout.
The owner explicitly accepted the disclosed same-runner Sonar token-capture risk for
verified first-party source; the policy below records that bounded exception, not isolation.

`frasermolyneux/platform-workloads#218` normally merged at
`e39df01a65725f9aaf9a667ae07705e3ba1bb8c6`. Its reviewed production plan adds exactly the
two existing-broker Sonar secrets for the policy-managed Actions repository, with no Azure
changes, new credential issuance or repository lifecycle import.
[Production attempt 2](https://github.com/frasermolyneux/platform-workloads/actions/runs/37323643138/attempts/2)
applied exactly two additions, zero changes and zero destroys; both Actions and Dependabot
`SONAR_TOKEN` metadata are verified without reading their values. The unchanged-head retry
recovered an initial transient GitHub OIDC refresh failure. This prerequisite does not
represent full catalog projection or Sonar cutover.

### Deployed and verified catalog policy

`frasermolyneux/platform-workloads#219` normally merged at
`7b0a3689866a2901cacc9ecb5bdd795029ddeb64` after complete exact-head Copilot review
with no findings and both full production plans showing exactly the intended effects.
All 50 scoped catalog rows now declare their source profile or maintained exemption.
The [actual production apply](https://github.com/frasermolyneux/platform-workloads/actions/runs/37344158008)
added exactly 142 non-secret analysis variables and one built-in metadata contract:
143 additions, zero changes, zero destruction.

Independent live reads verified all 142 variable values across all 46 applicable
repositories against the catalog, unchanged public/private visibility, and all seven
private publication boundaries. The four exemptions and excluded `xi-*` rows receive
no analysis-variable writes. Existing catalog fields and policy-only lifecycle ownership
are preserved; no Azure, ruleset, credential or provider-method change occurred.
Repository configuration and contributor/developer documentation are updated, and the
complete metadata-only native catalog contract runs in CI.

A documentation push exposed the existing PR workflow's cancellation of a running
Terraform plan, leaving its lease orphaned. The operator explicitly approved exact-ID
recovery after the owning job and other writers stopped. Native Terraform unlocked only
that lease; running PR plans now finish and release locks normally while retaining shared
production serialization. Subsequent exact-head plans and the actual apply succeeded.

This completes catalog configuration projection, **not scanner caller rollout**.
Shared production CodeQL integration, remaining Sonar build-family/estate acceptance, freshness reuse, publication guards,
all default callers, consumer migration and obsolete-provider retirement remain
outstanding. No Sonar Automatic Analysis or dependency-merge identity cutover is claimed.

## 1. Scope and authority

Use the catalog loaded by `platform-workloads/terraform/workloads.load.tf`, not a public
GitHub repository listing or `platform-devex`'s continuous-improvement opt-in list.

The original before-state catalog revision is
`33e31f3c9459403b561b64d2a44edd287260b850`. It contains 61 non-example definitions:
50 are in scope and 11 have the excluded `xi-` prefix.
The broker prerequisite and deployed policy advanced catalog main to
`7b0a3689866a2901cacc9ecb5bdd795029ddeb64` without changing this scope; retain the
original snapshot rather than relabeling it as the new revision.

Scope includes both lifecycle-managed repositories and cataloged, policy-managed repositories
with `github.manage_repository: false`. The latter are already centrally governed; including
their analysis policy does not authorize importing their repository lifecycle into Terraform.

Exclude:

- Every `xi-*` repository, including its local workflows, settings and documentation.
- Repositories absent from the catalog. `baremetal-workload-canary` is the currently observed
  uncatalogued repository and is excluded.
- Example definitions under `terraform/workloads/examples/`.

Archived, empty, documentation-only and upstream-fork repositories remain accounted for in
the scope ledger. Give them an evidence-backed applicability disposition; do not silently
drop them or unarchive/reconfigure an upstream fork merely to make a checklist green.

Regenerate scope from the current catalog before each write batch and at final closeout.
New in-scope catalog entries must be included before completion. Apply exclusions before
minting target tokens or performing any write.

The 2026-10-06 refresh uses current catalog commit
`46ccd5e49dc9059bc0d51ac0728d629880e2afa9`: the same 61 non-example definitions,
11 `xi-*` exclusions and 50 dispositions (46 applicable, four maintained exemptions).
The analysis projection was actually applied at
`7b0a3689866a2901cacc9ecb5bdd795029ddeb64`; the subsequent catalog delta is unrelated
`portal-environments` role admission, not an analysis scope/profile change. Preserve it.
The original revision above remains the captured before-state, not current write authority.

### Verified component progress

These are preparation/acceptance milestones, not full-profile or estate completion.

| Component | Actual boundary |
| --- | --- |
| Collected coverage state | `repository-analysis-state/v1.1.0` released after frasermolyneux/actions#49; genuine collected reports/tests are preserved without inventing provider import |
| Selected-native engine | frasermolyneux/actions#48 released `repository-analysis-codeql/v1.0.0`; later executable-closure/source-authority/provider patches are published through `v1.0.4`, not a full orchestrator |
| Native SDK caller | frasermolyneux/dotnet-caching#20 merged at `7f938a740a7cf12cec47c6280f176099a4741808`; actual PR run `37546285453` and default run `37547225641` independently verify immutable definition/source, raw artifact receipts and completed Actions/C# processing |
| Shared source authority | frasermolyneux/actions#51 released context `v1.1.0` at `3490bc4b344e919932bf9d673e2012bf354f67a1`; actual private metadata can be admitted without faking public status, while Sonar/CodeQL still independently require live-public eligibility |
| Sonar provider facts | frasermolyneux/actions#50 released task-bound metadata; actual scope/settlement repairs through frasermolyneux/actions#52 and frasermolyneux/actions#53 released Sonar `v1.1.3` at `8a48419c4ac7629dc227af900b8a3d183de13656`, genuinely accepted on foreign SDK PR/default after frasermolyneux/dotnet-caching#21 |

The accepted native SDK default has seven workflow files/17 rules and 33 C# files/52 rules,
both with zero findings. This does not erase the shared Actions repository's two legitimate
default JavaScript findings or imply identical native/provider source or coverage populations.
The original SDK producer was retired through frasermolyneux/dotnet-caching#22 after
fresh protected-check/review gates and independently authenticated actual current/default
processing. Post-retirement default run `37574765205` at
`87d94780aa42ecedb9a6cfcc05f7f8bc2e8f53c5` retains both capability/rule counts and zero
findings. No old analysis history or protection was deleted to permit the transition.

After the real Sonar task and all 94 tests succeeded but its PR metadata returned no files
(versus 26 on the default branch), the owner approved explicit scope separation: branch
source-capability evidence remains mandatory; PR task/finding evidence is incremental with
an explicit unavailable whole-branch source-coverage field. Preserve quality gates, complete
paging, source/task/producer binding, file ownership, before/after snapshots and explicit
provider errors. Never manufacture whole-source coverage or use PR data for default freshness.
The reviewed release is now genuinely accepted. A second real execution exposed PR-list
metadata lag immediately after successful task completion. The bounded settlement repair
waits only for otherwise valid same-PR metadata, within the same absolute two-minute facts
deadline, rechecking the successful own receipt/latest project task and empty queue on every
wait. Malformed/foreign/failed/superseding/provider errors fail immediately; both settled
before/after snapshots must still be identical. No stale snapshot or deadline reset is accepted.

Actual final SDK PR run `37576761123` at merge source
`63cf486c9ee7b3299073b85a20357e6713c5d274` passed with the released Sonar definition,
authenticated raw ZIP/expanded file hashes, exact task/analysis/source and independently
rechecked public snapshot/file metadata/scoped findings. Its facts truthfully report null
whole-branch coverage and zero returned incremental files, not zero analyzed source; its
raw current-PR findings are zero. All 94 tests passed, with genuinely collected native
coverage of 1,702 total/1,247 covered lines, not claimed PR provider import.

Actual merged-default run `37577226988` at
`8dc9cca4a40b0ee405710fb53f8fc2f8c98db83f` independently verifies the same immutable
Sonar release/digest, raw receipts, actual task `AaEU37P8laAcVppxnQfA`, analysis
`1ea19a59-ad11-4db7-ae37-7e71f0743247`, positive metadata for 26 C# files and
13 actual unresolved backlog findings. Exact-analysis historical provider import is
745 total/517 covered lines, distinct from the native collection population. Unchanged
native Actions/C# processing also passed on that default source. This closes component
foreign/default acceptance, not full-profile, reuse or estate-wide caller acceptance.

Full-profile orchestration, authenticated unchanged-source/rule-currency reuse, publication
route guards, all 46 callers, consumption/reporting, and final obsolete-project/configuration
retirement remain incomplete. Library releases and local private-metadata contracts do not
prove actual private full-profile execution or installation of the planned estate workflows.

### Repository coverage ledger

The target families below are initial classifications from catalog and repository-tree
inspection, not a claim that build commands, feature entitlements or execution have already
been validated. Work package 0 resolves the exact capabilities for each row.

Active targets are under `frasermolyneux`. The archived `portal-bots` catalog entry redirects
to its existing canonical repository, `frasermolyneux-archive/portal-bots`; account for it as
an applicability exemption without transferring it, unarchiving it or writing settings.
Never silently follow an active target's ownership redirect and treat it as the original
repository.

| Repository | Target family / disposition |
| --- | --- |
| `.github` | Python automation and workflow security; preserve generated estate documentation |
| `.github-copilot` | TypeScript tooling and workflow security; migrate the instruction/template source too |
| `41-bovet-street` | Documentation/data applicability exemption; no executable source or workflows observed |
| `actions` | Mixed JavaScript/Python action/tooling source, workflow security and existing .NET fixtures |
| `ado-pipeline-templates` | Pipeline/template validation and workflow security; reassess blanket Sonar applicability |
| `api-client-abstractions` | SDK-style .NET |
| `baremetal-workload-template` | Private mixed template/tooling; preserve image publication and secret-sync behavior |
| `bishops-bees` | Private operations/scripts; preserve existing quality/dependency monitoring |
| `bishops-bees-staging` | Private operations/scripts; preserve existing quality/dependency monitoring |
| `bqba` | Private operations/scripts; preserve existing quality/dependency monitoring |
| `cod-demo-reader` | SDK-style .NET |
| `CoD4x_Server` | Existing external/upstream-shaped fork exemption; preserve upstream ownership |
| `craftpledge` | .NET application plus Terraform and frontend source, despite primary language HTML |
| `demo-manager` | Windows/.NET Framework build variant plus Terraform |
| `dm-electrical-services` | Private operations/scripts; preserve existing quality/dependency monitoring |
| `dotnet-caching` | SDK-style .NET |
| `geo-location` | .NET application, frontend source and Terraform |
| `invision-api-client` | SDK-style .NET |
| `molyneux-me` | Static-site/content plus Terraform; verify actual languages before retaining JS analysis |
| `observability-appinsights` | SDK-style .NET |
| `observability-opentelemetry` | SDK-style .NET |
| `platform-baremetal` | Private Python/operations tooling plus Terraform and existing Ansible validation |
| `platform-baremetal-ns512615` | Private operations/configuration and Python validation |
| `platform-connectivity` | Terraform |
| `platform-devex` | Node.js automation and workflow security; migrate scanner consumption/governance |
| `platform-hosting` | Terraform |
| `platform-landing-zones` | Terraform and PowerShell tooling |
| `platform-letsencrypt-iis` | PowerShell/tooling; do not assume Terraform solely from repository category |
| `platform-monitoring` | Terraform |
| `platform-notifications` | .NET application plus Terraform |
| `platform-registry` | Bicep/ARM and Terraform |
| `platform-sitewatch-func` | .NET application plus Terraform |
| `platform-status-web` | .NET application, frontend source and Terraform |
| `platform-workloads` | Terraform and catalog validation; preserve production provisioning ownership |
| `portal-bots` | Archived at `frasermolyneux-archive/portal-bots`; exemption, no ownership/settings changes |
| `portal-cod4x-plugin` | C/C++ build variant plus Terraform |
| `portal-core` | Terraform; no Sonar capability |
| `portal-environments` | Terraform; no Sonar capability |
| `portal-repository` | SDK-style .NET plus Terraform |
| `portal-repository-func` | .NET application plus Terraform |
| `portal-server-agent` | .NET application plus Terraform |
| `portal-server-events` | .NET application plus Terraform |
| `portal-servers-integration` | .NET application plus Terraform |
| `portal-sync` | .NET application plus Terraform |
| `portal-web` | .NET application, frontend source and Terraform; connect existing coverage |
| `status-pages` | Empty applicability exemption until executable content is added |
| `talkwithtiles` | .NET application, frontend source and Terraform |
| `travel-itinerary` | .NET application, frontend source and Terraform |
| `trip-side-kick` | .NET application, frontend source and Terraform |
| `twenty-one` | JavaScript static site plus Terraform; no declared tests or substantive build |

An exemption is a maintained target-state decision with a reason and a re-evaluation condition,
not a migration backlog item. An inaccessible repository, failed scan or unresolved feature
decision is a blocker, not an exemption.

## 2. Target operating model

| Owner | Target responsibility |
| --- | --- |
| `actions` | Versioned reusable scanner workflows/helpers, result schema, trusted metadata-only merge policy and publication-origin classification |
| `platform-workloads` | Repository profile selection, applicable feature/configuration projection and repository rulesets |
| Individual repositories | Thin analysis callers and declared, necessary build/test/source configuration |
| `.github-copilot` | Human/agent instructions, prompts, alignment/audit guidance and the ops clock |
| `platform-devex` | Catalog-scoped compliance/freshness reporting, supported on-demand scan requests and finding consumption |
| `.github` | Existing generated estate visibility, consuming the standard analysis state |

This is a personal-account estate. Use repository settings/rulesets and catalog-backed
governance, not organization-only required-workflow or security-configuration features.
Preserve existing personal-account ownership and repository visibility. Neither publication
of private repositories nor an organization/paid-plan migration is part of this implementation.

### Analysis contract

- Use `codequality.yml` as the repository entry point where analysis applies. Use distinct
  reusable-workflow filenames in `actions` so its own caller does not collide with an engine.
  Consolidate existing `code-quality.yml`/`quality.yml` analysis entry points after preserving
  any non-analysis responsibilities.
- Declare capabilities from maintained source, existing builds and supported features.
  Combine .NET, JS/TS, C/C++, Python, workflow and IaC capabilities for mixed repositories.
  Exclude generated/vendor/output trees and distinguish production source from test fixtures.
- Retain build-aware .NET/C++ analysis where appropriate, including Windows builds.
  Do not force unsupported languages into CodeQL or require a build for script/workflow analysis.
- Use Sonar CI analysis for substantive applicable source; disable conflicting automatic
  analysis. Terraform-only repositories must not carry Sonar jobs, requirements or credentials.
- Use CodeQL for supported source and GitHub Actions where available. Do not enable default
  and advanced CodeQL setup simultaneously.
- Configure MSDO tools explicitly by capability: appropriate IaC analysis for Terraform,
  Bicep/ARM and other present formats, and applicable script/code analysis. Verify coverage
  before removing overlapping analyzers. PowerShell/shell-specific checks must use maintained
  applicable tooling rather than being incorrectly represented as CodeQL support.
- Preserve existing dependency review, Dependabot/security alerts, secret protection and
  repository-specific validation. These are related controls, not interchangeable SAST results.
- Pin reusable workflows to immutable folder-scoped releases or reviewed commits, not `main`.
  Pin scanner/tool versions, include versions in cache keys and automate reviewed updates.
  Extend release automation to cover reusable workflows/helpers, not just composite `action.yml`.

### Lifecycle and provenance

- Run real PR validation on `opened`, `synchronize`, `reopened` and `ready_for_review`.
  Preserve the current non-draft policy and existing required validation behavior.
- Run default-branch analysis on push, including verified App-authenticated dependency merges.
- Provide a quality-only `workflow_dispatch` entry point for default-branch analysis.
  Accept an expected revision and a force option, not an arbitrary privileged PR checkout.
- Run a repository-owned daily freshness check. Rescan changed heads, changed analysis policy,
  missing results and due periodic analyses. Initially require a full unchanged-source rescan
  at least weekly. Freshness checks must consider every expected tool/category, not Sonar alone.
- Allocate daily checks through the ops clock and bounded concurrency. Place the currently
  opted-in improvement repositories' scheduled analyses before their intake window where
  feasible. Do not move deployment/destruction or Dependabot schedules as a side effect.
- Treat daily freshness as an operational target, not a guarantee from GitHub's scheduler.
  Missing/delayed/disabled schedules must be visible and recoverable through the standard
  dispatch interface.
- Separate PR/default-branch concurrency. Coalesce redundant requests without cancelling the
  only useful default-branch analysis; supersede old PR heads, not current validation.
- Freeze analysis source revisions. Record actual checkout SHA, logical PR head and target/base
  SHA separately when a merge-ref checkout is used. Never relabel old or different source as
  current merely to satisfy a freshness comparison.
- Check Sonar target-baseline freshness, safely request default-branch refresh when needed,
  and rerun affected current-head PR analysis after refresh. Await server-side completion;
  accepted uploads and timestamps alone are insufficient proof.
- A stale main result must not become a new required failing check or pause all improvement
  intake. Retain its historical status and refresh request. Genuine configured PR validation
  failures still follow the existing merge policy; unavailable analysis is never called clean.

### Coverage, visibility and gating

Use existing unit/integration/browser infrastructure. Wire supported coverage into the
analysis of the same revision, with stable report paths and explicit imports. Keep browser
and infrastructure-dependent validation where it already belongs. Analysis must not deploy,
apply Terraform, publish packages/images or require production cloud credentials.

Publish CodeQL and applicable MSDO results to GitHub Security when supported; publish Sonar
checks/decorations and project links. Also emit a versioned, bounded result artifact and job
summary containing profile/release, source revisions, run/event identity, expected tools,
tool versions, completion state, publication destination, result links and coverage provenance.
Do not include credentials or private source excerpts in estate/public summaries.

Represent completed zero findings, historical results, superseded runs, failed processing,
unsupported publication and not-applicable capabilities distinctly. Keep source freshness,
scanner/rule currency and finding severity separate.

Freeze check names/categories and intended enforcement before rollout. Prefer preserving
existing required contexts. If a rename is unavoidable, specify a safe Terraform-owned
transition before merging callers; any temporary bridge must propagate genuine validation,
not emit unconditional success, and must be removed before closeout.

Do not require a Sonar SARIF tool identity where only the Sonar PR check is published.
Bootstrap default-branch results before requiring a newly introduced tool. Preserve current
merge-gate strictness, the existing six-rule test-only INFO advisory policy, raw finding counts
and the improvement controller's stronger handoff checks. Do not introduce a second competing
advisory classifier in shared workflows, suppress analyzers or gate the whole historical backlog.

Resolve scanner execution and publication separately from live repository metadata and the
catalog profile. Do not trust a caller-supplied public/private flag or interpret an API
permission error as proof that a feature is not applicable.

For public repositories, use applicable CodeQL and GitHub SARIF publication, alongside the
profile's other analyzers. For the current private personal-account repositories, do not
execute CodeQL or attempt GitHub code-scanning uploads: select permitted locally executed
analyzers for their actual languages and retain results in that private repository's Actions
artifacts and job summaries. Preserve existing validation and make differences in coverage
and publication explicit; alternative tools are not asserted to be equivalent to CodeQL.
No private source or finding excerpts may appear in public estate summaries.

Sonar is a separate capability: use it only for an applicable, verified project whose
visibility and existing entitlement support the target repository. Do not publish private
source to a public Sonar project or infer private-project support from a non-empty token.
Terraform-only repositories remain Sonar-inapplicable. Never invoke a licensed scanner and
substitute artifact publication to bypass its execution license.

Re-evaluate capability selection when visibility, source or profile changes, including
freshness/cache identities and obsolete provider results. Unknown metadata, failed tools,
missing expected reports and publication failures are explicit incomplete states, not
successful zero-finding scans. New subscriptions, ownership or visibility changes still
require separate owner approval.

### First-party Sonar execution boundary

The owner chose verified first-party execution rather than isolated token-bearing publication.
Running build code without `SONAR_TOKEN` does not prevent that code from leaving a process or
replacing a scanner that later receives the token. This same-runner risk is explicitly
accepted only for live-verified public personal-owner source; do not describe it as isolation.

PR admission requires an open, non-draft, current-head, same-repository PR authored by the
verified owner or the exact approved Copilot/Dependabot identities. The authenticated current
triggering actor must be that owner or matching approved automation; `github-actions[bot]`
is trusted only when paired with a verified Dependabot author. An owner rerun can authorize
an approved automation origin, never an untrusted author. Deny forks, other contributors,
generic bots, identity mismatches and superseded heads before checkout and every prepared
token-bearing phase. Non-PR analysis requires the default branch or explicit owner dispatch.

This is not general App/bot publication trust, permission to publish private source or a
change to continuous-improvement PRs' human final-merge requirement.

### Merge identity and behavior preservation

Use the shared GitHub App for eligible automated dependency merges, with fresh target-scoped
tokens and the existing approved update-class/merge-method/check policy. Do not use the human
Copilot PAT for this purpose or authorize improvement, human, fork or unknown-bot PR auto-merges.

Keep privileged merge control metadata-only, using trusted definitions and pinned helpers.
Never check out or execute PR-provided code in that controller. If `pull_request_target` is
used for metadata control, it must not build the head. Do not pass App keys, merge tokens or
unrelated secrets into scanner/build jobs or use blanket secret inheritance.

Before changing merge authentication, put explicit guards on every newly reachable deployment,
Terraform, release/tag, image/package publication and downstream `workflow_run` path. Classify
the actual verified original run actor; a branch name, label, commit message or arbitrary bot actor
is not authorization. Unknown origin must hold privileged publication for human attention.

The approved human publication policy trusts the original authenticated human push actor
when their immutable identity has current repository write/maintain/admin permission.
A historical PR merger is not an additional human gate: legitimate tag releases and
authorized pushes of existing commits retain publication eligibility. This does not grant
new publication routes or change any existing branch, environment, check or release gates.
Bot publication exceptions retain exact PR/merge-actor binding. A human rerun never replaces
an original bot actor, and human final merge for improvement PRs remains required.
Do not infer the original push reference from today's tags/branches; downstream metadata
cannot prove that history. No OIDC permission or signed-original-event scheme is introduced.

One owner-approved existing-route exception preserves `molyneux-me`'s configured
Dependabot controller dispatch to `deploy-prd.yml`. Its existing controller explicitly
dispatches both quality and deployment after an eligible merge; `GITHUB_TOKEN` suppression
does not apply to `workflow_dispatch`. Removing that deployment would change configured
behavior, even though the inspected recent history does not establish a successful automated
deployment. This exception is a target-state requirement, not an implemented or verified route.

Authorize only the same existing controller-to-deployment edge, with independently verified
originating run/attempt, trusted reviewed controller definition, eligible same-repository
Dependabot PR, immutable author/merge identities, exact merged source and intended target
workflow. Retain its Terraform-plan waits, update eligibility, source/change detection,
development-to-production ordering, environments and existing deployment gates. A caller's
run ID, PR number, expected SHA or bot identity alone is not proof; missing or ambiguous
linkage must hold deployment for human attention. Do not give `github-actions[bot]` or the
shared App general publication permission, authorize another dependency publication route,
or use the human Copilot PAT. Newly reachable App-authenticated push routes remain denied,
and improvement PRs still require human final merge.

The preservation rule is: new App-authenticated automatic dependency merges receive ordinary
post-merge analysis/validation but do not gain production/development deployments, Terraform
applies or release publication currently suppressed by `GITHUB_TOKEN`. Existing human-merge,
manual, scheduled and explicitly approved existing dependency-dispatch behavior remains
unchanged. Enabling auto-merge is not evidence that an actual merge or its subsequent analysis
has occurred.

## 3. Dependency-ordered work packages

| Package | Main owner | Prerequisites | Required exit |
| --- | --- | --- | --- |
| 0. Scope and behavior baseline | `platform-devex`, `platform-workloads` | None | Complete ledger, capabilities and before-state evidence |
| 1. Contract and policy | `actions`, `platform-workloads`, `.github-copilot` | 0 | Schemas, profile/check/publication decisions and schedule contract fixed |
| 2. Shared implementation | `actions` | 1 | Tested immutable release with analysis and trusted metadata primitives |
| 3. Catalog projection and prerequisites | `platform-workloads` | 1, 2 | All scoped profiles/entitlements/credentials/settings ready without unrelated infrastructure changes |
| 4. Publication protection | Target repositories, `actions` | 0, 2 | All affected privileged routes guarded before merge identity changes |
| 5. Estate caller and merge rollout | All applicable targets | 2, 3, 4 | All callers and eligible merge controllers on the supported release |
| 6. Bootstrap, rulesets and DevEx consumption | Targets, `platform-workloads`, `platform-devex` | 5 | Actual current data, matching protections and profile-aware consumers |
| 7. Documentation and retirement | All owners | 6; documentation starts in 1 | No obsolete active approach, template or migration bridge |
| 8. Estate closeout | `platform-devex`, repository owner | 7 | Every scoped row verified or genuinely not applicable; no unresolved migration blockers |

### 0. Establish the complete baseline

Produce a machine-readable per-repository ledger from the catalog and authenticated GitHub
metadata. Include catalog mode, source/build capabilities, existing workflow refs/triggers,
required check/App identities, enabled scanner methods, project keys, feature entitlements,
schedule state, credential names only, active improvement batches and publication paths.

Capture existing behavior for human pushes/merges, automatic dependency merges, manual runs
and scheduled runs. Include NuGet/GitHub releases, demo/MCP/container images, secret-sync and
operations-specific workflows, not only Azure deployment.

Inspect excluded consumers' shared references only to establish dependency safety; do not
migrate those repositories. Code search alone is not proof of zero consumers. Resolve any
live excluded dependency before retiring or incompatibly changing a shared entry point.

Do not expand scope or permanently retain an adapter to hide such a conflict. A necessary
excluded-consumer pin/change needs separate owner authorization; otherwise the affected
retirement remains a stated completion blocker.

**Exit:** all 50 rows have a reviewed disposition and behavior baseline; access/feature/scope
questions are resolved rather than silently skipped.

### 1. Freeze the canonical contract

Define the analysis profile schema, supported tool combinations, default-branch/PR provenance,
result schema, check names, SARIF categories, eligibility/origin rules, force/expected-SHA
dispatch behavior, retry/concurrency bounds and applicable gating.

Select actual supported coverage formats and report paths for each build variant. Document
which tests supply coverage and where existing integration/browser tests remain.

The captured public Sonar recipes contain 22 existing reusable build callers and three
distinct variants; retain their exact SDK, source, project, formatting and CMake inputs.
`actions` needs an explicit JavaScript/Python CI scanner before its currently enabled
Automatic Analysis is disabled: its own `code-quality.yml` is MSDO/dependency review,
whereas `codequality.yml` is a shared library, not its own Sonar CI caller.
`demo-manager` retains Windows, .NET Framework 4.8, `nuget restore DemoManager.sln` and
the original Release/Any CPU MSBuild build; install the analysis runtime before the
scanner, without inventing tests or coverage. `twenty-one` retains Node 20.x and its
`src` source/install recipe, but analysis must not invoke Static Web Apps deployment or
pretend its echo-only build is application validation.

For SDK-style .NET tests, retain the original solution and unit-test filter and select
the pinned native `dotnet-coverage` collector where needed without changing test-project
dependencies. Sonar's [official dotnet-coverage examples](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/dotnet-test-coverage#dotnetcoverage)
document native Cobertura import through `sonar.cs.cobertura.reportsPaths`;
collection alone still is not completed Sonar import evidence. Travel Itinerary's tests
outside `src` are included by its solution. Preserve Portal Web's existing runsettings
and separate integration/browser behavior. Missing tests or unsupported coverage need
an explicit disposition, not fabricated zero coverage or successful test execution.

Update the ops-clock design for daily checks and weekly full rescans, removing the obsolete
Monday-only/Sunday-time coupling for analysis without rescheduling unrelated automation.
Define governance re-evaluation when a repository gains code, workflows or feature entitlement.

**Exit:** one documented contract and a validated profile for every applicable row; no
unapproved paid dependency or unresolved publication/merge behavior decision.

### 2. Build and release the shared implementation

Implement reusable quality/security/reporting and minimal trusted metadata helpers in
`actions`. Preserve useful existing primitives rather than introducing unnecessary layers,
but separate analysis from packaging/deployment side effects.

Add focused automated coverage for profile validation, applicability, immutable revisions,
freshness thresholds, tool/category completeness, async processing, private publication,
malformed reports, duplicate dispatches, concurrency, safe retries and credential boundaries,
including the explicitly accepted first-party Sonar same-runner exception above.
Cover trusted/untrusted merge-origin combinations and every privileged publication decision.

Exercise all build families through integration fixtures/consumer commands: SDK .NET,
Windows/.NET Framework, JS/TS, C/C++, scripting, IaC and mixed/template cases. Verify actual
coverage import and non-empty source analysis, not merely a successful job.

Extend release automation, publish an immutable analysis release, and record its exact
workflow/helper/tool revisions. Keep temporary old entry points only for the bounded cutover.

**Exit:** released implementation is available to every scoped caller; no App merge change
has yet been enabled without publication guards.

### 3. Project catalog policy and prerequisites

Add explicit analysis/profile policy to the central catalog and implement its validated
projection in `platform-workloads`. Use the existing repository-policy model rather than a
second manually maintained repository list.

Handle lifecycle-managed and policy-only entries correctly. Repository-name resolution for
approved variables/brokering must not assume a `github_repository.workload` instance exists
for a policy-only entry, and must not import/change its lifecycle.

Reuse the existing App/Sonar broker mechanisms where authorized; request only required token
permissions. Do not create new PATs/client secrets or put credentials into configuration.
Keep `COPILOT_AGENT_PAT` directly managed and limited to its existing entitled-human uses.

Validate Terraform/configuration, review the state-backed plan and apply only the intended
GitHub policy/projection changes. Require no unintended Azure identities, RBAC, environments,
state-address changes or cost-bearing services.

Prepare ruleset transitions here, but do not require nonexistent contexts/tools before their
bootstrap evidence. Maintain managed settings through Terraform, not competing CLI writes.

**Exit:** all profiles and required capabilities are provisioned or explicitly applicable
exemptions; prerequisites do not rely on future manual cleanup.

### 4. Protect all privileged publication routes

Apply the verified-origin guards across every affected target before updating its merge
identity. Follow the complete job graph, including publication triggered by another workflow.

Retain current change detection, deployment sequencing, schedules, environment protections,
release-version decisions and operations-specific responsibilities. Do not simplify away
those responsibilities while consolidating an analysis filename.

Test the event/origin matrix against each repository's declared publication policy. Preserve
human/manual/scheduled positive cases and demonstrate that automatic dependency merges cannot
newly apply/deploy/publish. Missing origin must remain explicit, not assumed to be trusted.
Separately verify the approved existing `molyneux-me` dispatch edge with genuine eligible
dependency-merge/controller/source evidence; its configured existence is not positive
execution evidence, and must not become a blanket dependency-publication exception.

**Exit:** all affected routes are protected; existing behavior is evidenced before App-based
automatic merges can reach them.

### 5. Migrate every applicable caller and merge controller

Create reviewed standards PRs across the full estate. Use bounded execution concurrency for
reliability, not selective adoption. These are CI-sensitive human-reviewed migration changes,
not ordinary small autonomous improvement batches.

Replace inline/duplicate scanner implementations and floating scanner workflow refs with
the canonical profile-based release. Cover private `quality.yml`/`validate.yml` variants,
the `actions` naming collision, static sites, templates and mixed-language repositories.

Migrate eligible Dependabot merge authentication to the App only after package 4 passes.
Preserve update eligibility, squash policy, required checks and major-update handling.
Do not enable auto-merge where it was absent as a side effect of the SAST migration.

Keep controls that are not analysis duplication, including Ansible/configuration validation,
dependency monitoring and secret/image operations. Consolidate their reporting/entry points
only when their original responsibilities remain intact.

**Exit:** all applicable repositories' default branches use the release, with no forgotten
private/tooling/template caller. Open PRs or unopened migration PRs do not count as rollout.

### 6. Bootstrap data, finish protection transitions and update DevEx

Dispatch current default-branch analysis for every applicable repository. Verify actual
completed provider analysis, expected language/category coverage, supported publication,
coverage import and exact source provenance. Fix implementation/configuration failures;
real findings are valid results, not an excuse to disable a scanner.

Apply the reviewed Terraform ruleset transitions only after new results/contexts exist.
Remove obsolete Sonar requirements from IaC-only and otherwise inapplicable profiles.
Verify effective GitHub merge behavior rather than relying only on catalog JSON.

Make `platform-devex` read the same catalog profiles and supported results. Replace the
global all-repositories scanner assumption and timestamp-only freshness checks. Stale Sonar
must not suppress fresh findings from other sources; historical leads require current-source
confirmation. Failed/inaccessible sources remain visible, never zeroed.

Preserve one active improvement batch, explicit improvement opt-in, exact advisory policy,
testing/change limits, bounded repairs/reviews, third-party restrictions and human final merge.
Do not automatically opt the 50 repositories into code-changing improvement.

Carry in-flight batches through the source migration without resetting budgets or silently
closing unresolved targets. Coordinate profile/source retirement with their verification.
Post-merge target closure needs a completed default-branch analysis containing the merge
and evidence that the selected IDs are resolved, not merely a newer timestamp.

Add catalog-scoped drift/freshness governance. It may raise human-reviewed maintenance PRs
and issue bounded standard scan requests, but must not execute target builds centrally or
write Terraform-owned settings. Missing schedules, report schema drift and unavailable
capabilities must be surfaced explicitly.

**Exit:** all sources are current/visible or legitimately not applicable; consumers use the
new contract without bypassing existing improvement protections.

### 7. Update all guidance and remove the old approach

Documentation and generator updates are part of each implementation PR, not a deferred
follow-up. Complete the cross-repository sweep below and verify generated/served output.

| Surface | Required update |
| --- | --- |
| `actions` | README/badges, AGENTS/Copilot guidance, codequality and versioning docs, scanner/coverage/input/result contracts and tested examples |
| `platform-workloads` | README/AGENTS, architecture, workload schema, developer/prerequisite and onboarding/decommissioning docs, ruleset/profile ownership |
| `.github-copilot` | Workflow/security/automerge/scheduling instructions; relevant deployment/release instructions; codequality/dependency/security prompts; align/audit/create/failure agents; ops clock and shared action guidance |
| `.github-copilot` distribution | Rebuild and verify catalog/MCP/packaged instruction distribution so clients cannot keep generating the retired pattern |
| `platform-devex` | README/AGENTS/Copilot guidance, source/profile configuration, freshness/dispatch/reporting operations and in-flight batch migration guidance |
| Every applicable target | README/status badges, local AGENTS/instructions, contribution/security/test/coverage/manual-run documentation and copied templates |
| Template repositories | Analysis and merge examples, validation/generation behavior, image publication documentation and supported instantiated-repository behavior |
| `.github` estate visibility | Update the generator for profile/freshness/result links and regenerate `docs/estate/`; do not edit generated pages by hand |
| New repository onboarding | One profile selection and released caller; correct rulesets, features, schedules and documentation generated from the same standard |

Remove unused scanner workflow files, inline copies, temporary check bridges, compatibility
branches, deprecated inputs/env variables, obsolete caches and authentication fallbacks.
Remove unused merge PAT secrets/variables and stale token screenshots/instructions after
verifying there are no remaining consumers; do not remove the still-required Copilot PAT.

Remove obsolete Sonar configuration/credentials and retire/delete no-longer-applicable
projects only after active-batch/reference checks and the necessary audit record. Do not
leave a stale project presented as a supported live scanner. Keep historical finding
evidence where needed; do not falsely mark unresolved application findings fixed.

Search active code, templates, generated/served instructions and documentation for the old
patterns. Expected current references are explicitly allowlisted; no broad textual deletion
may remove unrelated operational behavior or excluded consumers' dependencies.

Immutable historical commits, release tags and intentional documented capability exemptions
are not migration debt. Obsolete active implementations, permanent transition adapters,
contradictory templates and "clean up later" tasks are debt and block closeout.

**Exit:** all documentation/distribution is aligned and every retirement is complete and
consumer-safe, including the excluded-repository boundary.

### 8. Verify the whole estate and close the migration

Produce a final per-repository acceptance report with catalog/release/profile revisions,
real run/provider links, source SHAs, effective checks, coverage status, publication destination,
event/behavior evidence, documentation changes and retirement results. Keep private details
private; publish only suitable aggregate estate information.

Do not call the migration complete while a scoped repository is waiting for a merge,
credential/feature decision, runtime verification or legacy removal. Evidence collection may
span a normal scheduled/dependency-update cycle; that is not a pilot.

## 4. Acceptance and closeout checks

| Check | Required evidence |
| --- | --- |
| Scope completeness | Every current non-example, non-`xi-*` catalog row is migrated or has a verified applicability exemption; no unmanaged writes |
| Shared contract | Actual default-branch callers use the approved immutable release and validated profile; no competing default/advanced or auto/CI analysis |
| Default-branch data | Completed results match the current tip and every applicable tool/category; superseded/incomplete uploads do not qualify |
| PR lifecycle | Current-head validation runs after ready-for-review and updates; baseline refresh/reanalysis does not invent new findings or cancel useful validation |
| Coverage | Real imported reports match analyzed source; unsupported/absent coverage is explained, not faked as zero or success |
| Private features | Entitlements and permitted analyzer/publication alternatives are verified; no unapproved subscription or license bypass |
| Normal automated merge | An eligible real dependency merge uses the intended App identity, obeys protections and produces the expected default-branch analysis |
| Publication preservation | No newly reachable deploy/apply/tag/package/image route on automatic dependency merges; existing human/manual/scheduled routes and the narrowly approved dependency-dispatch edge retain intended behavior with verified origin/source |
| Untrusted contribution | Fork/human/unknown-bot cases cannot obtain merge credentials, privileged checkout, automatic merge or DevEx approval/delegation through the new standard |
| Schedule and dispatch | Repository-owned scheduled checks run, unchanged/due decisions meet the daily/weekly thresholds, and bounded deduplicated dispatch works at the intended revision |
| Repository independence | Ordinary PR/main/scheduled analysis succeeds without platform-devex dispatching it; central governance is not the normal scan engine |
| Effective protection | Real check identities/provider tools match applied rulesets; no permanently missing requirements or success-only migration bridges |
| Improvement safety | Existing opt-in, budgets, review/test evidence, advisory classifications and human merge pass focused regression coverage; stale one-source data no longer blocks all intake |
| Documentation | Current local, shared, generated and served instructions describe only the supported contract and correct schedules |
| Retirement | No obsolete active scanner entry points, adapters, inputs, caches, unused credentials, misleading projects or unresolved excluded-consumer conflicts |

Require 100% ledger coverage. Legitimate scan findings can remain visible for existing human
review/improvement processes; unresolved migration defects cannot.

Use focused automated tests for deterministic boundary decisions and actual hosted runs
for provider publication/identity/coverage behavior. Dispatching a main run does not prove
an App-merge trigger, and unit tests alone do not prove repository deployment protection.
Do not manufacture Dependabot authorship or create insecure dependency changes for a probe.
Use eligible real updates; required missing event evidence remains pending until observed.

## 5. Recovery and change control

- Use reviewed commits/immutable releases and retain a record of the previous refs/settings.
  A rollback is a controlled release/caller revert, not a permanent old/new dual operating mode.
- If post-merge analysis or classification fails, hold newly reachable privileged publication
  and escalate. Do not weaken checks, enable PAT fallbacks or allow an unknown origin to deploy.
- Repair/revert the coordinated change without expanding excluded scope or removing unrelated
  user changes. Any temporary transition must have an owner, removal condition and closeout gate.
- Re-run affected verification after recovery. Runtime configuration, deployed code, Terraform
  state and documentation must agree before declaring completion.

## References

- [GitHub workflow triggering and token behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [CodeQL build modes](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/codeql-for-compiled-languages)
- [CodeQL supported languages/frameworks](https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/)
- [Sonar CI-based GitHub Actions analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/ci-based-analysis/github-actions-for-sonarcloud)
- [Sonar PR target-baseline behavior](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis)
- [Sonar .NET coverage collection/import](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/test-coverage/dotnet-test-coverage)
- [Microsoft Security DevOps configuration](https://learn.microsoft.com/en-us/azure/defender-for-cloud/github-action)
- [Catalog and ownership](https://github.com/frasermolyneux/platform-workloads/blob/33e31f3c9459403b561b64d2a44edd287260b850/docs/workload-configuration.md)
