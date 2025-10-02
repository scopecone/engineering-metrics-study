#!/usr/bin/env node
import { Command } from "commander";
import "dotenv/config";
import fs from "fs-extra";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";

interface RepoSlug {
  owner: string;
  name: string;
}

type CollectionMethod = "actions" | "deployments" | "releases";

interface ActionsCollectionOptions {
  workflowKeywords: string[];
  events?: string[];
  branch?: string | null;
}

interface RepoConfig {
  slug: string;
  owner: string;
  name: string;
  method: CollectionMethod;
  actions: ActionsCollectionOptions;
}

interface CollectorConfig {
  repos: RepoConfig[];
  days: number;
  forceRefresh: boolean;
  outputDir: string;
  debug: boolean;
}

interface WorkflowRunSummary {
  id: number;
  name: string;
  displayTitle: string;
  event: string;
  status: string | null;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  runAttempt?: number | null;
  headBranch: string | null;
  headSha: string | null;
}

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
  stargazersCount: number;
  forksCount: number;
  openIssuesCount: number;
  pushedAt: string | null;
}

interface RepoMetadataCache {
  fetchedAt: string;
  metadata: RepoMetadata;
}

const program = new Command();

program
  .description("Collect GitHub telemetry for the engineering metrics study")
  .option("-r, --repo <owner/name>", "Repository to include", (value, previous: string[] = []) => {
    previous.push(value);
    return previous;
  })
  .option("-i, --input <path>", "Path to JSON file containing an array of repo slugs")
  .option("-d, --days <number>", "Number of days to look back", (value) => Number.parseInt(value, 10), 60)
  .option("--refresh", "Ignore cached responses and fetch from the API")
  .option(
    "--workflow-filter <words>",
    "Comma-separated list of keywords that identify deployment workflows",
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

type RawRepoEntry =
  | string
  | {
      slug?: string;
      repo?: string;
      method?: CollectionMethod;
      actions?: {
        workflowKeywords?: string[];
        events?: string[];
        branch?: string | null;
      };
    };

async function readReposFromFile(filePath: string): Promise<RawRepoEntry[]> {
  const resolved = path.resolve(filePath);
  if (!(await fs.pathExists(resolved))) {
    throw new Error(`Repo list file not found: ${resolved}`);
  }
  const raw = await fs.readFile(resolved, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Repo list file must contain a JSON array");
  }
  return parsed as RawRepoEntry[];
}

function normalizeRepoSlug(slug: string): RepoSlug {
  const [owner, name] = slug.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo slug: ${slug}`);
  }
  return { owner, name };
}

function normalizeWorkflowKeywords(keywords: string[] | undefined, defaults: string[]): string[] {
  const source = keywords && keywords.length > 0 ? keywords : defaults;
  return source.map((keyword) => keyword.toLowerCase());
}

function normalizeEvents(events?: string[]): string[] | undefined {
  if (!events || events.length === 0) {
    return undefined;
  }
  return events.map((event) => event.toLowerCase());
}

function toRepoConfig(entry: RawRepoEntry, defaults: { workflowKeywords: string[] }): RepoConfig {
  const slug = typeof entry === "string" ? entry : entry.slug ?? entry.repo;
  if (!slug) {
    throw new Error("Repository entry is missing a 'slug' field (owner/name)");
  }

  const method: CollectionMethod = typeof entry === "object" && entry !== null && entry.method ? entry.method : "actions";

  if (method !== "actions") {
    throw new Error(
      `Collection method '${method}' is not implemented yet. Supported methods: actions`
    );
  }

  const actionsConfig = typeof entry === "object" && entry !== null ? entry.actions ?? {} : {};

  const slugParts = normalizeRepoSlug(slug);
  return {
    slug,
    owner: slugParts.owner,
    name: slugParts.name,
    method: "actions",
    actions: {
      workflowKeywords: normalizeWorkflowKeywords(actionsConfig.workflowKeywords, defaults.workflowKeywords),
      events: normalizeEvents(actionsConfig.events),
      branch: actionsConfig.branch ?? null,
    },
  };
}

async function collectMetadata(octokit: Octokit, slug: RepoSlug): Promise<RepoMetadata> {
  const { data } = await octokit.repos.get({ owner: slug.owner, repo: slug.name });
  return {
    id: data.id,
    name: data.name,
    fullName: data.full_name,
    description: data.description,
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch,
    language: data.language,
    stargazersCount: data.stargazers_count,
    forksCount: data.forks_count,
    openIssuesCount: data.open_issues_count,
    pushedAt: data.pushed_at,
  };
}

async function collectWorkflowRuns(
  octokit: Octokit,
  slug: RepoSlug,
  windowStart: string,
  windowEnd: string,
  workflowNameIncludes: string[],
  events: string[] | undefined,
  branch: string | null,
  debug: boolean
): Promise<WorkflowRunSummary[]> {
  if (debug) {
    console.log(`[${slug.owner}/${slug.name}] debug logging enabled for workflow run filtering`);
  }
  const windowStartDate = new Date(windowStart);
  const windowEndDate = new Date(windowEnd);

  if (Number.isNaN(windowStartDate.getTime()) || Number.isNaN(windowEndDate.getTime())) {
    throw new Error("Invalid window start or end timestamp supplied to workflow run collector");
  }

  const runs = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
    owner: slug.owner,
    repo: slug.name,
    per_page: 100,
    created: `${windowStart}..${windowEnd}`,
  });

  const keywords = workflowNameIncludes.map((word) => word.toLowerCase());

  if (debug) {
    console.log(
      `[${slug.owner}/${slug.name}] inspecting ${runs.length} workflow runs between ${windowStart} and ${windowEnd}`
    );
  }

  const selected: WorkflowRunSummary[] = [];

  for (const run of runs) {
    const logPrefix = `[${slug.owner}/${slug.name}] workflow#${run.id}`;
    if (run.status !== "completed" || run.conclusion !== "success") {
      if (debug) {
        console.log(`${logPrefix} ⏭️  skipped (status=${run.status}, conclusion=${run.conclusion})`);
      }
      continue;
    }

    if (!run.created_at) {
      if (debug) {
        console.log(`${logPrefix} ⏭️  skipped (missing created_at)`);
      }
      continue;
    }

    const createdAt = new Date(run.created_at);
    if (createdAt < windowStartDate || createdAt > windowEndDate) {
      if (debug) {
        console.log(`${logPrefix} ⏭️  skipped (outside window ${windowStart}..${windowEnd})`);
      }
      continue;
    }

    const target = `${run.name ?? ""} ${run.display_title ?? ""}`.toLowerCase();
    const matchedKeyword = keywords.find((keyword) => target.includes(keyword));
    if (!matchedKeyword) {
      if (debug) {
        console.log(`${logPrefix} ⏭️  skipped (no keyword match) title="${run.display_title ?? run.name ?? ""}")`);
      }
      continue;
    }

    if (events && events.length > 0) {
      const eventName = (run.event ?? "").toLowerCase();
      if (!events.includes(eventName)) {
        if (debug) {
          console.log(`${logPrefix} ⏭️  skipped (event '${eventName}' not in ${events.join(", ")})`);
        }
        continue;
      }
    }

    if (branch) {
      const headBranch = run.head_branch ?? null;
      const normalized = branch.startsWith("refs/") ? branch : branch;
      const trimmed = normalized.replace(/^refs\/heads\//, "");
      const allowedBranches = new Set<string>([
        branch,
        normalized,
        trimmed,
        `refs/heads/${trimmed}`,
      ]);

      if (!headBranch || !allowedBranches.has(headBranch)) {
        if (debug) {
          console.log(`${logPrefix} ⏭️  skipped (head branch '${headBranch ?? "unknown"}' not matching '${Array.from(allowedBranches).join(", ")}')`);
        }
        continue;
      }
    }

    const summary: WorkflowRunSummary = {
      id: run.id,
      name: run.name ?? "",
      displayTitle: run.display_title ?? "",
      event: run.event ?? "",
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      createdAt: run.created_at ?? "",
      updatedAt: run.updated_at ?? "",
      runAttempt: run.run_attempt,
      headBranch: run.head_branch ?? null,
      headSha: run.head_sha ?? null,
    };

    selected.push(summary);

    if (debug) {
      console.log(
        `${logPrefix} ✅ counted (created=${summary.createdAt}, event=${summary.event}, matched="${matchedKeyword}") title="${summary.displayTitle}"
`      );
    }
  }

  if (debug) {
    console.log(
      `[${slug.owner}/${slug.name}] → ${selected.length} deployment-like runs between ${windowStart} and ${windowEnd}`
    );
  }

  return selected;
}

async function collectPullRequests(
  graphqlClient: typeof graphql,
  slug: RepoSlug,
  windowStart: string,
  baseRef: string
): Promise<PullRequestSummary[]> {
  const results: PullRequestSummary[] = [];
  let cursor: string | null = null;
  const windowStartDate = new Date(windowStart);

  // GraphQL query returns PRs merged into target branch ordered by newest
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
      owner: slug.owner,
      name: slug.name,
      base: baseRef,
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

async function ensureRepoDir(outputDir: string, slug: RepoSlug): Promise<string> {
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

  const rawEntries: RawRepoEntry[] = [];
  if (options.repo) {
    rawEntries.push(...options.repo);
  }
  if (options.input) {
    const fromFile = await readReposFromFile(options.input);
    rawEntries.push(...fromFile);
  }

  if (rawEntries.length === 0) {
    throw new Error("No repositories specified. Use --repo or --input.");
  }

  const repoMap = new Map<string, RepoConfig>();
  for (const entry of rawEntries) {
    const repoConfig = toRepoConfig(entry, { workflowKeywords: options.workflowFilter });
    repoMap.set(repoConfig.slug.toLowerCase(), repoConfig);
  }

  const repoConfigs = Array.from(repoMap.values());

  const config: CollectorConfig = {
    repos: repoConfigs,
    days: options.days,
    forceRefresh: Boolean(options.refresh),
    outputDir: options.output,
    debug: Boolean(options.debug),
  };

  const octokit = new Octokit({ auth: token });
  const graphqlClient = graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });

  const nowIso = new Date().toISOString().split(".")[0] + "Z";
  const windowStart = new Date(Date.now() - config.days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split(".")[0] + "Z"; // drop milliseconds for compatibility

  const summary: { repo: string; pullRequests: number; workflows: number; cached: boolean }[] = [];

  for (const repoConfig of config.repos) {
    const slug: RepoSlug = { owner: repoConfig.owner, name: repoConfig.name };
    const repoDir = await ensureRepoDir(config.outputDir, slug);

    console.log(`\n⏳ Collecting ${slug.owner}/${slug.name} [method=${repoConfig.method}]`);

    const metadataPath = path.join(repoDir, "metadata.json");
    let metadata: RepoMetadata;
    const cachedMetadata = await maybeReadCache<RepoMetadataCache>(metadataPath, config.forceRefresh);
    if (cachedMetadata) {
      metadata = cachedMetadata.metadata;
    } else {
      metadata = await collectMetadata(octokit, slug);
      await writeJson(metadataPath, { fetchedAt: new Date().toISOString(), metadata });
    }

    const workflowPath = path.join(repoDir, "workflow-runs.json");
    let workflowPayload = await maybeReadCache<{ runs: WorkflowRunSummary[] }>(workflowPath, config.forceRefresh);
    if (!workflowPayload) {
      if (repoConfig.method !== "actions") {
        throw new Error(
          `Repository ${repoConfig.slug} configured with method '${repoConfig.method}' which is not implemented yet.`
        );
      }

      const runs = await collectWorkflowRuns(
        octokit,
        slug,
        windowStart,
        nowIso,
        repoConfig.actions.workflowKeywords,
        repoConfig.actions.events,
        repoConfig.actions.branch,
        config.debug
      );
      workflowPayload = { runs };
      await writeJson(workflowPath, { fetchedAt: new Date().toISOString(), windowStart, windowEnd: nowIso, runs });
    }

    const defaultBranch = metadata.defaultBranch;
    const prPath = path.join(repoDir, "pull-requests.json");
    let prPayload = await maybeReadCache<{ pullRequests: PullRequestSummary[] }>(prPath, config.forceRefresh);
    if (!prPayload) {
      const prs = await collectPullRequests(graphqlClient, slug, windowStart, defaultBranch);
      prPayload = { pullRequests: prs };
      await writeJson(prPath, {
        fetchedAt: new Date().toISOString(),
        windowStart,
        windowEnd: nowIso,
        baseBranch: defaultBranch,
        pullRequests: prs,
      });
    }

    summary.push({
      repo: metadata.fullName,
      pullRequests: prPayload.pullRequests.length,
      workflows: workflowPayload.runs.length,
      cached: !config.forceRefresh,
    });
  }

  console.log("\n✅ Collection complete:");
  for (const item of summary) {
    console.log(`  • ${item.repo}: ${item.pullRequests} PRs, ${item.workflows} deployment runs`);
  }
}

run().catch((error) => {
  console.error("\n❌ Collector failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
