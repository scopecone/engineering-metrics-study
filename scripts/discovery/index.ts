#!/usr/bin/env node
import { Command } from "commander";
import "dotenv/config";
import { Octokit } from "@octokit/rest";
import Table from "cli-table3";

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

interface RecommendationResult {
  repo: RepoSummary;
  releases: ReleaseInsight;
  deployments: DeploymentInsight;
  actions: ActionsInsight;
  recommendedMethod: "releases" | "deployments" | "actions";
  notes: string[];
}

const DEFAULT_KEYWORDS = ["deploy", "release", "publish"];
const DEFAULT_EXCLUDE_TOPICS = ["awesome", "awesome-list", "list", "manual", "books"];
const DEFAULT_EXCLUDE_KEYWORDS = ["curated list", "handbook", "interview questions", "awesome"];
const RELEASE_SIGNAL_THRESHOLD = 3;
const DEPLOY_SIGNAL_THRESHOLD = 3;

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

async function analyseRepo(
  octokit: Octokit,
  repo: RepoSummary,
  keywords: string[],
  windowStart: Date,
  windowEnd: Date
): Promise<RecommendationResult> {
  const releases = await inspectReleases(octokit, repo.owner, repo.name, windowStart, windowEnd);
  if (releases.count >= RELEASE_SIGNAL_THRESHOLD) {
    const recommendation = decideRecommendation(releases, { count: 0, environments: [] }, {
      count: 0,
      keywordsHit: Object.fromEntries(keywords.map((k) => [k.toLowerCase(), 0])),
    });

    return {
      repo,
      releases,
      deployments: { count: 0, environments: [] },
      actions: { count: 0, keywordsHit: Object.fromEntries(keywords.map((k) => [k.toLowerCase(), 0])) },
      recommendedMethod: recommendation.method,
      notes: recommendation.notes,
    };
  }

  const deployments = await inspectDeployments(octokit, repo.owner, repo.name, windowStart, windowEnd);
  if (deployments.count >= DEPLOY_SIGNAL_THRESHOLD) {
    const recommendation = decideRecommendation(releases, deployments, {
      count: 0,
      keywordsHit: Object.fromEntries(keywords.map((k) => [k.toLowerCase(), 0])),
    });

    return {
      repo,
      releases,
      deployments,
      actions: { count: 0, keywordsHit: Object.fromEntries(keywords.map((k) => [k.toLowerCase(), 0])) },
      recommendedMethod: recommendation.method,
      notes: recommendation.notes,
    };
  }

  const actions = await inspectActions(octokit, repo.owner, repo.name, keywords, windowStart, windowEnd);

  const recommendation = decideRecommendation(releases, deployments, actions);

  return {
    repo,
    releases,
    deployments,
    actions,
    recommendedMethod: recommendation.method,
    notes: recommendation.notes,
  };
}

function outputResults(results: RecommendationResult[], format: string) {
  if (format === "json") {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    return;
  }

  const table = new Table({
    head: ["Repo", "Stars", "Recommendation", "Releases", "Deployments", "Actions"]
  });

  for (const result of results) {
    table.push([
      result.repo.fullName,
      result.repo.stars,
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
    ]);
  }

  console.log(table.toString());
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
  }>();

  const topics = options.topic ?? [];
  if (topics.length === 0) {
    throw new Error("At least one --topic is required");
  }

  const token = ensureToken();
  const octokit = new Octokit({ auth: token });
  const windowEnd = new Date();
  const windowStart = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);

  const results: RecommendationResult[] = [];

  for (const topic of topics) {
    console.log(`\n🔍 Topic: ${topic}`);
    const repos = await fetchTopicRepos(octokit, topic, options.limit);
    for (const repo of repos) {
      const skipCheck = shouldSkipRepo(repo, options.excludeTopics, options.excludeKeywords);
      if (skipCheck.skip) {
        console.log(
          `  Skipping ${repo.fullName} (filtered by ${skipCheck.reasons.join("; ")})`
        );
        continue;
      }
      console.log(`  Analysing ${repo.fullName}…`);
      const result = await analyseRepo(octokit, repo, options.keywords, windowStart, windowEnd);
      results.push(result);
    }
  }

  outputResults(results, options.format);
}

run().catch((error) => {
  console.error("\n❌ Discovery failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
