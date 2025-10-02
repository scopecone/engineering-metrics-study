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
   npm run collect -- \\
     --input config/repos.sample.json \\
     --days 60 \\
     --output engineering-metrics-study/data/raw
   ```

   - Use repeated `--repo owner/name` flags for ad-hoc runs.
   - Add `--refresh` to ignore cached responses.
   - Add `--debug` to log every workflow run that is counted or skipped.
   - Set `COLLECTOR_PROGRESS=true` to emit `[n/total]` progress updates during long batches.

5. Aggregate metrics into CSV and JSON summaries:

   ```bash
   npm run aggregate -- \\
     --input engineering-metrics-study/data/raw \\
     --output engineering-metrics-study/output
   ```

6. Discover candidate repos by topic and get method recommendations:

   ```bash
   npm run discover -- \\
     --topic nextjs \\
     --topic astro \\
     --limit 3 \\
     --format table
   ```

   Use `--format json` to export machine-consumable output for downstream tooling or AI-assisted triage.
   Filter out curated lists or manuals via `--exclude-topics` / `--exclude-keywords` if a topic returns non-product repos.

### Runtime configuration

- `COLLECTOR_PROGRESS=true npm run collect …` — surfaces progress logs from each worker without enabling full debug mode.
- `USE_GRAPHQL_DEPLOYMENTS=false npm run collect …` — falls back to the REST Deployments API if the GitHub GraphQL schema changes; the default GraphQL path batches deployments and statuses to minimise API calls.
- The collector automatically respects conditional requests (ETag/Last-Modified headers) and will pause when the GitHub rate limit approaches zero, so reruns can safely share cached responses.
- PR bot authors are filtered by default. Use `npm run collect -- --include-bot-prs …` to keep them, or override detection heuristics with `--bot-author-patterns dependabot,renovate`.

### Testing

Run the targeted regression tests with:

```bash
npm test
```

This suite covers the deployment GraphQL collector pagination/filters and the Actions workflow pagination behaviour.

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
