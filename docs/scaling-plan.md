# Scaling Plan: 250 Repository Cohort

This plan outlines how we will grow the engineering metrics study from 75 to 250 high-signal repositories while maintaining data quality. Each phase should be executed incrementally (≈50 repos per iteration) with automated validation between steps.

## 1. Repository Selection Criteria

A repository qualifies when **all** of the following conditions are met:

1. **Active development**
   - ≥ 5 commits on the default branch in the last 90 days, or
   - ≥ 10 merged PRs in the last 180 days.
2. **Deployment signal**
   - At least one successful deployment (production environment preferred) or release tag in the previous 12 months.
3. **Non-documentation**
   - README and topics do not match denylisted keywords (`awesome`, `list`, `tutorial`, `docs`, `handbook`, `examples`).
4. **Product-oriented**
   - Describes an application, service, or library used in production (exclude curricula, sample apps, or static marketing sites).

Repositories that fail any test are placed in a `holdout` list for manual review and excluded from the main cohort.

## 2. Discovery Strategy

We gather candidates across underrepresented ecosystems to balance the dataset:

- **Frontend/Web**: nextjs, astro, react, design-system
- **Backend/SaaS**: rails, nestjs, django, express, fastapi
- **DevOps/Infra**: kubernetes, terraform, ansible, observability, sre
- **Data/ML**: mlops, llm, data-engineering, analytics
- **Mobile/Desktop**: flutter, react-native, electron, tauri

For each topic (keep batches to ≈4 topics/run to respect GitHub’s 30 requests/min search limit):

1. Query GitHub search API (via `scripts/discovery`) limited to the last 12 months of activity.
2. Retrieve metadata (stars, forks, default branch, language, topics).
3. Capture release and workflow hints to recommend collection method (`releases`, `deployments`, `actions`).
4. Apply keyword/topic denylist immediately to remove documentation/tutorial repos and pass `--holdout config/repos.holdout.json` so previously rejected slugs are skipped automatically.

## 3. Heuristics and Automation

Enhancements to `scripts/discovery`:

- **Activity checks**: fetch recent commit or PR counts (GraphQL) and annotate results.
- **Deployment pivot**: inspect Releases, Deployments, and Actions workflow names; recommend method automatically.
- **Caching**: cache search results and per-repo metadata for 24 hours to minimise API usage.
- **Report generation**: output summary including counts of filtered-out repos and reasons (`docs_only`, `no_deployments`, `low_activity`).

## 4. Batch Onboarding Loop

For each 50-repo increment:

1. Run discovery across target topics with updated heuristics.
2. Export candidates plus recommended `method` into `config/repos.batch-YYYYMMDD.json`.
3. Manually spot-check border cases (top 10 borderline entries).
4. Merge accepted repos into `config/repos.discovery.json` with method overrides.
5. Execute collector:
   ```bash
   npm run collect -- \
     --input config/repos.discovery.json \
     --days 365 --refresh \
     --output data/raw
   npm run aggregate
   ```
6. Validate metrics:
   - Ensure `deployCount > 0` and `prCount > 0` for ≥ 95% of new repos.
   - Investigate outliers (zero deploy, zero PR, <30-day window) before promoting the batch.
7. Promote the validated repos into `config/repos.sample.json` for inclusion in the core cohort.

## 5. Quality Gates & Holdout Tracking

- Maintain `config/repos.holdout.json` capturing repos rejected with a `reason` field (e.g., `docs_only`, `no_recent_deploy`, `sparse_activity`).
- Add a CLI flag `--holdout` to the discovery tool to exclude holdout slugs in future runs.
- Update the aggregation summary to surface per-repo `windowDays` and `deploymentsPerWeekMedian`; flag anything below thresholds (`windowDays < 60`, `deploymentsPerWeekMedian == 0`).

## 6. Documentation & Reporting

After each batch:

- Update `docs/scaling-plan.md` (this file) with learnings/adjustments.
- Append summary statistics to `docs/metrics-milestones.md` (new file) capturing cohort counts and quality metrics.
- Share the report with the team for sign-off before proceeding to the next batch.

Following this plan should allow us to reach 250 repositories within ~4 batches while staying under GitHub API rate limits and preserving dataset integrity.

## 2025-10-06 Batch Summary

- **Focus topics**: SwiftUI/macOS apps (9), Flutter/Dart clients (12), robotics & embodied AI stacks (14), game-dev engines & tooling (15).
- **New repos captured**: 50 high-signal projects appended to `config/repos.discovery.json` and staged in `config/batches/repos.batch-20251006.json`.
- **Collection method adjustments**: switched several high-volume projects (Godot, Drake, Swiftfin, Loop, etc.) to the `releases` method to avoid missing deployment signals hidden behind release tags.
- **Holdouts added**: `Developer-Y/cs-video-courses` (docs-only) and `rrousselGit/riverpod` (no recent deployment surrogate) were excluded to keep the dataset focused on product repos with reproducible release cadence.
- **Artifacts**: aggregated metrics for the batch are stored in `output/batch-20251006/` for review before promoting entries into `config/repos.sample.json`.
- **Collector resume**: Use `npm run collect -- --input config/repos.sample.json --state-file tmp/run-<date>.jsonl --resume` to recover long runs; the manifest captures per-repo status, and `--force owner/name` replays any slice as needed.

## 2025-10-07 Batch Summary

- **Focus topics**: .NET production apps (9), Julia data/ML ecosystems (15), operational security tooling (5), WebAssembly runtimes/toolchains (15).
- **Signals captured**:
  - `.NET`: median PR cycle ≈ 58 h, weekly deploy cadence ≈ 1, median deploy count 23 (key additions: `dotnet/aspnetcore`, `bitwarden/server`, `amplication/amplication`).
  - `Julia`: median PR cycle ≈ 7.9 h, deployments ≈ 2 / week (e.g., `JuliaLang/julia`, `MakieOrg/Makie.jl`, `FluxML/Zygote.jl`).
  - `Red-team tooling`: 5 repos with meaningful PR activity (e.g., `BishopFox/sliver`, `Pennyw0rth/NetExec`); most release asynchronously, so deploy cadence stays sparse.
  - `WebAssembly`: median PR cycle ≈ 6 h, deployments ≈ 3 / week, median deploy count 27 (`wasmerio/wasmer`, `bytecodealliance/wasmtime`, `tursodatabase/libsql`).
- **Holdouts added**: documentation/data dumps and repos without observable automation (`nteract/papermill`, `multiprocessio/datastation`, `quasar/Quasar`, `samratashok/nishang`, `cobbr/Covenant`, `lcvvvv/kscan`, `skerkour/black-hat-rust`, `leebaird/discover`, `cisagov/RedEye`, `bats3c/shad0w`, `therecipe/qt`).
- **Artifacts**: Metrics for the batch live in `output/batch-20251007/` (CSV/JSON) for review before selecting repos to promote into `config/repos.sample.json`.
