#!/usr/bin/env node
import { Command } from "commander";
import "dotenv/config";
import path from "node:path";
import fs from "fs-extra";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";

import { RateLimiter } from "./rate-limiter";
import { fetchWithConditional } from "./fetch";

import { readRepoEntries, mergeRepoEntries, type RawRepoEntry } from "./config";
import type {
  CollectorRuntimeConfig,
  RepoConfig,
  RepoCollectionResult,
  DeploymentLikeEvent,
} from "./types";
import { collectActionsEvents } from "./methods/actions";
import { collectDeploymentApiEvents } from "./methods/deployments";
import { collectDeploymentGraphQLEvents } from "./methods/deployments-graphql";
import { collectReleaseEvents } from "./methods/releases";

type GraphqlClient = typeof graphql;

interface PullRequestSummary {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number | null;
  headRefName: string;
  baseRefName: string;
  authorLogin: string | null;
}

interface RepoMetadata {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  defaultBranch: string;
  language: string | null;
  topics: string[];
  stargazersCount: number;
  forksCount: number;
  openIssuesCount: number;
  pushedAt: string | null;
}

interface RepoMetadataCache {
  fetchedAt: string;
  metadata: RepoMetadata;
  etag?: string;
  lastModified?: string;
}

const program = new Command();

program
  .description("Collect GitHub telemetry for the engineering metrics study")
  .option(
    "-r, --repo <owner/name>",
    "Repository to include (can be repeated)",
    (value, previous: string[] = []) => {
      previous.push(value);
      return previous;
    }
  )
  .option("-i, --input <path>", "Path to JSON file containing repository entries")
  .option("-d, --days <number>", "Number of days to look back", (value) => Number.parseInt(value, 10), 60)
  .option("--refresh", "Ignore cached responses and fetch from the API")
  .option(
    "--workflow-filter <words>",
    "Comma-separated list of keywords that identify deployment workflows (default: deploy,release)",
    (value) => value.split(",").map((word) => word.trim()).filter(Boolean),
    ["deploy", "release"]
  )
  .option(
    "-o, --output <dir>",
    "Directory to store raw payloads",
    "engineering-metrics-study/data/raw"
  )
  .option("--debug", "Enable verbose logging for filtered artifacts")
  .parse(process.argv);

async function readRepoArguments(
  inputPath: string | undefined,
  inlineRepos: string[] | undefined
): Promise<RawRepoEntry[]> {
  const entries: RawRepoEntry[] = [];
  if (inlineRepos) {
    entries.push(...inlineRepos);
  }
  if (inputPath) {
    const fileEntries = await readRepoEntries(inputPath);
    entries.push(...fileEntries);
  }
  if (entries.length === 0) {
    throw new Error("No repositories specified. Use --repo or --input.");
  }
  return entries;
}

async function ensureRepoDir(outputDir: string, slug: { owner: string; name: string }): Promise<string> {
  const safeName = `${slug.owner.replace(/[^a-z0-9_\-]/gi, "_")}__${slug.name.replace(/[^a-z0-9_\-]/gi, "_")}`;
  const repoDir = path.join(outputDir, safeName);
  await fs.ensureDir(repoDir);
  return repoDir;
}

async function maybeReadCache<T>(filePath: string, forceRefresh: boolean): Promise<T | null> {
  if (forceRefresh) {
    return null;
  }
  if (!(await fs.pathExists(filePath))) {
    return null;
  }
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function writeJson(filePath: string, data: unknown) {
  await fs.outputJson(filePath, data, { spaces: 2 });
}

async function collectPullRequests(
  graphqlClient: GraphqlClient,
  owner: string,
  repo: string,
  baseBranch: string,
  windowStart: string
): Promise<PullRequestSummary[]> {
  const results: PullRequestSummary[] = [];
  let cursor: string | null = null;
  const windowStartDate = new Date(windowStart);

  const query = /* GraphQL */ `
    query ($owner: String!, $name: String!, $base: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(
          states: MERGED,
          baseRefName: $base,
          orderBy: { field: UPDATED_AT, direction: DESC },
          first: 50,
          after: $cursor
        ) {
          nodes {
            number
            title
            createdAt
            mergedAt
            additions
            deletions
            changedFiles
            headRefName
            baseRefName
            author {
              login
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  type PullRequestQueryResponse = {
    repository: {
      pullRequests: {
        nodes: Array<{
          number: number;
          title: string;
          createdAt: string;
          mergedAt: string | null;
          additions: number;
          deletions: number;
          changedFiles: number | null;
          headRefName: string;
          baseRefName: string;
          author: { login: string | null } | null;
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  };

  while (true) {
    const response = await graphqlClient<PullRequestQueryResponse>(query, {
      owner,
      name: repo,
      base: baseBranch,
      cursor,
    });

    const connection = response.repository.pullRequests;
    for (const pr of connection.nodes) {
      if (!pr.mergedAt) {
        continue;
      }
      const createdAt = new Date(pr.createdAt);
      if (createdAt < windowStartDate) {
        return results;
      }
      results.push({
        number: pr.number,
        title: pr.title,
        createdAt: pr.createdAt,
        mergedAt: pr.mergedAt,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        authorLogin: pr.author?.login ?? null,
      });
    }

    if (!connection.pageInfo.hasNextPage) {
      break;
    }

    cursor = connection.pageInfo.endCursor;
  }

  return results;
}

async function collectDeploymentEvents(
  runtime: CollectorRuntimeConfig,
  repo: RepoConfig
): Promise<DeploymentLikeEvent[]> {
  if (repo.method === "actions") {
    if (!repo.actions) {
      throw new Error(`Repository ${repo.slug} missing 'actions' configuration`);
    }
    return collectActionsEvents({
      octokit: runtime.octokit,
      owner: repo.owner,
      repo: repo.name,
      windowStart: runtime.windowStart,
      windowEnd: runtime.windowEnd,
      options: repo.actions,
      debug: runtime.debug,
    });
  }

  if (repo.method === "deployments") {
    if (process.env.USE_GRAPHQL_DEPLOYMENTS !== "false") {
      return collectDeploymentGraphQLEvents({
        graphqlClient: runtime.graphqlClient,
        owner: repo.owner,
        repo: repo.name,
        windowStart: runtime.windowStart,
        windowEnd: runtime.windowEnd,
        options: repo.deployments,
        debug: runtime.debug,
      });
    }

    return collectDeploymentApiEvents({
      octokit: runtime.octokit,
      owner: repo.owner,
      repo: repo.name,
      windowStart: runtime.windowStart,
      windowEnd: runtime.windowEnd,
      options: repo.deployments,
      debug: runtime.debug,
    });
  }

  if (repo.method === "releases") {
    return collectReleaseEvents({
      octokit: runtime.octokit,
      owner: repo.owner,
      repo: repo.name,
      windowStart: runtime.windowStart,
      windowEnd: runtime.windowEnd,
      options: repo.releases,
      debug: runtime.debug,
    });
  }

  throw new Error(`Collection method '${repo.method}' not implemented yet for ${repo.slug}`);
}

async function collectRepo(
  runtime: CollectorRuntimeConfig,
  repo: RepoConfig,
  graphqlClient: GraphqlClient
): Promise<RepoCollectionResult> {
  const repoDir = await ensureRepoDir(runtime.outputDir, { owner: repo.owner, name: repo.name });

  console.log(`\n⏳ Collecting ${repo.owner}/${repo.name} [method=${repo.method}]`);

  const metadataPath = path.join(repoDir, "metadata.json");
  const cachedMetadata = await maybeReadCache<RepoMetadataCache>(metadataPath, runtime.forceRefresh);
  const metadataResult = await fetchWithConditional(
    async (headers) => {
      const response = await runtime.octokit.repos.get({
        owner: repo.owner,
        repo: repo.name,
        headers,
        mediaType: { previews: ["mercy"] },
      });
      return response as { data: any; headers: Record<string, string> };
    },
    cachedMetadata ?? null,
    (headers) => runtime.rateLimiter.updateFromHeaders(headers as any)
  );

  const metadataData = metadataResult.data as any;
  const metadata: RepoMetadata = {
    id: metadataData.id,
    name: metadataData.name,
    fullName: metadataData.full_name,
    description: metadataData.description,
    htmlUrl: metadataData.html_url,
    defaultBranch: metadataData.default_branch,
    language: metadataData.language,
    topics: Array.isArray(metadataData.topics)
      ? metadataData.topics
      : cachedMetadata?.metadata.topics ?? [],
    stargazersCount: metadataData.stargazers_count,
    forksCount: metadataData.forks_count,
    openIssuesCount: metadataData.open_issues_count,
    pushedAt: metadataData.pushed_at,
  };

  await writeJson(metadataPath, {
    fetchedAt: new Date().toISOString(),
    metadata,
    etag: metadataResult.etag,
    lastModified: metadataResult.lastModified,
  });

  const eventsPath = path.join(repoDir, "workflow-runs.json");
  let eventsPayload = await maybeReadCache<{ runs: DeploymentLikeEvent[] }>(eventsPath, runtime.forceRefresh);
  if (!eventsPayload) {
    const events = await collectDeploymentEvents(runtime, repo);
    eventsPayload = { runs: events };
    await writeJson(eventsPath, {
      fetchedAt: new Date().toISOString(),
      windowStart: runtime.windowStart,
      windowEnd: runtime.windowEnd,
      runs: events,
    });
  }

  const pullRequestPath = path.join(repoDir, "pull-requests.json");
  let prPayload = await maybeReadCache<{ pullRequests: PullRequestSummary[] }>(
    pullRequestPath,
    runtime.forceRefresh
  );
  if (!prPayload) {
    const prs = await collectPullRequests(
      graphqlClient,
      repo.owner,
      repo.name,
      metadata.defaultBranch,
      runtime.windowStart
    );
    prPayload = { pullRequests: prs };
    await writeJson(pullRequestPath, {
      fetchedAt: new Date().toISOString(),
      windowStart: runtime.windowStart,
      windowEnd: runtime.windowEnd,
      baseBranch: metadata.defaultBranch,
      pullRequests: prs,
    });
  }

  return {
    repo: metadata.fullName,
    pullRequests: prPayload.pullRequests.length,
    deploymentEvents: eventsPayload.runs.length,
    cached: !runtime.forceRefresh,
  };
}

async function collectReposParallel(
  runtime: CollectorRuntimeConfig,
  repoConfigs: RepoConfig[],
  graphqlClient: GraphqlClient,
  concurrency = 5
): Promise<RepoCollectionResult[]> {
  const results: RepoCollectionResult[] = new Array(repoConfigs.length);
  let index = 0;
  const showProgress = process.env.COLLECTOR_PROGRESS === "true" || runtime.debug;

  const worker = async () => {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= repoConfigs.length) {
        break;
      }
      const repoConfig = repoConfigs[currentIndex];
      if (showProgress) {
        console.log(
          `[${currentIndex + 1}/${repoConfigs.length}] Collecting ${repoConfig.slug}…`
        );
      }
      try {
        const summary = await collectRepo(runtime, repoConfig, graphqlClient);
        results[currentIndex] = summary;
        if (showProgress) {
          console.log(
            `✓ [${currentIndex + 1}/${repoConfigs.length}] ${repoConfig.slug}`
          );
        }
      } catch (error) {
        console.error(
          `❌ Failed to collect ${repoConfig.slug}:`,
          error instanceof Error ? error.message : error
        );
        results[currentIndex] = {
          repo: repoConfig.slug,
          pullRequests: 0,
          deploymentEvents: 0,
          cached: false,
        };
      }
    }
  };

  const workerCount = Math.min(concurrency, repoConfigs.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results.filter(Boolean);
}

async function run() {
  const options = program.opts<{
    repo?: string[];
    input?: string;
    days: number;
    refresh?: boolean;
    workflowFilter: string[];
    output: string;
    debug?: boolean;
  }>();

  if (options.debug) {
    console.log("ℹ️  Debug mode enabled");
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required. Set it via environment variable or .env file.");
  }

  const rawEntries = await readRepoArguments(options.input, options.repo);
  const repoConfigs = mergeRepoEntries(rawEntries, {
    workflowKeywords: options.workflowFilter,
  });

  const rateLimiter = new RateLimiter();
  const octokit = new Octokit({ auth: token });
  octokit.hook.before("request", async () => {
    await rateLimiter.checkAndWait();
  });
  octokit.hook.after("request", (response) => {
    rateLimiter.updateFromHeaders(response.headers as any);
  });
  const graphqlClient = graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });

  const nowIso = new Date().toISOString().split(".")[0] + "Z";
  const windowStartIso = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split(".")[0] + "Z";

  const runtime: CollectorRuntimeConfig = {
    repos: repoConfigs,
    days: options.days,
    forceRefresh: Boolean(options.refresh),
    outputDir: options.output,
    debug: Boolean(options.debug),
    octokit,
    windowStart: windowStartIso,
    windowEnd: nowIso,
    rateLimiter,
    graphqlClient,
  };

  const summaries = await collectReposParallel(runtime, repoConfigs, graphqlClient, 5);

  console.log("\n✅ Collection complete:");
  for (const item of summaries) {
    console.log(
      `  • ${item.repo}: ${item.pullRequests} PRs, ${item.deploymentEvents} deployment events`
    );
  }
}

run().catch((error) => {
  console.error("\n❌ Collector failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
