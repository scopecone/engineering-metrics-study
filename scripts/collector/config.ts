import fs from "fs-extra";
import path from "node:path";
import type { RepoConfig, ActionsCollectionOptions, CollectionMethod } from "./types";

export type RawRepoEntry =
  | string
  | {
      slug?: string;
      repo?: string;
      method?: CollectionMethod;
      actions?: {
        workflowKeywords?: string[];
        workflowId?: number;
        events?: string[];
        branch?: string | null;
      };
      deployments?: {
        environments?: string[];
        statuses?: string[];
      };
      releases?: {
        includePrereleases?: boolean;
        tagPattern?: string | null;
      };
    };

export async function readRepoEntries(filePath: string): Promise<RawRepoEntry[]> {
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

function normalizeRepoSlug(slug: string): { owner: string; name: string } {
  const [owner, name] = slug.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo slug: ${slug}`);
  }
  return { owner, name };
}

function normalizeWorkflowKeywords(keywords: string[] | undefined, defaults: string[]): string[] {
  if (Array.isArray(keywords)) {
    return keywords.map((keyword) => keyword.toLowerCase());
  }
  return defaults.map((keyword) => keyword.toLowerCase());
}

function normalizeEvents(events?: string[]): string[] | undefined {
  if (!events || events.length === 0) {
    return undefined;
  }
  return events.map((event) => event.toLowerCase());
}

function normalizeActionsOptions(
  options: RawRepoEntry extends infer R
    ? R extends { actions?: ActionsCollectionOptions }
      ? R["actions"]
      : never
    : never,
  defaults: string[]
): ActionsCollectionOptions {
  const normalized = options ?? {};
  return {
    workflowKeywords: normalizeWorkflowKeywords(normalized.workflowKeywords, defaults),
    workflowId: typeof normalized.workflowId === "number" ? normalized.workflowId : undefined,
    events: normalizeEvents(normalized.events),
    branch: normalized.branch ?? null,
  };
}

export function toRepoConfig(
  entry: RawRepoEntry,
  defaults: { workflowKeywords: string[] }
): RepoConfig {
  const slug = typeof entry === "string" ? entry : entry.slug ?? entry.repo;
  if (!slug) {
    throw new Error("Repository entry is missing a 'slug' field (owner/name)");
  }

  const method: CollectionMethod =
    typeof entry === "object" && entry !== null && entry.method ? entry.method : "actions";

  const { owner, name } = normalizeRepoSlug(slug);

  if (method === "actions") {
    const actionsOptions =
      typeof entry === "object" && entry !== null ? entry.actions ?? {} : {};
    return {
      slug,
      owner,
      name,
      method,
      actions: normalizeActionsOptions(actionsOptions, defaults.workflowKeywords),
    };
  }

  if (method === "deployments" || method === "releases") {
    return {
      slug,
      owner,
      name,
      method,
      actions: undefined,
      deployments:
        method === "deployments"
          ? typeof entry === "object" && entry !== null
            ? entry.deployments ?? {}
            : {}
          : undefined,
      releases:
        method === "releases"
          ? typeof entry === "object" && entry !== null
            ? entry.releases ?? {}
            : {}
          : undefined,
    };
  }

  throw new Error(`Unsupported collection method '${method}'`);
}

export function mergeRepoEntries(
  entries: RawRepoEntry[],
  defaults: { workflowKeywords: string[] }
): RepoConfig[] {
  const repoMap = new Map<string, RepoConfig>();
  for (const entry of entries) {
    const config = toRepoConfig(entry, defaults);
    repoMap.set(config.slug.toLowerCase(), config);
  }
  return Array.from(repoMap.values());
}
