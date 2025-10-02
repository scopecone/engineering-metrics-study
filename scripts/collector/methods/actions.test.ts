import { describe, expect, it, vi } from "vitest";

import { collectActionsEvents } from "./actions";

describe("collectActionsEvents", () => {
  const windowStart = "2024-01-01T00:00:00.000Z";
  const windowEnd = "2024-02-01T00:00:00.000Z";

  it("returns deployment-like runs within the window and stops on older data", async () => {
    const matchingRun = {
      id: 101,
      status: "completed",
      conclusion: "success",
      created_at: "2024-01-15T10:00:00.000Z",
      updated_at: "2024-01-15T10:10:00.000Z",
      name: "Deploy",
      display_title: "Deploy to Production",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: "sha-main",
      run_attempt: 1,
      run_number: 501,
      html_url: "https://github.com/acme/widgets/actions/runs/101",
    };

    const nonMatchingRun = {
      id: 102,
      status: "completed",
      conclusion: "success",
      created_at: "2024-01-10T10:00:00.000Z",
      updated_at: "2024-01-10T10:10:00.000Z",
      name: "Unit Tests",
      display_title: "Unit Tests",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: "sha-tests",
      run_attempt: 1,
      run_number: 502,
      html_url: "https://github.com/acme/widgets/actions/runs/102",
    };

    const oldRun = {
      id: 103,
      status: "completed",
      conclusion: "success",
      created_at: "2023-12-20T10:00:00.000Z",
      updated_at: "2023-12-20T10:10:00.000Z",
      name: "Deploy",
      display_title: "Deploy to Production",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: "sha-old",
      run_attempt: 1,
      run_number: 400,
      html_url: "https://github.com/acme/widgets/actions/runs/103",
    };

    async function* iterator() {
      yield { data: [matchingRun, nonMatchingRun] };
      yield { data: [oldRun] };
    }

    const iteratorMock = vi.fn().mockReturnValue(iterator());

    const octokit = {
      actions: {
        listWorkflowRunsForRepo: vi.fn(),
      },
      paginate: {
        iterator: iteratorMock,
      },
    } as unknown as import("@octokit/rest").Octokit;

    const events = await collectActionsEvents({
      octokit,
      owner: "acme",
      repo: "widgets",
      windowStart,
      windowEnd,
      options: {
        workflowKeywords: ["deploy"],
        events: ["workflow_dispatch"],
        branch: "main",
      },
      debug: false,
    });

    expect(iteratorMock).toHaveBeenCalledTimes(1);
    expect(iteratorMock.mock.calls[0][0]).toBe(octokit.actions.listWorkflowRunsForRepo);
    expect(iteratorMock.mock.calls[0][1]).toMatchObject({
      owner: "acme",
      repo: "widgets",
      per_page: 100,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "101",
      branch: "main",
      sha: "sha-main",
      metadata: {
        runAttempt: 1,
        runNumber: 501,
        htmlUrl: matchingRun.html_url,
      },
    });
  });
});
