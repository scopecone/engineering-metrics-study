import type { Octokit } from "@octokit/rest";

import type {
  ActionsCollectionOptions,
  DeploymentLikeEvent,
  CollectionMethod,
} from "../types";

const SOURCE: CollectionMethod = "actions";

interface CollectActionsParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  windowStart: string;
  windowEnd: string;
  options: ActionsCollectionOptions;
  debug?: boolean;
}

function normalizeBranchCandidates(branch: string): Set<string> {
  const normalized = branch.startsWith("refs/") ? branch : branch;
  const trimmed = normalized.replace(/^refs\/heads\//, "");
  return new Set([
    branch,
    normalized,
    trimmed,
    `refs/heads/${trimmed}`,
  ]);
}

export async function collectActionsEvents({
  octokit,
  owner,
  repo,
  windowStart,
  windowEnd,
  options,
  debug,
}: CollectActionsParams): Promise<DeploymentLikeEvent[]> {
  const keywords = options.workflowKeywords.map((keyword) => keyword.toLowerCase());
  const allowedEvents = options.events?.map((event) => event.toLowerCase());
  const branchCandidates = options.branch ? normalizeBranchCandidates(options.branch) : null;

  const runs = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, {
    owner,
    repo,
    per_page: 100,
    created: `${windowStart}..${windowEnd}`,
  });

  if (debug) {
    console.log(
      `[${owner}/${repo}] [actions] inspecting ${runs.length} workflow runs between ${windowStart} and ${windowEnd}`
    );
  }

  const selected: DeploymentLikeEvent[] = [];

  for (const run of runs) {
    const logPrefix = `[${owner}/${repo}] workflow#${run.id}`;
    if (run.status !== "completed" || run.conclusion !== "success") {
      if (debug) {
        console.log(
          `${logPrefix} ⏭️  skipped (status=${run.status ?? "unknown"}, conclusion=${run.conclusion ?? "unknown"})`
        );
      }
      continue;
    }

    if (!run.created_at) {
      if (debug) {
        console.log(`${logPrefix} ⏭️  skipped (missing created_at)`);
      }
      continue;
    }

    const createdAt = new Date(run.created_at);
    const start = new Date(windowStart);
    const end = new Date(windowEnd);
    if (createdAt < start || createdAt > end) {
      if (debug) {
        console.log(
          `${logPrefix} ⏭️  skipped (outside window ${windowStart}..${windowEnd})`
        );
      }
      continue;
    }

    const target = `${run.name ?? ""} ${run.display_title ?? ""}`.toLowerCase();
    const matchedKeyword = keywords.find((keyword) => target.includes(keyword));
    if (!matchedKeyword) {
      if (debug) {
        console.log(
          `${logPrefix} ⏭️  skipped (no keyword match) title="${run.display_title ?? run.name ?? ""}")`
        );
      }
      continue;
    }

    if (allowedEvents && allowedEvents.length > 0) {
      const eventName = (run.event ?? "").toLowerCase();
      if (!allowedEvents.includes(eventName)) {
        if (debug) {
          console.log(
            `${logPrefix} ⏭️  skipped (event '${eventName}' not in ${allowedEvents.join(", ")})`
          );
        }
        continue;
      }
    }

    if (branchCandidates) {
      const headBranch = run.head_branch ?? null;
      if (!headBranch || !branchCandidates.has(headBranch)) {
        if (debug) {
          console.log(
            `${logPrefix} ⏭️  skipped (head branch '${headBranch ?? "unknown"}' not matching '${Array.from(
              branchCandidates
            ).join(", ")}')`
          );
        }
        continue;
      }
    }

    const event: DeploymentLikeEvent = {
      id: String(run.id),
      source: SOURCE,
      name: run.name ?? "",
      displayTitle: run.display_title ?? "",
      event: run.event ?? null,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      createdAt: run.created_at,
      completedAt: run.updated_at ?? null,
      branch: run.head_branch ?? null,
      sha: run.head_sha ?? null,
      metadata: {
        runAttempt: run.run_attempt ?? null,
        runNumber: run.run_number ?? null,
        htmlUrl: run.html_url ?? null,
      },
    };

    selected.push(event);

    if (debug) {
      console.log(
        `${logPrefix} ✅ counted (created=${event.createdAt}, event=${event.event ?? "unknown"}, matched="${matchedKeyword}") title="${event.displayTitle}"
`
      );
    }
  }

  if (debug) {
    console.log(
      `[${owner}/${repo}] [actions] → ${selected.length} deployment-like runs between ${windowStart} and ${windowEnd}`
    );
  }

  return selected;
}
