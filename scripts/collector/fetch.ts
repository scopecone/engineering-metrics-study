import type { RequestHeaders } from "@octokit/types";

export interface CachedResponse<T> {
  data: T;
  etag?: string;
  lastModified?: string;
}

export interface ConditionalFetchResult<T> extends CachedResponse<T> {
  source: "network" | "cache";
}

export async function fetchWithConditional<T>(
  request: (headers: Record<string, string>) => Promise<{ data: T; headers: RequestHeaders }>,
  cached: CachedResponse<T> | null,
  onResponse?: (headers: RequestHeaders) => void
): Promise<ConditionalFetchResult<T>> {
  const headers: Record<string, string> = {};
  if (cached?.etag) {
    headers["If-None-Match"] = cached.etag;
  }
  if (cached?.lastModified) {
    headers["If-Modified-Since"] = cached.lastModified;
  }

  try {
    const response = await request(headers);
    onResponse?.(response.headers);
    return {
      data: response.data,
      etag: typeof response.headers.etag === "string" ? response.headers.etag : undefined,
      lastModified:
        typeof response.headers["last-modified"] === "string"
          ? response.headers["last-modified"]
          : undefined,
      source: "network",
    };
  } catch (error: any) {
    if (error.status === 304 && cached) {
      if (error.response?.headers) {
        onResponse?.(error.response.headers as RequestHeaders);
      }
      return { ...cached, source: "cache" };
    }
    throw error;
  }
}
