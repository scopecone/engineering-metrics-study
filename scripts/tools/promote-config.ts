#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RepoConfig } from "../collector/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

const DEFAULT_SAMPLE_PATH = path.join(PROJECT_ROOT, "config", "repos.sample.json");
const DEFAULT_DISCOVERY_PATH = path.join(PROJECT_ROOT, "config", "repos.discovery.json");

interface MergeConfigResult {
  merged: RepoConfig[];
  added: RepoConfig[];
  skipped: string[];
}

function normalizeSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed.includes("/")) {
    throw new Error(`Invalid slug '${slug}'. Expected owner/name.`);
  }
  return trimmed;
}

function sortConfigs(configs: RepoConfig[]): RepoConfig[] {
  return [...configs].sort((a, b) => a.slug.toLowerCase().localeCompare(b.slug.toLowerCase()));
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    return await fs.readJson(filePath);
  } catch (error) {
    throw new Error(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeJson(filePath, value, { spaces: 2 });
  // Ensure trailing newline for readability
  await fs.appendFile(filePath, "\n");
}

function mergeConfigs(base: RepoConfig[], incoming: RepoConfig[]): MergeConfigResult {
  const existingMap = new Map<string, RepoConfig>();
  for (const item of base) {
    existingMap.set(item.slug.toLowerCase(), item);
  }

  const added: RepoConfig[] = [];
  const skipped: string[] = [];

  for (const candidate of incoming) {
    const normalizedSlug = normalizeSlug(candidate.slug);
    const key = normalizedSlug.toLowerCase();

    if (existingMap.has(key)) {
      skipped.push(normalizedSlug);
      continue;
    }

    const entry: RepoConfig = {
      ...candidate,
      slug: normalizedSlug,
    };

    added.push(entry);
    existingMap.set(key, entry);
  }

  const merged = sortConfigs([...existingMap.values()]);

  return { merged, added, skipped };
}

async function performMerge(
  samplePath: string,
  discoveryPath: string | null,
  validationEntries: RepoConfig[],
  options: { label?: string; updateDiscovery: boolean }
): Promise<{
  mergedSample: RepoConfig[];
  addedSample: RepoConfig[];
  skippedSample: string[];
  mergedDiscovery: RepoConfig[] | null;
  addedDiscovery: RepoConfig[];
  skippedDiscovery: string[];
}> {
  const sampleConfigs = await readJsonFile<RepoConfig[]>(samplePath);

  const sampleMergeResult = mergeConfigs(sampleConfigs, validationEntries);

  if (!options.updateDiscovery || !discoveryPath) {
    return {
      mergedSample: sampleMergeResult.merged,
      addedSample: sampleMergeResult.added,
      skippedSample: sampleMergeResult.skipped,
      mergedDiscovery: null,
      addedDiscovery: [],
      skippedDiscovery: [],
    };
  }

  const discoveryConfigs = await readJsonFile<RepoConfig[]>(discoveryPath);
  const discoveryMerge = mergeConfigs(discoveryConfigs, validationEntries);

  return {
    mergedSample: sampleMergeResult.merged,
    addedSample: sampleMergeResult.added,
    skippedSample: sampleMergeResult.skipped,
    mergedDiscovery: discoveryMerge.merged,
    addedDiscovery: discoveryMerge.added,
    skippedDiscovery: discoveryMerge.skipped,
  };
}

async function loadValidationEntries(validationPath: string): Promise<RepoConfig[]> {
  const raw = await readJsonFile<RepoConfig[]>(validationPath);
  return raw.map((entry) => ({
    ...entry,
    slug: normalizeSlug(entry.slug ?? (entry as any).repo ?? ""),
  }));
}

export { mergeConfigs, normalizeSlug, sortConfigs, performMerge, loadValidationEntries };

async function main() {
  const program = new Command();

  program
    .description("Merge validated repo configs into the main samples (with optional discovery update)")
    .requiredOption("-i, --input <path>", "Path to validation config JSON")
    .option("--sample <path>", "Path to repos.sample.json", DEFAULT_SAMPLE_PATH)
    .option("--discovery <path>", "Path to repos.discovery.json", DEFAULT_DISCOVERY_PATH)
    .option("--label <note>", "Label to annotate console output")
    .option("--apply", "Write changes to disk", false)
    .option("--update-discovery", "Also append entries to repos.discovery.json", false)
    .option("--quiet", "Suppress detailed output; only show summary", false)
    .parse(process.argv);

  const opts = program.opts<{
    input: string;
    sample: string;
    discovery: string;
    label?: string;
    apply: boolean;
    updateDiscovery: boolean;
    quiet: boolean;
  }>();

  const validationPath = path.resolve(opts.input);
  const samplePath = path.resolve(opts.sample);
  const discoveryPath = opts.updateDiscovery ? path.resolve(opts.discovery) : null;

  const validationEntries = await loadValidationEntries(validationPath);
  if (validationEntries.length === 0) {
    console.log(`⚠️  Validation file '${validationPath}' contained no entries.`);
    return;
  }

  const mergeOutcome = await performMerge(samplePath, discoveryPath, validationEntries, {
    label: opts.label,
    updateDiscovery: opts.updateDiscovery,
  });

  if (!opts.apply) {
    console.log(`
📋 Dry run – no files written.`);
  }

  const labelSuffix = opts.label ? ` [${opts.label}]` : "";

  if (!opts.quiet) {
    console.log(`
📦 Validation entries${labelSuffix}: ${validationEntries.length}`);
    console.log(`  ➕ Sample additions: ${mergeOutcome.addedSample.length}`);
    if (mergeOutcome.addedSample.length > 0) {
      for (const entry of mergeOutcome.addedSample) {
        console.log(`    • ${entry.slug} (${entry.method})`);
      }
    }
    console.log(`  ⏭️  Already present: ${mergeOutcome.skippedSample.length}`);
    if (mergeOutcome.skippedSample.length > 0) {
      for (const slug of mergeOutcome.skippedSample) {
        console.log(`    • ${slug}`);
      }
    }

    if (opts.updateDiscovery) {
      console.log(`  📚 Discovery additions: ${mergeOutcome.addedDiscovery.length}`);
    }
  }

  if (opts.apply) {
    await writeJsonFile(samplePath, mergeOutcome.mergedSample);
    if (opts.updateDiscovery && discoveryPath && mergeOutcome.mergedDiscovery) {
      await writeJsonFile(discoveryPath, mergeOutcome.mergedDiscovery);
    }
    console.log(`
✅ Promotion complete. Updated ${path.relative(PROJECT_ROOT, samplePath)}${opts.updateDiscovery && discoveryPath ? ` and ${path.relative(PROJECT_ROOT, discoveryPath)}` : ""}.`);
  } else {
    console.log(`
ℹ️  Dry run complete. Re-run with --apply to persist changes.`);
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
    console.error("\n❌ Promotion failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
