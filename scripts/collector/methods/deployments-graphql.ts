import type { CollectionMethod, DeploymentsCollectionOptions, DeploymentLikeEvent } from "../types";

const SOURCE: CollectionMethod = "deployments";

interface CollectDeploymentsGraphQLParams {
  graphqlClient: typeof import("@octokit/graphql").graphql;
  owner: string;
  repo: string;
  windowStart: string;
  windowEnd: string;
  options: DeploymentsCollectionOptions | undefined;
  debug?: boolean;
}

const DEPLOYMENTS_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      deployments(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          id
          databaseId
          createdAt
          updatedAt
          environment
          task
          commitOid
          ref {
            name
          }
          creator {
            login
          }
          statuses(last: 1) {
            nodes {
              state
              description
              createdAt
            }
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

export async function collectDeploymentGraphQLEvents({
  graphqlClient,
  owner,
  repo,
  windowStart,
  windowEnd,
  options,
  debug,
}: CollectDeploymentsGraphQLParams): Promise<DeploymentLikeEvent[]> {
  const windowStartDate = new Date(windowStart);
  const windowEndDate = new Date(windowEnd);

  const environmentMatches = options?.environments?.length
    ? (env: string | null) =>
        env !== null && options.environments!.some((candidate) => candidate.toLowerCase() === env.toLowerCase())
    : null;

  const statusMatches = options?.statuses?.length
    ? (state: string | null) =>
        state !== null && options.statuses!.some((candidate) => candidate.toLowerCase() === state.toLowerCase())
    : null;

  const deployments: DeploymentLikeEvent[] = [];
  let cursor: string | null = null;
  let inspected = 0;

  while (true) {
    const response = await graphqlClient<{ repository: { deployments: { nodes: Array<{
      id: string;
      databaseId: number;
      createdAt: string;
      updatedAt: string;
      environment: string | null;
      task: string | null;
      ref: string | null;
      sha: string | null;
      creator: { login: string } | null;
      statuses: { nodes: Array<{ state: string; description: string | null; createdAt: string }> };
    }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } }>(DEPLOYMENTS_QUERY, {
      owner,
      name: repo,
      cursor,
    });

    const connection = response.repository.deployments;

    for (const deployment of connection.nodes) {
      inspected += 1;
      const createdAt = new Date(deployment.createdAt);

      if (createdAt < windowStartDate) {
        if (debug) {
          console.log(`[${owner}/${repo}] Reached deployments older than window; stopping`);
        }
        return deployments;
      }

      if (createdAt > windowEndDate) {
        continue;
      }

      if (environmentMatches && !environmentMatches(deployment.environment)) {
        if (debug) {
          console.log(
            `[${owner}/${repo}] deployment#${deployment.databaseId} ⏭️  skipped (environment ${deployment.environment})`
          );
        }
        continue;
      }

      const latestStatus = deployment.statuses.nodes[0];
      const statusState = latestStatus?.state ?? null;

      if (statusMatches && !statusMatches(statusState)) {
        if (debug) {
          console.log(
            `[${owner}/${repo}] deployment#${deployment.databaseId} ⏭️  skipped (status ${statusState ?? "unknown"})`
          );
        }
        continue;
      }

      const event: DeploymentLikeEvent = {
        id: `deployment:${deployment.databaseId}`,
        source: SOURCE,
        name: deployment.task ?? "deployment",
        displayTitle: deployment.environment ?? "unknown",
        event: deployment.task ?? null,
        status: statusState,
        conclusion: statusState,
        createdAt: deployment.createdAt,
        completedAt: latestStatus?.createdAt ?? deployment.updatedAt,
        branch: deployment.ref?.name ?? null,
        sha: deployment.commitOid ?? null,
        metadata: {
          environment: deployment.environment ?? null,
          description: latestStatus?.description ?? null,
          creator: deployment.creator?.login ?? null,
        },
      };

      deployments.push(event);

      if (debug) {
        console.log(
          `[${owner}/${repo}] deployment#${deployment.databaseId} ✅ counted (created=${event.createdAt}, status=${event.status ?? "unknown"})`
        );
      }
    }

    if (!connection.pageInfo.hasNextPage) {
      break;
    }

    cursor = connection.pageInfo.endCursor;
  }

  if (debug) {
    console.log(
      `[${owner}/${repo}] [deployments-graphql] inspected ${inspected} deployments → ${deployments.length} events`
    );
  }

  return deployments;
}
