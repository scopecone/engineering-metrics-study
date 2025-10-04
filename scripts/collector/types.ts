import type { Octokit } from "@octokit/rest";
import type { RateLimiter } from "./rate-limiter";

export type CollectionMethod = "actions" | "deployments" | "releases";

export interface ActionsCollectionOptions {
  workflowKeywords: string[];
  workflowId?: number;
  events?: string[];
  branch?: string | null;
}

export interface DeploymentsCollectionOptions {
  environments?: string[];
  statuses?: string[];
}

export interface ReleasesCollectionOptions {
  includePrereleases?: boolean;
  tagPattern?: string | null;
}

export interface RepoConfig {
  slug: string;
  owner: string;
  name: string;
  method: CollectionMethod;
  actions?: ActionsCollectionOptions;
  deployments?: DeploymentsCollectionOptions;
  releases?: ReleasesCollectionOptions;
}

export interface CollectorRuntimeConfig {
  repos: RepoConfig[];
  days: number;
  forceRefresh: boolean;
  outputDir: string;
  debug: boolean;
  octokit: Octokit;
  windowStart: string;
  windowEnd: string;
  rateLimiter: RateLimiter;
  graphqlClient: typeof import("@octokit/graphql").graphql;
  includeBotPRs: boolean;
  botAuthorPatterns: string[];
}

export interface DeploymentLikeEvent {
  id: string;
  source: CollectionMethod;
  name: string;
  displayTitle: string;
  event: string | null;
  status: string | null;
  conclusion: string | null;
  createdAt: string;
  completedAt: string | null;
  branch: string | null;
  sha: string | null;
  metadata?: Record<string, unknown>;
}

export interface RepoCollectionResult {
  repo: string;
  pullRequests: number;
  deploymentEvents: number;
  cached: boolean;
}
