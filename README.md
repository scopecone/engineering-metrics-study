# Engineering Metrics Study (PoC)

This directory houses the data-collection spike that supports our engineering metrics blog post. Everything lives here so we can later extract it into a standalone open-source repository without touching the rest of the monorepo.

## Quick start

1. Install dependencies (Node 18+):

   ```bash
   cd engineering-metrics-study
   npm install
   ```

2. Set `GITHUB_TOKEN` in a `.env` file at the project root or export it in your shell. The token must have the `repo` scope for private repos (public data works with the default scope).

3. Create a repo list file, e.g. `config/repos.sample.json`:

   ```json
   [
     {
       "slug": "vercel/next.js",
       "method": "actions",
       "actions": {
         "workflowKeywords": ["deploy", "release"],
         "events": ["push"],
         "branch": "canary"
       }
     },
     "withastro/astro"
   ]
   ```

   Each entry can be a simple `"owner/name"` string (default `actions` method with the global filters), or an object that specifies per-repo collection rules. Supported methods are `actions`, `deployments`, and `releases`. See [`docs/metric-definitions.md`](docs/metric-definitions.md) for option details and trade-offs.

4. Collect raw payloads:

   ```bash
   npm run collect -- \
     --input config/repos.sample.json \
     --days 60 \
     --output engineering-metrics-study/data/raw
  ```

   - Use repeated `--repo owner/name` flags for ad-hoc runs.
   - Add `--refresh` to ignore cached responses.
   - Add `--debug` to log every workflow run that is counted or skipped.

5. Aggregate metrics into CSV and JSON summaries:

   ```bash
   npm run aggregate -- \
     --input engineering-metrics-study/data/raw \
     --output engineering-metrics-study/output
   ```

## Directory layout

```
engineering-metrics-study/
  docs/                     # Metric definitions & methodology
  data/raw/                 # Cached GitHub responses (gitignored)
  notebooks/                # Analysis notebooks (coming soon)
  output/                   # Aggregated CSV/JSON summaries
  scripts/
    collector/              # GitHub API collection CLI
    aggregate.ts            # Metrics aggregation CLI
  package.json              # Local tooling dependencies
```

## Next steps

- Expand the collector to persist additional metadata (workflow file paths, release tags).
- Prototype MTTR/CFR heuristics on the cached payloads.
- Add Jupyter/Observable notebook(s) that visualise the pilot cohort vs. simulator assumptions.

Refer to [`docs/metric-definitions.md`](docs/metric-definitions.md) for the current scope of tracked metrics and output schema.
