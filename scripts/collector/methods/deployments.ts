import type { Octokit } from "@octokit/rest";

import type {
  DeploymentLikeEvent,
  CollectionMethod,
  DeploymentsCollectionOptions,
} from "../types";

const SOURCE: CollectionMethod = "deployments";

interface CollectDeploymentsParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  windowStart: string;
  windowEnd: string;
  options: DeploymentsCollectionOptions | undefined;
  debug?: boolean;
}

function buildEnvironmentFilter(environments?: string[]): ((value: string | null | undefined) => boolean) | null {
  if (!environments || environments.length === 0) {
    return null;
  }
  const allowed = environments.map((env) => env.toLowerCase());
  return (value) => {
    if (!value) {
      return false;
    }
    return allowed.includes(value.toLowerCase());
  };
}

function buildStatusFilter(statuses?: string[]): ((value: string | null | undefined) => boolean) | null {
  if (!statuses || statuses.length === 0) {
    return null;
  }
  const allowed = statuses.map((status) => status.toLowerCase());
  return (value) => {
    if (!value) {
      return false;
    }
    return allowed.includes(value.toLowerCase());
  };
}

export async function collectDeploymentApiEvents({
  octokit,
  owner,
  repo,
  windowStart,
  windowEnd,
  options,
  debug,
}: CollectDeploymentsParams): Promise<DeploymentLikeEvent[]> {
  const windowStartDate = new Date(windowStart);
  const windowEndDate = new Date(windowEnd);

  const environmentMatches = buildEnvironmentFilter(options?.environments);
  const statusMatches = buildStatusFilter(options?.statuses);

  const deployments: DeploymentLikeEvent[] = [];

  const iterator = octokit.paginate.iterator(octokit.repos.listDeployments, {
    owner,
    repo,
    per_page: 100,
    environment: options?.environments && options.environments.length === 1 ? options.environments[0] : undefined,
  });

  let inspected = 0;

  for await (const response of iterator) {
    for (const deployment of response.data) {
      inspected += 1;
      const createdAtRaw = deployment.created_at ?? deployment.updated_at;
      if (!createdAtRaw) {
        continue;
      }
      const createdAt = new Date(createdAtRaw);
      if (createdAt < windowStartDate) {
        // Older than window; we can exit after this page
        break;
      }
      if (createdAt > windowEndDate) {
        continue;
      }

      if (environmentMatches && !environmentMatches(deployment.environment ?? null)) {
        if (debug) {
          console.log(
            `[${owner}/${repo}] deployment#${deployment.id} ⏭️  skipped (environment '${deployment.environment}' not in ${options?.environments?.join(", ")})`
          );
        }
        continue;
      }

      const { data: statuses } = await octokit.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id: deployment.id,
        per_page: 100,
      });

      const latestStatus = statuses[0];
      const statusState = latestStatus?.state ?? null;
      const completedAtRaw = latestStatus?.created_at ?? deployment.updated_at ?? null;

      if (statusMatches && !statusMatches(statusState)) {
        if (debug) {
          console.log(
            `[${owner}/${repo}] deployment#${deployment.id} ⏭️  skipped (status '${statusState}' not in ${options?.statuses?.join(", ")})`
          );
        }
        continue;
      }

      const event: DeploymentLikeEvent = {
        id: `deployment:${deployment.id}`,
        source: SOURCE,
        name: deployment.task ?? "deployment",
        displayTitle: `${deployment.environment ?? "unknown"}`,
        event: deployment.task ?? null,
        status: statusState,
        conclusion: statusState,
        createdAt: deployment.created_at ?? deployment.updated_at ?? new Date().toISOString(),
        completedAt: completedAtRaw,
        branch: deployment.ref ?? null,
        sha: deployment.sha ?? null,
        metadata: {
          environment: deployment.environment ?? null,
          description: latestStatus?.description ?? null,
          creator: deployment.creator?.login ?? null,
        },
      };

      if (debug) {
        console.log(
          `[${owner}/${repo}] deployment#${deployment.id} ✅ counted (created=${event.createdAt}, status=${event.status ?? "unknown"}) env=${deployment.environment}`
        );
      }

      deployments.push(event);
    }

    const oldestInPage = response.data[response.data.length - 1];
    if (oldestInPage) {
      const oldestCreated = new Date(oldestInPage.created_at ?? oldestInPage.updated_at ?? 0);
      if (oldestCreated < windowStartDate) {
        break;
      }
    }
  }

  if (debug) {
    console.log(
      `[${owner}/${repo}] [deployments] inspected ${inspected} deployment records → ${deployments.length} events`
    );
  }

  return deployments;
}
