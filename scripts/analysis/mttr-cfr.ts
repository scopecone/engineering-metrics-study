#!/usr/bin/env node
import { Command } from "commander";
import "dotenv/config";
import fs from "fs-extra";
import path from "node:path";
import { Octokit } from "@octokit/rest";

interface RevertEventSummary {
  revertSha: string;
  revertedSha: string;
  revertDate: string;
  originalDate: string | null;
  recoveryHours: number | null;
}

interface RepoResult {
  repo: string;
  windowDays: number;
  deployCount?: number | null;
  prCount?: number | null;
  revertCount: number;
  revertMedianHours: number | null;
  revertP85Hours: number | null;
  revertP95Hours: number | null;
  revertEvents: RevertEventSummary[];
  incidentCount: number;
  incidentIssues: Array<{ number: number; title: string; url: string; createdAt: string }>;
  changeFailureRate: number | null;
}

interface MetricsSummaryRow {
  repo: string;
  deployCount?: number | null;
  prCount?: number | null;
}

const program = new Command();

program
  .description("Prototype MTTR/CFR heuristics based on revert commits and incident issues")
  .option("--repo <owner/name>", "Repository slug", (value, previous: string[] = []) => {
    previous.push(value);
    return previous;
  })
  .option("--days <number>", "Lookback window in days", (value) => Number.parseInt(value, 10), 90)
  .option("--output <path>", "Optional JSON output file", path.resolve(process.cwd(), "output/metrics-mttr-cfr.json"))
  .option("--summary <path>", "Path to metrics-summary.json", path.resolve(process.cwd(), "output/metrics-summary.json"))
  .parse(process.argv);

function ensureToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required. Set it via environment variable or .env file.");
  }
  return token;
}

async function loadMetricsSummary(summaryPath: string): Promise<Map<string, MetricsSummaryRow>> {
  const exists = await fs.pathExists(summaryPath);
  if (!exists) {
    return new Map();
  }
  const data = await fs.readJson(summaryPath);
  if (!data || !Array.isArray(data.rows)) {
    return new Map();
  }
  const map = new Map<string, MetricsSummaryRow>();
  for (const row of data.rows) {
    if (row && typeof row.repo === "string") {
      map.set(row.repo.toLowerCase(), {
        repo: row.repo,
        deployCount: row.deployCount ?? null,
        prCount: row.prCount ?? null,
      });
    }
  }
  return map;
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

async function fetchRevertCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  sinceIso: string
): Promise<RevertEventSummary[]> {
  const commits = await octokit.paginate(octokit.repos.listCommits, {
    owner,
    repo,
    since: sinceIso,
    per_page: 100,
  });

  const revertCommits: RevertEventSummary[] = [];

  for (const commit of commits) {
    const message = commit.commit?.message ?? "";
    if (!/revert/i.test(message)) {
      continue;
    }
    const match = message.match(/This reverts commit ([0-9a-fA-F]{7,40})/);
    if (!match) {
      continue;
    }
    const revertedSha = match[1];
    let originalDate: string | null = null;
    try {
      const original = await octokit.repos.getCommit({ owner, repo, ref: revertedSha });
      originalDate = original.data.commit?.author?.date ?? null;
    } catch (error) {
      if (process.env.DEBUG_MTTR) {
        console.warn(`[${owner}/${repo}] Failed to fetch reverted commit ${revertedSha}:`, error);
      }
    }
    const recoveryHours = (() => {
      if (!originalDate) {
        return null;
      }
      const revertDateMs = new Date(commit.commit?.author?.date ?? commit.commit?.committer?.date ?? new Date().toISOString()).getTime();
      const originalDateMs = new Date(originalDate).getTime();
      if (!Number.isFinite(revertDateMs) || !Number.isFinite(originalDateMs) || revertDateMs < originalDateMs) {
        return null;
      }
      return (revertDateMs - originalDateMs) / (1000 * 60 * 60);
    })();

    revertCommits.push({
      revertSha: commit.sha,
      revertedSha,
      revertDate: commit.commit?.author?.date ?? commit.commit?.committer?.date ?? new Date().toISOString(),
      originalDate,
      recoveryHours,
    });
  }

  return revertCommits;
}

async function fetchIncidentIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  sinceIso: string
): Promise<Array<{ number: number; title: string; url: string; createdAt: string }>> {
  const labels = ["incident", "rollback", "postmortem", "outage"];
  const incidents: Array<{ number: number; title: string; url: string; createdAt: string }> = [];

  for (const label of labels) {
    const issues = await octokit.paginate(octokit.issues.listForRepo, {
      owner,
      repo,
      state: "all",
      labels: label,
      since: sinceIso,
      per_page: 100,
    });
    for (const issue of issues) {
      if ((issue.pull_request ?? null) !== null) {
        continue;
      }
      incidents.push({
        number: issue.number,
        title: issue.title ?? "",
        url: issue.html_url ?? "",
        createdAt: issue.created_at ?? "",
      });
    }
  }

  const unique = new Map<number, { number: number; title: string; url: string; createdAt: string }>();
  for (const incident of incidents) {
    unique.set(incident.number, incident);
  }
  return Array.from(unique.values()).sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
}

async function analyseRepo(
  octokit: Octokit,
  repoSlug: string,
  days: number,
  metricsMap: Map<string, MetricsSummaryRow>
): Promise<RepoResult> {
  const [owner, name] = repoSlug.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo slug '${repoSlug}'. Expected owner/name.`);
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  const revertCommits = await fetchRevertCommits(octokit, owner, name, sinceIso);
  const incidentIssues = await fetchIncidentIssues(octokit, owner, name, sinceIso);

  const recoveryDurations: number[] = [];
  for (const event of revertCommits) {
    if (typeof event.recoveryHours === "number" && Number.isFinite(event.recoveryHours)) {
      recoveryDurations.push(event.recoveryHours);
    }
  }

  const row = metricsMap.get(repoSlug.toLowerCase());
  const deployCount = row?.deployCount ?? null;
  const changeFailureRate = deployCount && deployCount > 0 ? revertCommits.length / deployCount : null;

  return {
    repo: repoSlug,
    windowDays: days,
    deployCount,
    prCount: row?.prCount ?? null,
    revertCount: revertCommits.length,
    revertMedianHours: percentile(recoveryDurations, 0.5),
    revertP85Hours: percentile(recoveryDurations, 0.85),
    revertP95Hours: percentile(recoveryDurations, 0.95),
    revertEvents: revertCommits,
    incidentCount: incidentIssues.length,
    incidentIssues,
    changeFailureRate,
  };
}

async function main() {
  const options = program.opts<{
    repo?: string[];
    days: number;
    output: string;
    summary: string;
  }>();

  const repos = options.repo ?? [];
  if (repos.length === 0) {
    throw new Error("At least one --repo is required");
  }

  const token = ensureToken();
  const octokit = new Octokit({ auth: token });
  const metricsMap = await loadMetricsSummary(options.summary);

  const results: RepoResult[] = [];
  for (const repo of repos) {
    console.log(`\n🔍 Analysing ${repo} (last ${options.days} days)…`);
    const result = await analyseRepo(octokit, repo, options.days, metricsMap);
    results.push(result);
    console.log(
      `  Reverts: ${result.revertCount}, MTTR median: ${result.revertMedianHours?.toFixed(1) ?? "n/a"}h, incidents: ${result.incidentCount}`
    );
  }

  const outputPayload = {
    generatedAt: new Date().toISOString(),
    windowDays: options.days,
    repos: results,
  };

  await fs.ensureDir(path.dirname(options.output));
  await fs.writeJson(options.output, outputPayload, { spaces: 2 });
  await fs.appendFile(options.output, "\n");

  console.log(`\n✅ MTTR/CFR snapshot saved to ${options.output}`);
}

main().catch((error) => {
  console.error("\n❌ MTTR/CFR analysis failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
