import { describe, it, expect } from "vitest";
import { mergeConfigs, normalizeSlug, sortConfigs } from "./promote-config";

const baseEntries = [
  { slug: "alpha/project", method: "releases" },
  { slug: "beta/service", method: "actions", actions: { workflowKeywords: ["deploy"] } },
];

describe("promote-config helpers", () => {
  it("normalizes slugs and sorts configs", () => {
    const unordered = [
      { slug: "zeta/app", method: "releases" },
      { slug: "Delta/tool", method: "deployments" },
    ];
    const sorted = sortConfigs(unordered as any);
    expect(sorted.map((entry) => entry.slug)).toEqual(["Delta/tool", "zeta/app"]);
    expect(() => normalizeSlug("invalid" as any)).toThrow();
  });

  it("merges new entries and skips duplicates", () => {
    const incoming = [
      { slug: "beta/service", method: "actions" },
      { slug: "gamma/addon", method: "releases" },
    ];

    const result = mergeConfigs(baseEntries as any, incoming as any);
    expect(result.added.map((entry) => entry.slug)).toEqual(["gamma/addon"]);
    expect(result.skipped).toEqual(["beta/service"]);
    expect(result.merged.map((entry) => entry.slug)).toContain("gamma/addon");
    expect(result.merged.map((entry) => entry.slug)).toContain("alpha/project");
  });
});
