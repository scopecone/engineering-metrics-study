import { describe, it, expect } from "vitest";
import { analyzeReleases, derivePrefix, suggestPattern, recommendInclude } from "./inspect-releases";

describe("inspect-releases helpers", () => {
  it("derives prefixes and suggests patterns", () => {
    expect(derivePrefix("v1.2.3")).toBe("v");
    expect(derivePrefix("gateway-1.2.3")).toBe("gateway-");
    expect(suggestPattern(["v1.0.0", "v1.0.1-rc.1"])).toBe("^v");
    expect(suggestPattern(["2024-01-01", "2023-11-30"])).toBe("^[0-9]{4}");
    expect(suggestPattern(["1.0.0", "2.0.0"])).toBe("^[0-9]");
  });

  it("recommends include strategy and analyses releases", () => {
    expect(recommendInclude(0, 5)).toBe("exclude");
    expect(recommendInclude(5, 0)).toBe("include");
    expect(recommendInclude(2, 3)).toBe("mixed");

    const analysis = analyzeReleases("demo/project", [
      { tag: "gateway-1.2.3", publishedAt: "2024-01-01T00:00:00Z", isPrerelease: false },
      { tag: "gateway-1.2.4", publishedAt: "2024-02-01T00:00:00Z", isPrerelease: true },
    ]);

    expect(analysis.slug).toBe("demo/project");
    expect(analysis.suggestedPattern).toBe("^gateway-");
    expect(analysis.includeRecommendation).toBe("mixed");
    expect(analysis.distinctPrefixes).toContain("gateway-");
  });
});
