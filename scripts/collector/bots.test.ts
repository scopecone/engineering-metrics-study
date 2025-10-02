import { describe, expect, it } from "vitest";

import { DEFAULT_BOT_AUTHOR_PATTERNS, isBotAuthorLogin, normalizeBotPatterns } from "./bots";

describe("bot author detection", () => {
  const patterns = normalizeBotPatterns(DEFAULT_BOT_AUTHOR_PATTERNS);

  it("treats [bot] suffixed accounts as bots", () => {
    expect(isBotAuthorLogin("dependabot[bot]", patterns)).toBe(true);
    expect(isBotAuthorLogin("renovate[bot]", patterns)).toBe(true);
  });

  it("matches configured substrings", () => {
    expect(isBotAuthorLogin("github-actions", patterns)).toBe(true);
    expect(isBotAuthorLogin("semantic-release-bot", patterns)).toBe(true);
    expect(isBotAuthorLogin("stale[bot]", patterns)).toBe(true);
  });

  it("ignores human authors", () => {
    expect(isBotAuthorLogin("alice", patterns)).toBe(false);
    expect(isBotAuthorLogin("bob-smith", patterns)).toBe(false);
  });

  it("respects custom pattern lists", () => {
    const customPatterns = normalizeBotPatterns(["auto-merge"]);
    expect(isBotAuthorLogin("auto-merge-bot", customPatterns)).toBe(true);
    expect(isBotAuthorLogin("renovate[bot]", customPatterns)).toBe(true);
  });
});
