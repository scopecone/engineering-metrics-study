#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs-extra";
import path from "node:path";

interface RepoMetadataPayload {
  fetchedAt: string;
  metadata: {
    id: number;
    name: string;
    fullName: string;
    description: string | null;
    htmlUrl: string;
    defaultBranch: string;
    language: string | null;
    stargazersCount: number;
    forksCount: number;
    openIssuesCount: number;
    pushedAt: string | null;
  };
}

interface WorkflowPayload {
  fetchedAt: string;
  windowStart: string;
  windowEnd?: string;
  runs: Array<{
    id: number;
    createdAt: string;
    updatedAt: string;
    headBranch?: string | null;
    headSha?: string | null;
  }>;
}

interface PullRequestPayload {
  fetchedAt: string;
  windowStart: string;
  windowEnd?: string;
  baseBranch: string;
  pullRequests: Array<{
    number: number;
    createdAt: string;
    mergedAt: string;
  }>;
}

interface RepoAggregateRow {
  repo: string;
  language: string | null;
  defaultBranch: string;
  deployCount: number;
  prCount: number;
  deploymentsPerWeekMedian: number | null;
  deploymentsPerWeekP85: number | null;
  deploymentsPerWeekP95: number | null;
  prCycleTimeHoursMedian: number | null;
  prCycleTimeHoursP85: number | null;
  prCycleTimeHoursP95: number | null;
  sampleWindowStart: string | null;
  sampleWindowEnd: string | null;
}

const program = new Command();

program
  .description("Aggregate cached GitHub telemetry into summary statistics")
  .option("-i, --input <dir>", "Directory containing raw repo payloads", "engineering-metrics-study/data/raw")
  .option("-o, --output <dir>", "Directory for aggregated outputs", "engineering-metrics-study/output")
  .parse(process.argv);

function parseIsoDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return date;
}

function getIsoWeekKey(date: Date): string {
  const temp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday in current week decides the year.
  temp.setUTCDate(temp.getUTCDate() + 4 - (temp.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((temp.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${temp.getUTCFullYear()}-W${weekNumber.toString().padStart(2, "0")}`;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

async function loadJsonIfExists<T>(filePath: string): Promise<T | null> {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function aggregateRepo(dirPath: string, slug: string): Promise<RepoAggregateRow | null> {
  const metadata = await loadJsonIfExists<RepoMetadataPayload>(path.join(dirPath, "metadata.json"));
  const workflows = await loadJsonIfExists<WorkflowPayload>(path.join(dirPath, "workflow-runs.json"));
  const pullRequests = await loadJsonIfExists<PullRequestPayload>(path.join(dirPath, "pull-requests.json"));

  if (!metadata) {
    console.warn(`⚠️  Skipping ${slug}: missing metadata.json`);
    return null;
  }
  if (!workflows) {
    console.warn(`⚠️  Skipping ${slug}: missing workflow-runs.json`);
    return null;
  }
  if (!pullRequests) {
    console.warn(`⚠️  Skipping ${slug}: missing pull-requests.json`);
    return null;
  }

  const deployCountsByWeek = new Map<string, number>();
  for (const run of workflows.runs) {
    const created = parseIsoDate(run.createdAt);
    const key = getIsoWeekKey(created);
    deployCountsByWeek.set(key, (deployCountsByWeek.get(key) ?? 0) + 1);
  }

  const deployStats = Array.from(deployCountsByWeek.values());
  const prDurations: number[] = [];
  for (const pr of pullRequests.pullRequests) {
    const created = parseIsoDate(pr.createdAt);
    const merged = parseIsoDate(pr.mergedAt);
    const durationHours = (merged.getTime() - created.getTime()) / 3_600_000;
    if (durationHours >= 0) {
      prDurations.push(durationHours);
    }
  }

  const timeCandidates: string[] = [];
  for (const run of workflows.runs) {
    if (run.createdAt) {
      timeCandidates.push(run.createdAt);
    }
    if (run.updatedAt) {
      timeCandidates.push(run.updatedAt);
    }
  }
  for (const pr of pullRequests.pullRequests) {
    if (pr.createdAt) {
      timeCandidates.push(pr.createdAt);
    }
    if (pr.mergedAt) {
      timeCandidates.push(pr.mergedAt);
    }
  }

  const sampleWindowStart = timeCandidates.length > 0 ? timeCandidates.reduce((min, ts) => (ts < min ? ts : min)) : null;
  const sampleWindowEnd = timeCandidates.length > 0 ? timeCandidates.reduce((max, ts) => (ts > max ? ts : max)) : null;

  return {
    repo: metadata.metadata.fullName,
    language: metadata.metadata.language,
    defaultBranch: metadata.metadata.defaultBranch,
    deployCount: workflows.runs.length,
    prCount: pullRequests.pullRequests.length,
    deploymentsPerWeekMedian: percentile(deployStats, 0.5),
    deploymentsPerWeekP85: percentile(deployStats, 0.85),
    deploymentsPerWeekP95: percentile(deployStats, 0.95),
    prCycleTimeHoursMedian: percentile(prDurations, 0.5),
    prCycleTimeHoursP85: percentile(prDurations, 0.85),
    prCycleTimeHoursP95: percentile(prDurations, 0.95),
    sampleWindowStart,
    sampleWindowEnd,
  };
}

async function writeCsv(filePath: string, rows: RepoAggregateRow[]) {
  const headers = [
    "repo",
    "language",
    "default_branch",
    "deploy_count",
    "pr_count",
    "deployments_per_week_median",
    "deployments_per_week_p85",
    "deployments_per_week_p95",
    "pr_cycle_time_hours_median",
    "pr_cycle_time_hours_p85",
    "pr_cycle_time_hours_p95",
    "sample_window_start",
    "sample_window_end",
  ];

  const lines = [headers.join(",")];
  for (const row of rows) {
    const values = [
      row.repo,
      row.language ?? "",
      row.defaultBranch,
      row.deployCount.toString(),
      row.prCount.toString(),
      row.deploymentsPerWeekMedian?.toFixed(3) ?? "",
      row.deploymentsPerWeekP85?.toFixed(3) ?? "",
      row.deploymentsPerWeekP95?.toFixed(3) ?? "",
      row.prCycleTimeHoursMedian?.toFixed(3) ?? "",
      row.prCycleTimeHoursP85?.toFixed(3) ?? "",
      row.prCycleTimeHoursP95?.toFixed(3) ?? "",
      row.sampleWindowStart ?? "",
      row.sampleWindowEnd ?? "",
    ];
    lines.push(values.map((value) => `"${value.replace(/"/g, '""')}"`).join(","));
  }

  await fs.outputFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function run() {
  const options = program.opts<{ input: string; output: string }>();
  const inputDir = path.resolve(options.input);
  const outputDir = path.resolve(options.output);

  if (!(await fs.pathExists(inputDir))) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const aggregates: RepoAggregateRow[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const repoDir = path.join(inputDir, entry.name);
    const slug = entry.name;
    const aggregate = await aggregateRepo(repoDir, slug);
    if (aggregate) {
      aggregates.push(aggregate);
    }
  }

  aggregates.sort((a, b) => a.repo.localeCompare(b.repo));

  await fs.ensureDir(outputDir);
  const csvPath = path.join(outputDir, "metrics-summary.csv");
  const jsonPath = path.join(outputDir, "metrics-summary.json");

  await writeCsv(csvPath, aggregates);
  await fs.writeJson(jsonPath, { generatedAt: new Date().toISOString(), rows: aggregates }, { spaces: 2 });

  console.log(`\n✅ Aggregation wrote ${aggregates.length} rows`);
  console.log(`  • CSV: ${csvPath}`);
  console.log(`  • JSON: ${jsonPath}`);
}

run().catch((error) => {
  console.error("\n❌ Aggregator failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
