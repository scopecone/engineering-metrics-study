import { describe, expect, it, vi } from "vitest";

import { collectDeploymentGraphQLEvents } from "./deployments-graphql";

describe("collectDeploymentGraphQLEvents", () => {
  const windowStart = "2024-01-01T00:00:00.000Z";
  const windowEnd = "2024-02-01T00:00:00.000Z";

  it("collects deployments inside the window and applies filters", async () => {
    const firstPageResponse = {
      repository: {
        deployments: {
          nodes: [
            {
              id: "gid://github/Deployment/1",
              databaseId: 1,
              createdAt: "2024-01-10T12:00:00.000Z",
              updatedAt: "2024-01-10T13:00:00.000Z",
              environment: "Production",
              task: "deploy",
              commitOid: "abc123",
              ref: { name: "main" },
              creator: { login: "octocat" },
              statuses: {
                nodes: [
                  {
                    state: "SUCCESS",
                    description: "All good",
                    createdAt: "2024-01-10T13:00:00.000Z",
                  },
                ],
              },
            },
            {
              id: "gid://github/Deployment/2",
              databaseId: 2,
              createdAt: "2024-01-09T12:00:00.000Z",
              updatedAt: "2024-01-09T13:00:00.000Z",
              environment: "Staging",
              task: "deploy",
              commitOid: "def456",
              ref: { name: "develop" },
              creator: { login: "staging-bot" },
              statuses: {
                nodes: [
                  {
                    state: "SUCCESS",
                    description: "Staging deploy",
                    createdAt: "2024-01-09T13:00:00.000Z",
                  },
                ],
              },
            },
          ],
          pageInfo: {
            hasNextPage: true,
            endCursor: "cursor-1",
          },
        },
      },
    };

    const secondPageResponse = {
      repository: {
        deployments: {
          nodes: [
            {
              id: "gid://github/Deployment/3",
              databaseId: 3,
              createdAt: "2023-12-25T12:00:00.000Z",
              updatedAt: "2023-12-25T12:30:00.000Z",
              environment: "Production",
              task: "deploy",
              commitOid: "ghi789",
              ref: { name: "main" },
              creator: { login: "octocat" },
              statuses: {
                nodes: [
                  {
                    state: "SUCCESS",
                    description: "Old deploy",
                    createdAt: "2023-12-25T12:30:00.000Z",
                  },
                ],
              },
            },
          ],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    };

    const graphqlClient = vi
      .fn()
      .mockResolvedValueOnce(firstPageResponse)
      .mockResolvedValueOnce(secondPageResponse);

    const events = await collectDeploymentGraphQLEvents({
      graphqlClient: graphqlClient as unknown as typeof import("@octokit/graphql").graphql,
      owner: "getsentry",
      repo: "sentry",
      windowStart,
      windowEnd,
      options: {
        environments: ["production"],
        statuses: ["success"],
      },
      debug: false,
    });

    expect(graphqlClient).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "deployment:1",
      source: "deployments",
      status: "SUCCESS",
      branch: "main",
      sha: "abc123",
      metadata: {
        environment: "Production",
        creator: "octocat",
      },
    });
  });

  it("ignores deployments without matching statuses when filters provided", async () => {
    const response = {
      repository: {
        deployments: {
          nodes: [
            {
              id: "gid://github/Deployment/4",
              databaseId: 4,
              createdAt: "2024-01-15T08:00:00.000Z",
              updatedAt: "2024-01-15T08:30:00.000Z",
              environment: "Production",
              task: "deploy",
              commitOid: "aaa111",
              ref: { name: "main" },
              creator: { login: "octocat" },
              statuses: {
                nodes: [
                  {
                    state: "FAILURE",
                    description: "Deployment failed",
                    createdAt: "2024-01-15T08:30:00.000Z",
                  },
                ],
              },
            },
          ],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    };

    const graphqlClient = vi.fn().mockResolvedValue(response);

    const events = await collectDeploymentGraphQLEvents({
      graphqlClient: graphqlClient as unknown as typeof import("@octokit/graphql").graphql,
      owner: "getsentry",
      repo: "sentry",
      windowStart,
      windowEnd,
      options: {
        statuses: ["success"],
      },
      debug: false,
    });

    expect(events).toHaveLength(0);
  });
});
