#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { Octokit } from "@octokit/rest";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RepoConfig } from "../collector/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

interface ReleaseSample {
  tag: string;
  publishedAt: string | null;
  isPrerelease: boolean;
}

interface ReleaseAnalysis {
  slug: string;
  total: number;
  prereleaseCount: number;
  distinctPrefixes: string[];
  suggestedPattern: string;
  includeRecommendation: "include" | "exclude" | "mixed";
  exampleTags: string[];
  raw: ReleaseSample[];
}

function ensureToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to inspect releases.");
  }
  return token;
}

function derivePrefix(tag: string): string {
  if (tag.startsWith("v") && /v[0-9]/.test(tag.slice(0, 2))) {
    return "v";
  }

  const matchPrefix = tag.match(/^([A-Za-z0-9-]+?)(?=\d)/);
  if (matchPrefix) {
    return matchPrefix[1];
  }

  if (/^\d{4}/.test(tag)) {
    return "year";
  }

  return "";
}

function suggestPattern(tags: string[]): string {
  if (tags.length === 0) {
    return "^";
  }

  if (tags.every((tag) => tag.startsWith("v") && /^v\d/.test(tag))) {
    return "^v";
  }

  if (tags.every((tag) => /^\d/.test(tag))) {
    // Check if tags look like timestamps (YYYY-...)
    if (tags.every((tag) => /^\d{4}-/.test(tag))) {
      return "^[0-9]{4}";
    }
    return "^[0-9]";
  }

  const prefixes = new Map<string, number>();
  for (const tag of tags) {
    const prefix = derivePrefix(tag);
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }

  // Prefer dominant non-empty prefix
  const sortedPrefixes = [...prefixes.entries()].sort((a, b) => b[1] - a[1]);
  const top = sortedPrefixes[0];
  if (top && top[0] && top[0] !== "year") {
    return `^${escapeRegex(top[0])}`;
  }

  if (top && top[0] === "year") {
    return "^[0-9]{4}";
  }

  return "^[A-Za-z0-9]";
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function recommendInclude(prereleaseCount: number, stableCount: number): "include" | "exclude" | "mixed" {
  if (stableCount === 0) {
    return prereleaseCount > 0 ? "include" : "exclude";
  }
  if (prereleaseCount === 0) {
    return "exclude";
  }
  // Mixed case – caller should decide based on project conventions
  return "mixed";
}

function analyzeReleases(slug: string, samples: ReleaseSample[]): ReleaseAnalysis {
  const tags = samples.map((release) => release.tag);
  const prereleaseCount = samples.filter((release) => release.isPrerelease).length;
  const stableCount = samples.length - prereleaseCount;

  const distinctPrefixes = Array.from(new Set(tags.map(derivePrefix))).filter((prefix) => prefix.length > 0 && prefix !== "year");

  return {
    slug,
    total: samples.length,
    prereleaseCount,
    distinctPrefixes,
    suggestedPattern: suggestPattern(tags),
    includeRecommendation: recommendInclude(prereleaseCount, stableCount),
    exampleTags: tags.slice(0, 5),
    raw: samples,
  };
}

async function fetchReleases(octokit: Octokit, owner: string, repo: string, limit: number): Promise<ReleaseSample[]> {
  const iterator = octokit.paginate.iterator(octokit.repos.listReleases, {
    owner,
    repo,
    per_page: Math.min(100, limit),
  });

  const releases: ReleaseSample[] = [];
  for await (const page of iterator) {
    for (const release of page.data) {
      if (!release.tag_name) {
        continue;
      }
      releases.push({
        tag: release.tag_name,
        publishedAt: release.published_at ?? release.created_at ?? null,
        isPrerelease: Boolean(release.prerelease),
      });
      if (releases.length >= limit) {
        return releases;
      }
    }
  }
  return releases;
}

async function loadCurrentConfig(samplePath: string, slug: string): Promise<RepoConfig | null> {
  try {
    const configs = await fs.readJson(samplePath) as RepoConfig[];
    const match = configs.find((item) => item.slug.toLowerCase() === slug.toLowerCase());
    return match ?? null;
  } catch {
    return null;
  }
}

function summarizeAnalysis(analysis: ReleaseAnalysis, config: RepoConfig | null): string {
  const stableCount = analysis.total - analysis.prereleaseCount;
  const parts = [
    `Releases sampled: ${analysis.total} (stable ${stableCount}, prerelease ${analysis.prereleaseCount})`,
    `Suggested pattern: ${analysis.suggestedPattern}`,
    `Include prereleases: ${analysis.includeRecommendation}`,
  ];

  if (analysis.distinctPrefixes.length > 0) {
    parts.push(`Prefixes: ${analysis.distinctPrefixes.join(", ")}`);
  }
  parts.push(`Sample tags: ${analysis.exampleTags.join(", ")}`);

  if (config?.releases) {
    const { includePrereleases = false, tagPattern = "(none)" } = config.releases;
    const matchesPattern = tagPattern === analysis.suggestedPattern;
    const includeState = analysis.includeRecommendation === "include" ? true : analysis.includeRecommendation === "exclude" ? false : "mixed";
    const includeMatches = includeState === "mixed" ? "mixed" : includeState === includePrereleases ? "yes" : "no";
    parts.push(`Current config – includePrereleases: ${includePrereleases} (${includeMatches}) tagPattern: ${tagPattern}${matchesPattern ? " (match)" : " (diff)"}`);
  }

  return parts.map((line) => `  ${line}`).join("\n");
}

async function main() {
  const program = new Command();

  program
    .description("Inspect recent GitHub releases and suggest config patterns")
    .requiredOption("-r, --repo <owner/name>", "Repository to inspect", (value, previous: string[] = []) => {
      previous.push(value);
      return previous;
    })
    .option("-n, --count <number>", "Number of releases to sample", (value) => Math.max(1, Number.parseInt(value, 10)), 20)
    .option("--write <path>", "Optional output directory for JSON summaries")
    .option("--validate <path>", "Path to repos.sample.json for comparison", path.join(PROJECT_ROOT, "config", "repos.sample.json"))
    .option("--json", "Emit JSON to stdout instead of human-readable output", false)
    .parse(process.argv);

  const opts = program.opts<{
    repo: string[];
    count: number;
    write?: string;
    validate?: string;
    json: boolean;
  }>();

  const token = ensureToken();
  const octokit = new Octokit({ auth: token });

  const outputDir = opts.write ? path.resolve(opts.write) : null;
  if (outputDir) {
    await fs.ensureDir(outputDir);
  }

  const analyses: ReleaseAnalysis[] = [];

  for (const slug of opts.repo) {
    const [owner, name] = slug.split("/");
    if (!owner || !name) {
      throw new Error(`Invalid repo identifier '${slug}'. Use owner/name format.`);
    }

    const releases = await fetchReleases(octokit, owner, name, opts.count);
    const analysis = analyzeReleases(slug, releases);
    analyses.push(analysis);

    if (outputDir) {
      const filePath = path.join(outputDir, `${owner.replace(/[/\\]/g, "_")}__${name.replace(/[/\\]/g, "_")}.json`);
      await fs.writeJson(filePath, analysis, { spaces: 2 });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), analyses }, null, 2));
    return;
  }

  for (const analysis of analyses) {
    console.log(`\n🔍 ${analysis.slug}`);
    const config = opts.validate ? await loadCurrentConfig(path.resolve(opts.validate), analysis.slug) : null;
    console.log(summarizeAnalysis(analysis, config));
  }
}

const directInvocation = (() => {
  try {
    return pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
  } catch {
    return false;
  }
})();

if (directInvocation) {
  main().catch((error) => {
    console.error("\n❌ Release inspection failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export { analyzeReleases, suggestPattern, derivePrefix, recommendInclude };
