#!/usr/bin/env node
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const RAW_DIR = path.join(ROOT, "data", "raw");
const OUTPUT_PATH = path.join(ROOT, "output", "metrics-pr-size.json");

interface MetricsSummaryRow {
  repo: string;
  prCycleTimeHoursMedian: number | null;
  prCycleTimeHoursP85: number | null;
  prCycleTimeHoursP95: number | null;
  prCount: number | null;
}

interface PullRequestSummary {
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  mergedAt?: string | null;
  createdAt?: string | null;
}

interface PullRequestPayload {
  pullRequests: PullRequestSummary[];
}

interface RepoResult {
  repo: string;
  prCount: number;
  prCycleTimeHoursMedian: number | null;
  prCycleTimeHoursP85: number | null;
  prCycleTimeHoursP95: number | null;
  medianChanges: number | null;
  p75Changes: number | null;
  p90Changes: number | null;
  medianFiles: number | null;
  p75Files: number | null;
  p90Files: number | null;
}

function percentile(values: number[], pct: number): number | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const idx = (sorted.length - 1) * pct;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) {
    return sorted[lower];
  }
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  return lowerValue + (upperValue - lowerValue) * (idx - lower);
}

async function main() {
  const summaryPath = path.join(ROOT, "output", "metrics-summary.json");
  const summary = await fs.readJson(summaryPath);
  const summaryMap = new Map<string, MetricsSummaryRow>();
  for (const row of summary.rows as MetricsSummaryRow[]) {
    summaryMap.set(row.repo.toLowerCase(), row);
  }

  const entries = await fs.readdir(RAW_DIR);
  const results: RepoResult[] = [];

  for (const entry of entries) {
    const dir = path.join(RAW_DIR, entry);
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      continue;
    }
    const prPath = path.join(dir, "pull-requests.json");
    if (!(await fs.pathExists(prPath))) {
      continue;
    }
    const payload = (await fs.readJson(prPath)) as PullRequestPayload;
    const metadataPath = path.join(dir, "metadata.json");
    const metadata = await fs.readJson(metadataPath).catch(() => null);
    const repoSlug: string | null = metadata?.metadata?.fullName ?? null;
    if (!repoSlug) {
      continue;
    }
    const prRows = payload.pullRequests ?? [];
    if (!prRows.length) {
      continue;
    }
    const changes: number[] = [];
    const filesChanged: number[] = [];
    for (const pr of prRows) {
      const additions = pr.additions ?? 0;
      const deletions = pr.deletions ?? 0;
      const total = additions + deletions;
      if (Number.isFinite(total)) {
        changes.push(total);
      }
      if (Number.isFinite(pr.changedFiles ?? NaN)) {
        filesChanged.push(pr.changedFiles!);
      }
    }

    const summaryRow = summaryMap.get(repoSlug.toLowerCase());
    results.push({
      repo: repoSlug,
      prCount: prRows.length,
      prCycleTimeHoursMedian: summaryRow?.prCycleTimeHoursMedian ?? null,
      prCycleTimeHoursP85: summaryRow?.prCycleTimeHoursP85 ?? null,
      prCycleTimeHoursP95: summaryRow?.prCycleTimeHoursP95 ?? null,
      medianChanges: percentile(changes, 0.5),
      p75Changes: percentile(changes, 0.75),
      p90Changes: percentile(changes, 0.9),
      medianFiles: percentile(filesChanged, 0.5),
      p75Files: percentile(filesChanged, 0.75),
      p90Files: percentile(filesChanged, 0.9),
    });
  }

  await fs.writeJson(
    OUTPUT_PATH,
    {
      generatedAt: new Date().toISOString(),
      repos: results,
    },
    { spaces: 2 }
  );
  await fs.appendFile(OUTPUT_PATH, "\n");
}

main().catch((error) => {
  console.error("Failed to compute PR size metrics", error);
  process.exit(1);
});
