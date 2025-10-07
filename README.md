# Engineering Metrics Study

This repository hosts ScopeCone's open research on software delivery benchmarks. We collect public GitHub signals from actively maintained projects, translate them into a comparable set of engineering metrics, and contrast the findings against the expectations baked into our engineering metrics simulator. All tooling, configuration, and documentation needed to replicate the study lives here.

## Why this study exists
- Produce reproducible delivery benchmarks sourced directly from GitHub Actions, Deployments, and Releases APIs.
- Validate (or challenge) the simulator assumptions we share with product and engineering leaders.
- Provide a transparent workflow that outside contributors can extend with new data sources, heuristics, or visualisations.

Read more about the metric definitions and trade-offs in [`docs/metric-definitions.md`](docs/metric-definitions.md).

## About ScopeCone
[ScopeCone](https://scopecone.io) helps product and engineering leaders move beyond once-a-quarter roadmap guesswork. Our capacity-led planning platform supports iterative estimation loops that shrink the "cone" of uncertainty, keep teams aligned, and surface risks before commitments slip.

Questions about the project or partnership opportunities? Reach us at [hello@scopecone.io](mailto:hello@scopecone.io).

## Try the Engineering Metrics Simulator
Curious how your team's delivery flow compares to the study cohort? Experiment with scenarios in the free [Engineering Metrics Simulator](https://scopecone.io/tools/engineering-metrics-simulator). The simulator lets you plug in cycle time, deployment frequency, and incident response assumptions to see how your roadmap capacity shifts under different constraints.

## Getting started from scratch
1. **Install prerequisites**
   - Node.js 18 or newer.
   - A GitHub personal access token stored as `GITHUB_TOKEN` in a `.env` file at the repo root (or exported in your shell). Public projects only need default scopes; private repos require the `repo` scope.
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Describe the repositories you want to analyse**
   - Copy `config/repos.sample.json` and tailor it to your cohort.
   - Each entry can be a simple `"owner/name"` string or an object with per-repository rules. Supported collection methods: `actions`, `deployments`, and `releases`.
4. **Collect raw payloads from GitHub**
   ```bash
   npm run collect -- \
     --input config/repos.sample.json \
     --days 365
   ```
   Helpful flags: `--repo owner/name` for ad-hoc runs, `--refresh` to ignore caches, `--debug` for verbose logs, and `COLLECTOR_PROGRESS=true` for progress updates. Payloads default to `data/raw`; change with `--output` if needed.

   For long-running batches, add `--state-file tmp/run.jsonl --resume` to write a manifest and restart safely after interruptions. The collector appends one JSON line per repository; subsequent runs with `--resume` skip entries already marked `success`, while `--force owner/name` re-collects specific repos.
5. **Aggregate metrics for analysis**
   ```bash
   npm run aggregate -- \
     --input data/raw \
     --output output
   ```
6. **(Optional) Discover additional candidate repositories**
   ```bash
   npm run discover -- \
     --topic nextjs \
     --topic astro \
     --limit 3 \
     --holdout config/repos.holdout.json \
     --format table
   ```
   Use `--format json` for machine-readable results, and `--write-validation` to persist curated batches before promotion.

Once the commands finish, explore the generated CSV/JSON artefacts in `output/` or load them into your own notebooks.

## Tooling highlights
- **Validation promotion**: `npm run promote -- --input config/repos.batchN.validation.json [--apply] [--update-discovery]`
- **Release inspector**: `npm run inspect-releases -- --repo owner/name --count 25 [--validate config/repos.sample.json]`
- **Discovery pipeline**: Chain `discover → inspect-releases → collect → promote` to scale the cohort safely under GitHub API limits.

## Repository layout
```
docs/                     # Metric definitions & methodology
config/                   # Sample and curated repo lists
data/raw/                 # Cached GitHub responses (gitignored)
notebooks/                # Exploratory analysis (coming soon)
output/                   # Aggregated CSV/JSON summaries
scripts/                  # CLI entry points for collectors & aggregators
package.json              # Local tooling dependencies
```

## Contributing
We welcome additions that expand the dataset or deepen the analysis. Open an issue describing the metric, heuristic, or integration you would like to add, or submit a pull request with:
- A clear description of the proposed change and why it matters to the study.
- Updates to documentation or examples when behaviour changes.
- New or updated automated tests when applicable (`npm test`).

Thanks for helping the community build more actionable engineering benchmarks!
