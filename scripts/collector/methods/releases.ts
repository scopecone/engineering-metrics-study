import type { Octokit } from "@octokit/rest";

import type {
  DeploymentLikeEvent,
  CollectionMethod,
  ReleasesCollectionOptions,
} from "../types";

const SOURCE: CollectionMethod = "releases";

interface CollectReleasesParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  windowStart: string;
  windowEnd: string;
  options: ReleasesCollectionOptions | undefined;
  debug?: boolean;
}

function matchesTag(tag: string | null | undefined, pattern: string | null | undefined): boolean {
  if (!pattern) {
    return true;
  }
  if (!tag) {
    return false;
  }
  try {
    const regex = new RegExp(pattern);
    return regex.test(tag);
  } catch {
    return tag.includes(pattern);
  }
}

export async function collectReleaseEvents({
  octokit,
  owner,
  repo,
  windowStart,
  windowEnd,
  options,
  debug,
}: CollectReleasesParams): Promise<DeploymentLikeEvent[]> {
  const windowStartDate = new Date(windowStart);
  const windowEndDate = new Date(windowEnd);
  const includePrereleases = options?.includePrereleases ?? false;

  const releases = await octokit.paginate(octokit.repos.listReleases, {
    owner,
    repo,
    per_page: 100,
  });

  if (debug) {
    console.log(
      `[${owner}/${repo}] [releases] inspecting ${releases.length} releases between ${windowStart} and ${windowEnd}`
    );
  }

  const events: DeploymentLikeEvent[] = [];

  for (const release of releases) {
    const relevantTimestamp = release.published_at ?? release.created_at;
    if (!relevantTimestamp) {
      continue;
    }
    const publishedAt = new Date(relevantTimestamp);
    if (publishedAt < windowStartDate) {
      if (debug) {
        console.log(
          `[${owner}/${repo}] release#${release.id} ⏭️  skipped (published ${publishedAt.toISOString()} before window ${windowStart})`
        );
      }
      continue;
    }
    if (publishedAt > windowEndDate) {
      continue;
    }

    if (!includePrereleases && release.prerelease) {
      if (debug) {
        console.log(
          `[${owner}/${repo}] release#${release.id} ⏭️  skipped (prerelease)`
        );
      }
      continue;
    }

    if (!matchesTag(release.tag_name, options?.tagPattern ?? null)) {
      if (debug) {
        console.log(
          `[${owner}/${repo}] release#${release.id} ⏭️  skipped (tag '${release.tag_name}' does not match pattern '${options?.tagPattern}')`
        );
      }
      continue;
    }

    const event: DeploymentLikeEvent = {
      id: `release:${release.id}`,
      source: SOURCE,
      name: release.name ?? release.tag_name ?? "release",
      displayTitle: release.name ?? release.tag_name ?? "release",
      event: release.prerelease ? "prerelease" : "release",
      status: release.draft ? "draft" : release.prerelease ? "prerelease" : "released",
      conclusion: release.draft ? "draft" : "released",
      createdAt: release.created_at ?? relevantTimestamp,
      completedAt: release.published_at ?? release.created_at ?? null,
      branch: release.target_commitish ?? null,
      sha: null,
      metadata: {
        tag: release.tag_name ?? null,
        url: release.html_url ?? null,
        author: release.author?.login ?? null,
      },
    };

    if (debug) {
      console.log(
        `[${owner}/${repo}] release#${release.id} ✅ counted (published=${event.completedAt ?? "unknown"}) tag=${release.tag_name}`
      );
    }

    events.push(event);
  }

  return events;
}
