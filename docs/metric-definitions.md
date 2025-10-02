# Engineering Metrics Study · Metric Definitions

This proof of concept focuses on collecting reproducible GitHub telemetry that can validate (or challenge) the assumptions used inside the Engineering Metrics Simulator. The scope for iteration one is intentionally small—roughly 25 open-source repositories that:

- have seen at least one successful deployment workflow run in the last 60 days,
- use pull requests as the primary integration path,
- expose their default branch history publicly.

## Metrics in scope

### Deployment Frequency (per week)
- **Definition**: Count of successful deployment events on the default branch grouped by ISO week.
- **Source**: Depending on the `method` selected for a repository:
  - GitHub Actions workflow runs via REST (`GET /repos/{owner}/{repo}/actions/runs`).
  - GitHub Deployments GraphQL connection (default) with inline statuses.
  - GitHub Releases via REST (`GET /repos/{owner}/{repo}/releases`).
- **Calculation**: For each repo, aggregate successful events per week over the observation window; report median, P85, and P95 counts across the sample.
- **Caveats**: Actions workflow retention for public repositories is ~90 days, so older history must be captured via releases or deployments, and the GraphQL collector exits early once it encounters data older than the window.

### Pull Request Cycle Time (hours)
- **Definition**: Time from PR creation to merge for pull requests merged into the default branch.
- **Source**: GitHub GraphQL API `pullRequests` connection with `createdAt` and `mergedAt` timestamps; fallback to REST if needed.
- **Calculation**: Compute duration in hours for each merged PR during the observation window; report per-repo median, P85, and P95.
- **Caveats**: Rebased/force-pushed histories may hide intermediate commits; we ignore PRs closed without merge.

## Experimental metrics (not part of iteration one outputs)

### Mean Time to Recovery (MTTR)
- Investigate feasibility via issue labels (`incident`, `outage`) or revert commits linked to deployment runs.
- Requires heuristics and will be flagged as exploratory if we publish results.

### Change Failure Rate (CFR)
- Potentially measurable by pairing deployment runs with subsequent incident-labelled issues or rollback commits.
- Collection strategy will be validated after the first data slice.

## Observation window
- **Duration**: Default to the most recent 60 days to stay within Actions retention limits.
- **Granularity**: Daily collection, aggregated into weekly buckets for deployments and raw PR durations for cycle time statistics.

### Per-repository collection options

Each repository entry in `config/repos*.json` can declare a `method` that controls how deployment-like events are captured. The collector currently supports three strategies:

### `method: "actions"`

Scans GitHub Actions workflow runs, useful for projects that ship via CI pipelines. Options:

```json
{
  "slug": "owner/name",
  "method": "actions",
  "actions": {
    "workflowKeywords": ["deploy", "release"],
    "events": ["push", "workflow_dispatch"],
    "branch": "canary"
  }
}
```

- `workflowKeywords`: lower-cased substrings matched against the workflow `name` or `displayTitle`. Defaults to the CLI `--workflow-filter` list (`["deploy", "release"]`).
- `events`: optional subset of Actions event types to include (e.g., only `push`, `release`).
- `branch`: optional branch/ref restriction (`canary`, `refs/heads/main`, etc.).

### `method: "deployments"`

Uses the GitHub GraphQL Deployments connection by default. Ideal when teams promote builds through environments (`production`, `staging`, and so on).

```json
{
  "slug": "owner/name",
  "method": "deployments",
  "deployments": {
    "environments": ["production"],
    "statuses": ["success"]
  }
}
```

- `environments`: optional allow-list of deployment environments (case-insensitive).
- `statuses`: optional allow-list of latest deployment status states (`success`, `inactive`, `failure`, ...).

The GraphQL path returns deployments with their latest status in a single request and stops paginating once the window is exhausted. Set `USE_GRAPHQL_DEPLOYMENTS=false` to fall back to the REST Deployments API if GitHub introduces a breaking schema change.

### `method: "releases"`

Counts GitHub Releases, best for libraries that tag semantic versions.

```json
{
  "slug": "owner/name",
  "method": "releases",
  "releases": {
    "includePrereleases": false,
    "tagPattern": "^v"
  }
}
```

- `includePrereleases`: include releases marked as `prerelease` when `true` (default `false`).
- `tagPattern`: optional regular expression (or substring fallback) to match against `tag_name`.

## Output schema (iteration one)

| column | description |
| --- | --- |
| `repo` | `owner/name` identifier |
| `language` | Primary language reported by GitHub |
| `topics` | Pipe-delimited GitHub topics associated with the repository |
| `default_branch` | Default branch name |
| `deployments_per_week_median` | Median successful deployment runs/week |
| `deployments_per_week_p85` | 85th percentile deployments/week |
| `deployments_per_week_p95` | 95th percentile deployments/week |
| `pr_cycle_time_hours_median` | Median PR cycle time in hours |
| `pr_cycle_time_hours_p85` | 85th percentile cycle time |
| `pr_cycle_time_hours_p95` | 95th percentile cycle time |
| `sample_window_start` | UTC timestamp for first data point |
| `sample_window_end` | UTC timestamp for last data point |

The aggregator will emit this table as `engineering-metrics-study/output/metrics-summary.csv` once initial collection is in place.
