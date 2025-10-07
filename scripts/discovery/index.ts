#!/usr/bin/env node
import { Command } from "commander";
import "dotenv/config";
import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import Table from "cli-table3";
import fs from "fs-extra";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";

interface RepoSummary {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  stars: number;
  defaultBranch: string;
  topics: string[];
}

interface ReleaseInsight {
  count: number;
  tags: string[];
}

interface DeploymentInsight {
  count: number;
  environments: string[];
}

interface ActionsInsight {
  count: number;
  keywordsHit: Record<string, number>;
}

interface ActivityInsight {
  commits90d: number;
  mergedPRs180d: number;
  lastCommitAt: string | null;
  lastMergedPRAt: string | null;
}

interface RecommendationResult {
  repo: RepoSummary;
  releases: ReleaseInsight;
  deployments: DeploymentInsight;
  actions: ActionsInsight;
  recommendedMethod: "releases" | "deployments" | "actions";
  notes: string[];
  activity: ActivityInsight;
  status: "accepted" | "excluded";
  exclusionReason?: string;
}

interface ValidationWriteOptions {
  outputPath: string;
  append: boolean;
  samplePath: string;
  defaultKeywords: string[];
}

const DEFAULT_KEYWORDS = ["deploy", "release", "publish"];
const DEFAULT_EXCLUDE_TOPICS = ["awesome", "awesome-list", "list", "manual", "books"];
const DEFAULT_EXCLUDE_KEYWORDS = ["curated list", "handbook", "interview questions", "awesome"];
const RELEASE_SIGNAL_THRESHOLD = 3;
const DEPLOY_SIGNAL_THRESHOLD = 3;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_VERSION = 1;

const program = new Command();

program
  .description("Discover candidate repositories per topic and recommend collection methods")
  .option("-t, --topic <name>", "GitHub topic to inspect", (value, previous: string[] = []) => {
    previous.push(value);
    return previous;
  })
  .option("-l, --limit <number>", "Repositories per topic", (value) => Number.parseInt(value, 10), 5)
  .option("-d, --days <number>", "Lookback window in days", (value) => Number.parseInt(value, 10), 60)
  .option(
    "--keywords <list>",
    "Comma-separated workflow keywords to inspect",
    (value) => value.split(",").map((item) => item.trim()).filter(Boolean),
    DEFAULT_KEYWORDS
  )
  .option(
    "--exclude-topics <list>",
    "Comma-separated list of topics to skip (default: awesome,awesome-list,list,manual,books)",
    (value) => value.split(",").map((item) => item.trim()).filter(Boolean),
    DEFAULT_EXCLUDE_TOPICS
  )
  .option(
    "--exclude-keywords <list>",
    "Comma-separated substrings; repos whose description matches are skipped",
    (value) => value.split(",").map((item) => item.trim()).filter(Boolean),
    DEFAULT_EXCLUDE_KEYWORDS
  )
  .option("--holdout <path>", "JSON file containing repo slugs to exclude (reason optional)")
  .option(
    "--cache-dir <path>",
    "Directory to cache discovery results",
    path.resolve(process.cwd(), "tmp/discovery-cache")
  )
  .option(
    "--cache-ttl <hours>",
    "Hours before cache entries expire (default 24)",
    (value) => Number.parseInt(value, 10),
    24
  )
  .option("--min-commits <number>", "Minimum commits on default branch in last 90 days", (value) => Number.parseInt(value, 10), 5)
  .option("--min-prs <number>", "Minimum merged PRs in last 180 days", (value) => Number.parseInt(value, 10), 10)
  .option("--include-low-activity", "Do not exclude repos that fail activity thresholds", false)
  .option("--write-validation <path>", "Write accepted repos to a validation config file")
  .option("--append-validation", "Append to validation file instead of overwriting", false)
  .option(
    "--existing-sample <path>",
    "Path to repos.sample.json for deduplication",
    path.resolve(process.cwd(), "config/repos.sample.json")
  )
  .option("-f, --format <type>", "Output format: json or table", "table")
  .parse(process.argv);

function ensureToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for discovery. Set it via environment variable or .env file.");
  }
  return token;
}

function withinWindow(timestamp: string | null | undefined, start: Date, end: Date): boolean {
  if (!timestamp) {
    return false;
  }
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    return false;
  }
  return value >= start && value <= end;
}

async function fetchTopicRepos(
  octokit: Octokit,
  topic: string,
  limit: number
): Promise<RepoSummary[]> {
  const query = `topic:${topic}`;
  const { data } = await octokit.search.repos({
    q: query,
    sort: "stars",
    order: "desc",
    per_page: limit,
  });

  return data.items.map((item) => ({
    owner: item.owner?.login ?? "",
    name: item.name,
    fullName: item.full_name,
    description: item.description,
    stars: item.stargazers_count,
    defaultBranch: item.default_branch,
    topics: item.topics ?? [],
  }));
}

function shouldSkipRepo(
  repo: RepoSummary,
  excludeTopics: string[],
  excludeKeywords: string[]
): { skip: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const normalizedTopics = repo.topics.map((topic) => topic.toLowerCase());
  const topicMatches = excludeTopics
    .map((topic) => topic.toLowerCase())
    .filter((topic) => normalizedTopics.includes(topic));
  if (topicMatches.length > 0) {
    reasons.push(`topics: ${topicMatches.join(", ")}`);
  }

  const haystack = `${repo.description ?? ""} ${repo.name}`.toLowerCase();
  const keywordMatches = excludeKeywords
    .map((keyword) => keyword.toLowerCase())
    .filter((keyword) => keyword.length > 0 && haystack.includes(keyword));
  if (keywordMatches.length > 0) {
    reasons.push(`keywords: ${keywordMatches.join(", ")}`);
  }

  return { skip: reasons.length > 0, reasons };
}

async function inspectReleases(
  octokit: Octokit,
  owner: string,
  repo: string,
  windowStart: Date,
  windowEnd: Date
): Promise<ReleaseInsight> {
  const { data } = await octokit.repos.listReleases({ owner, repo, per_page: 20 });

  const tags: string[] = [];
  let count = 0;
  for (const release of data) {
    const publishedAt = release.published_at ?? release.created_at;
    if (!withinWindow(publishedAt, windowStart, windowEnd)) {
      if (publishedAt && new Date(publishedAt) < windowStart) {
        break;
      }
      continue;
    }
    count += 1;
    if (release.tag_name && tags.length < 5) {
      tags.push(release.tag_name);
    }
    if (count >= RELEASE_SIGNAL_THRESHOLD) {
      break;
    }
  }

  return { count, tags };
}

async function inspectDeployments(
  octokit: Octokit,
  owner: string,
  repo: string,
  windowStart: Date,
  windowEnd: Date
): Promise<DeploymentInsight> {
  try {
    const { data } = await octokit.repos.listDeployments({ owner, repo, per_page: 20 });

    let count = 0;
    const environments = new Set<string>();

    for (const deployment of data) {
      if (!withinWindow(deployment.created_at ?? deployment.updated_at, windowStart, windowEnd)) {
        continue;
      }
      count += 1;
      if (deployment.environment) {
        environments.add(deployment.environment);
      }
      if (count >= DEPLOY_SIGNAL_THRESHOLD) {
        break;
      }
    }

    return { count, environments: Array.from(environments).slice(0, 5) };
  } catch (error) {
    if (process.env.DEBUG_DISCOVERY) {
      console.error(`[deployments] Failed for ${owner}/${repo}:`, error);
    }
    return { count: 0, environments: [] };
  }
}

async function inspectActions(
  octokit: Octokit,
  owner: string,
  repo: string,
  keywords: string[],
  windowStart: Date,
  windowEnd: Date
): Promise<ActionsInsight> {
  try {
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 20,
      created: `${windowStart.toISOString().split(".")[0]}Z..${windowEnd.toISOString().split(".")[0]}Z`,
    });

    const lowerKeywords = keywords.map((keyword) => keyword.toLowerCase());
    const keywordHits: Record<string, number> = Object.fromEntries(lowerKeywords.map((k) => [k, 0]));
    let count = 0;

    for (const run of data) {
      if (!withinWindow(run.created_at, windowStart, windowEnd)) {
        continue;
      }
      const text = `${run.name ?? ""} ${run.display_title ?? ""}`.toLowerCase();
      const matched = lowerKeywords.some((keyword) => text.includes(keyword));
      if (matched) {
        count += 1;
        for (const keyword of lowerKeywords) {
          if (text.includes(keyword)) {
            keywordHits[keyword] += 1;
          }
        }
      }
    }

    return { count, keywordsHit: keywordHits };
  } catch (error) {
    if (process.env.DEBUG_DISCOVERY) {
      console.error(`[actions] Failed for ${owner}/${repo}:`, error);
    }
    return { count: 0, keywordsHit: Object.fromEntries(keywords.map((k) => [k.toLowerCase(), 0])) };
  }
}

function decideRecommendation(
  releases: ReleaseInsight,
  deployments: DeploymentInsight,
  actions: ActionsInsight
): { method: "releases" | "deployments" | "actions"; notes: string[] } {
  const notes: string[] = [];

  if (releases.count >= 3) {
    notes.push(`Detected ${releases.count} releases in window`);
    return { method: "releases", notes };
  }

  if (deployments.count >= 3) {
    notes.push(
      `Found ${deployments.count} deployments across environments ${deployments.environments.join(", ")}`
    );
    return { method: "deployments", notes };
  }

  if (actions.count > 0) {
    notes.push(`Found ${actions.count} workflow runs matching keywords`);
  } else {
    notes.push("No releases/deployments/workflow keywords detected; defaulting to actions");
  }

  return { method: "actions", notes };
}

async function fetchActivityInsight(
  graphqlClient: ReturnType<typeof graphql.defaults>,
  octokit: Octokit,
  repo: RepoSummary,
  commitWindowStart: Date,
  prWindowStart: Date
): Promise<ActivityInsight> {
  const commitSinceIso = commitWindowStart.toISOString();
  const ACTIVITY_QUERY = /* GraphQL */ `
    query ($owner: String!, $name: String!, $since: GitTimestamp!) {
      repository(owner: $owner, name: $name) {
        defaultBranchRef {
          name
          target {
            ... on Commit {
              history(since: $since) {
                totalCount
                nodes(first: 1, orderBy: { field: COMMIT_TIME, direction: DESC }) {
                  committedDate
                }
              }
            }
          }
        }
      }
    }
  `;

  let commits90d = 0;
  let lastCommitAt: string | null = null;

  try {
    const response = await graphqlClient<{
      repository: {
        defaultBranchRef: {
          target: {
            history: {
              totalCount: number;
              nodes: Array<{ committedDate: string }>;
            };
          };
        } | null;
      } | null;
    }>(ACTIVITY_QUERY, {
      owner: repo.owner,
      name: repo.name,
      since: commitSinceIso,
    });

    commits90d = response.repository?.defaultBranchRef?.target?.history?.totalCount ?? 0;
    lastCommitAt = response.repository?.defaultBranchRef?.target?.history?.nodes?.[0]?.committedDate ?? null;
  } catch (error) {
    if (process.env.DEBUG_DISCOVERY) {
      console.error(`[activity] commit history failed for ${repo.fullName}:`, error);
    }
  }

  let mergedPRs180d = 0;
  let lastMergedPRAt: string | null = null;

  try {
    const sinceDate = prWindowStart.toISOString().split("T")[0];
    const prQuery = `repo:${repo.fullName} is:pr is:merged merged:>=${sinceDate}`;
    const { data } = await octokit.search.issuesAndPullRequests({
      q: prQuery,
      sort: "updated",
      order: "desc",
      per_page: 1,
    });
    mergedPRs180d = data.total_count ?? 0;
    if (data.items && data.items.length > 0) {
      lastMergedPRAt = data.items[0].closed_at ?? data.items[0].updated_at ?? null;
    }
  } catch (error) {
    if (process.env.DEBUG_DISCOVERY) {
      console.error(`[activity] PR search failed for ${repo.fullName}:`, error);
    }
  }

  return { commits90d, mergedPRs180d, lastCommitAt, lastMergedPRAt };
}

interface AnalyseOptions {
  keywords: string[];
  windowStart: Date;
  windowEnd: Date;
  minCommits: number;
  minPRs: number;
  includeLowActivity: boolean;
  commitWindowStart: Date;
  prWindowStart: Date;
  graphqlClient: ReturnType<typeof graphql.defaults>;
}

interface CacheEntry {
  version: number;
  generatedAt: string;
  result: RecommendationResult;
}

function buildCacheKey(
  slug: string,
  options: { days: number; keywords: string[]; minCommits: number; minPRs: number; includeLowActivity: boolean }
): string {
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify({ slug: slug.toLowerCase(), ...options }))
    .digest("hex");
  return hash;
}

async function readCache(cachePath: string, ttlMs: number): Promise<RecommendationResult | null> {
  if (!(await fs.pathExists(cachePath))) {
    return null;
  }
  try {
    const cached = await fs.readJson(cachePath);
    const entry = cached as CacheEntry;
    if (entry.version !== CACHE_VERSION) {
      return null;
    }
    const generatedAt = new Date(entry.generatedAt).getTime();
    if (Number.isNaN(generatedAt) || Date.now() - generatedAt > ttlMs) {
      return null;
    }
    return entry.result;
  } catch (error) {
    if (process.env.DEBUG_DISCOVERY) {
      console.error(`[cache] Failed to read ${cachePath}:`, error);
    }
    return null;
  }
}

async function writeCache(cachePath: string, result: RecommendationResult): Promise<void> {
  try {
    await fs.outputJson(cachePath, {
      version: CACHE_VERSION,
      generatedAt: new Date().toISOString(),
      result,
    });
  } catch (error) {
    if (process.env.DEBUG_DISCOVERY) {
      console.error(`[cache] Failed to write ${cachePath}:`, error);
    }
  }
}

async function analyseRepo(
  octokit: Octokit,
  options: AnalyseOptions,
  repo: RepoSummary,
  cacheDir: string,
  cacheTtlMs: number,
  cacheKeyOptions: { days: number; keywords: string[]; minCommits: number; minPRs: number }
): Promise<RecommendationResult> {
  await fs.ensureDir(cacheDir);
  const cacheKey = buildCacheKey(repo.fullName, cacheKeyOptions);
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);
  const cached = await readCache(cachePath, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const { keywords, windowStart, windowEnd, minCommits, minPRs, includeLowActivity, commitWindowStart, prWindowStart, graphqlClient } = options;

  const activity = await fetchActivityInsight(graphqlClient, octokit, repo, commitWindowStart, prWindowStart);

  const releases = await inspectReleases(octokit, repo.owner, repo.name, windowStart, windowEnd);
  if (releases.count >= RELEASE_SIGNAL_THRESHOLD) {
    const recommendation = decideRecommendation(releases, { count: 0, environments: [] }, {
      count: 0,
      keywordsHit: Object.fromEntries(keywords.map((k) => [k.toLowerCase(), 0])),
    });

    const status = activity.commits90d >= minCommits || activity.mergedPRs180d >= minPRs || includeLowActivity
      ? "accepted"
      : "excluded";
    const exclusionReason =
      status === "accepted"
        ? undefined
        : `low_activity(commits90d=${activity.commits90d}, mergedPRs180d=${activity.mergedPRs180d})`;

    const result: RecommendationResult = {
      repo,
      releases,
      deployments: { count: 0, environments: [] },
      actions: { count: 0, keywordsHit: Object.fromEntries(keywords.map((k) => [k.toLowerCase(), 0])) },
      recommendedMethod: recommendation.method,
      notes: recommendation.notes,
      activity,
      status,
      exclusionReason,
    };

    await writeCache(cachePath, result);
    return result;
  }

  const deployments = await inspectDeployments(octokit, repo.owner, repo.name, windowStart, windowEnd);
  if (deployments.count >= DEPLOY_SIGNAL_THRESHOLD) {
    const recommendation = decideRecommendation(releases, deployments, {
      count: 0,
      keywordsHit: Object.fromEntries(keywords.map((k) => [k.toLowerCase(), 0])),
    });

    const status = activity.commits90d >= minCommits || activity.mergedPRs180d >= minPRs || includeLowActivity
      ? "accepted"
      : "excluded";
    const exclusionReason =
      status === "accepted"
        ? undefined
        : `low_activity(commits90d=${activity.commits90d}, mergedPRs180d=${activity.mergedPRs180d})`;

    const result: RecommendationResult = {
      repo,
      releases,
      deployments,
      actions: { count: 0, keywordsHit: Object.fromEntries(keywords.map((k) => [k.toLowerCase(), 0])) },
      recommendedMethod: recommendation.method,
      notes: recommendation.notes,
      activity,
      status,
      exclusionReason,
    };

    await writeCache(cachePath, result);
    return result;
  }

  const actions = await inspectActions(octokit, repo.owner, repo.name, keywords, windowStart, windowEnd);

  const recommendation = decideRecommendation(releases, deployments, actions);

  const status = activity.commits90d >= minCommits || activity.mergedPRs180d >= minPRs || includeLowActivity
    ? "accepted"
    : "excluded";
  const exclusionReason =
    status === "accepted"
      ? undefined
      : `low_activity(commits90d=${activity.commits90d}, mergedPRs180d=${activity.mergedPRs180d})`;

  const result: RecommendationResult = {
    repo,
    releases,
    deployments,
    actions,
    recommendedMethod: recommendation.method,
    notes: recommendation.notes,
    activity,
    status,
    exclusionReason,
  };

  await writeCache(cachePath, result);
  return result;
}

function outputResults(results: RecommendationResult[], format: string) {
  if (format === "json") {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    return;
  }

  const table = new Table({
    head: ["Repo", "Stars", "Status", "Recommendation", "Releases", "Deployments", "Actions", "Activity"]
  });

  for (const result of results) {
    table.push([
      result.repo.fullName,
      result.repo.stars,
      result.status === "accepted" ? "✅" : `⏭️ ${result.exclusionReason ?? "excluded"}`,
      `${result.recommendedMethod}\n${result.notes.join("; ")}`,
      result.releases.count
        ? `${result.releases.count} tags: ${result.releases.tags.slice(0, 3).join(", ")}`
        : "0",
      result.deployments.count
        ? `${result.deployments.count} envs: ${result.deployments.environments.join(", ")}`
        : "0",
      result.actions.count
        ? `${result.actions.count} runs (keywords)`
        : "0",
      `commits90d=${result.activity.commits90d}\nprs180d=${result.activity.mergedPRs180d}`,
    ]);
  }

  console.log(table.toString());
}

async function loadExistingSlugs(samplePath: string): Promise<Set<string>> {
  try {
    const data = await fs.readJson(samplePath);
    if (!Array.isArray(data)) {
      return new Set();
    }
    const slugs = data
      .map((entry) => (entry && typeof entry.slug === "string" ? entry.slug.toLowerCase() : null))
      .filter((value): value is string => Boolean(value));
    return new Set(slugs);
  } catch {
    return new Set();
  }
}

function toValidationEntry(result: RecommendationResult, defaultKeywords: string[]): Record<string, unknown> {
  const slug = result.repo.fullName;
  const base: Record<string, unknown> = {
    slug,
    method: result.recommendedMethod,
  };

  if (result.recommendedMethod === "actions") {
    base.actions = {
      workflowKeywords: defaultKeywords.map((keyword) => keyword.toLowerCase()),
    };
  } else if (result.recommendedMethod === "deployments") {
    base.deployments = result.deployments.environments.length > 0
      ? { environments: result.deployments.environments.slice(0, 5) }
      : {};
  } else if (result.recommendedMethod === "releases") {
    base.releases = {};
  }

  return base;
}

async function writeValidationFile(
  results: RecommendationResult[],
  options: ValidationWriteOptions
): Promise<{ written: number; skipped: number }> {
  const accepted = results.filter((item) => item.status === "accepted");
  if (accepted.length === 0) {
    return { written: 0, skipped: 0 };
  }

  const sampleSlugs = await loadExistingSlugs(options.samplePath);

  let existingEntries: Record<string, unknown>[] = [];
  const validationPath = path.resolve(options.outputPath);
  if (options.append && (await fs.pathExists(validationPath))) {
    try {
      const data = await fs.readJson(validationPath);
      if (Array.isArray(data)) {
        existingEntries = data;
      }
    } catch {
      existingEntries = [];
    }
  }

  const existingValidationSlugs = new Set(
    existingEntries
      .map((entry) => (entry && typeof entry.slug === "string" ? entry.slug.toLowerCase() : null))
      .filter((value): value is string => Boolean(value))
  );

  const additions: Record<string, unknown>[] = [];
  let skipped = 0;

  for (const item of accepted) {
    const slug = item.repo.fullName.toLowerCase();
    if (sampleSlugs.has(slug) || existingValidationSlugs.has(slug)) {
      skipped += 1;
      continue;
    }
    additions.push(toValidationEntry(item, options.defaultKeywords));
    existingValidationSlugs.add(slug);
  }

  if (additions.length === 0) {
    return { written: 0, skipped: accepted.length };
  }

  const payload = options.append ? [...existingEntries, ...additions] : additions;
  await fs.writeJson(validationPath, payload, { spaces: 2 });
  await fs.appendFile(validationPath, "\n");

  return { written: additions.length, skipped };
}

async function run() {
  const options = program.opts<{
    topic?: string[];
    limit: number;
    days: number;
    keywords: string[];
    excludeTopics: string[];
    excludeKeywords: string[];
    format: string;
    holdout?: string;
    cacheDir: string;
    cacheTtl: number;
    minCommits: number;
    minPRs: number;
    includeLowActivity: boolean;
    writeValidation?: string;
    appendValidation: boolean;
    existingSample: string;
  }>();

  const topics = options.topic ?? [];
  if (topics.length === 0) {
    throw new Error("At least one --topic is required");
  }

  const token = ensureToken();
  const octokit = new Octokit({ auth: token });
  const graphqlClient = graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });
  const windowEnd = new Date();
  const windowStart = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
  const commitWindowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const prWindowStart = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
  const cacheDir = path.isAbsolute(options.cacheDir)
    ? options.cacheDir
    : path.resolve(process.cwd(), options.cacheDir);
  const cacheTtlMs = (Number.isFinite(options.cacheTtl) ? options.cacheTtl : 24) * 60 * 60 * 1000;

  let holdoutSet = new Set<string>();
  if (options.holdout) {
    try {
      const holdoutRaw = await fs.readJson(path.resolve(process.cwd(), options.holdout));
      if (Array.isArray(holdoutRaw)) {
        holdoutSet = new Set(
          holdoutRaw.map((entry) => {
            if (typeof entry === "string") {
              return entry.toLowerCase();
            }
            if (entry && typeof entry === "object" && typeof entry.slug === "string") {
              return entry.slug.toLowerCase();
            }
            return null;
          }).filter((value): value is string => Boolean(value))
        );
      }
    } catch (error) {
      console.error(`⚠️  Failed to read holdout file '${options.holdout}':`, error instanceof Error ? error.message : error);
    }
  }

  const results: RecommendationResult[] = [];

  for (const topic of topics) {
    console.log(`\n🔍 Topic: ${topic}`);
    const repos = await fetchTopicRepos(octokit, topic, options.limit);
    for (const repo of repos) {
      if (holdoutSet.has(repo.fullName.toLowerCase())) {
        console.log(`  Skipping ${repo.fullName} (holdout list)`);
        continue;
      }
      const skipCheck = shouldSkipRepo(repo, options.excludeTopics, options.excludeKeywords);
      if (skipCheck.skip) {
        console.log(
          `  Skipping ${repo.fullName} (filtered by ${skipCheck.reasons.join("; ")})`
        );
        continue;
      }
      console.log(`  Analysing ${repo.fullName}…`);
      const result = await analyseRepo(
        octokit,
        {
          keywords: options.keywords,
          windowStart,
          windowEnd,
          minCommits: options.minCommits,
          minPRs: options.minPRs,
          includeLowActivity: Boolean(options.includeLowActivity),
          commitWindowStart,
          prWindowStart,
          graphqlClient,
        },
        repo,
        cacheDir,
        Number.isFinite(cacheTtlMs) ? cacheTtlMs : DEFAULT_CACHE_TTL_MS,
        {
          days: options.days,
          keywords: options.keywords,
          minCommits: options.minCommits,
          minPRs: options.minPRs,
          includeLowActivity: Boolean(options.includeLowActivity),
        }
      );
      results.push(result);
      if (result.status === "excluded") {
        console.log(`    ⏭️  Excluded: ${result.exclusionReason}`);
      } else {
        console.log(`    ✅ Recommended method: ${result.recommendedMethod}`);
      }
    }
  }

  if (options.writeValidation) {
    const validationPath = path.resolve(process.cwd(), options.writeValidation);
    const samplePath = path.resolve(process.cwd(), options.existingSample);
    const { written, skipped } = await writeValidationFile(results, {
      outputPath: validationPath,
      append: Boolean(options.appendValidation),
      samplePath,
      defaultKeywords: options.keywords,
    });

    console.log(`\n📝 Validation config: wrote ${written} new entr${written === 1 ? "y" : "ies"}` + (skipped > 0 ? `, skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}.` : "."));
    console.log(`   Path: ${validationPath}`);
  }

  outputResults(results, options.format);
}

const discoveryDirectInvocation = (() => {
  try {
    return pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
  } catch {
    return false;
  }
})();

if (discoveryDirectInvocation) {
  run().catch((error) => {
    console.error("\n❌ Discovery failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export { loadExistingSlugs, toValidationEntry, writeValidationFile };
