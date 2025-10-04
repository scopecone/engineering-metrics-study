import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { writeValidationFile } from "./index";

type DiscoveryResult = {
  status: "accepted" | "excluded";
  repo: { fullName: string };
  recommendedMethod: "actions" | "releases" | "deployments";
  releases: { count: number; tags: string[] };
  deployments: { count: number; environments: string[] };
  actions: { count: number; keywordsHit: Record<string, number> };
};

const baseResult: DiscoveryResult = {
  status: "accepted",
  repo: { fullName: "owner/project" },
  recommendedMethod: "releases",
  releases: { count: 3, tags: ["v1.0.0"] },
  deployments: { count: 0, environments: [] },
  actions: { count: 0, keywordsHit: {} },
};

describe("writeValidationFile", () => {
  let tmpDir: string;
  let samplePath: string;
  let validationPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ems-validation-"));
    samplePath = path.join(tmpDir, "repos.sample.json");
    validationPath = path.join(tmpDir, "batch.json");
    await fs.writeJson(samplePath, [{ slug: "existing/repo", method: "releases" }], { spaces: 2 });
  });

  it("writes accepted repos and skips those already present", async () => {
    const results: DiscoveryResult[] = [
      { ...baseResult, repo: { fullName: "existing/repo" } },
      { ...baseResult, repo: { fullName: "new/repo" } },
      { ...baseResult, status: "excluded", repo: { fullName: "excluded/repo" } },
    ];

    const summary = await writeValidationFile(results as any, {
      outputPath: validationPath,
      append: false,
      samplePath,
      defaultKeywords: ["deploy", "release"],
    });

    expect(summary.written).toBe(1);
    expect(summary.skipped).toBe(1);

    const written = await fs.readJson(validationPath);
    expect(written).toEqual([
      {
        slug: "new/repo",
        method: "releases",
        releases: {},
      },
    ]);
  });

  it("appends without duplicating existing validation entries", async () => {
    await fs.writeJson(validationPath, [
      {
        slug: "initial/repo",
        method: "actions",
        actions: { workflowKeywords: ["deploy"] },
      },
    ], { spaces: 2 });

    const results: DiscoveryResult[] = [
      { ...baseResult, repo: { fullName: "initial/repo" }, recommendedMethod: "actions" },
      { ...baseResult, repo: { fullName: "second/repo" }, recommendedMethod: "deployments", deployments: { count: 1, environments: ["prod"] } },
    ];

    const summary = await writeValidationFile(results as any, {
      outputPath: validationPath,
      append: true,
      samplePath,
      defaultKeywords: ["deploy"],
    });

    expect(summary.written).toBe(1);
    const finalEntries = await fs.readJson(validationPath);
    expect(finalEntries).toEqual([
      {
        slug: "initial/repo",
        method: "actions",
        actions: { workflowKeywords: ["deploy"] },
      },
      {
        slug: "second/repo",
        method: "deployments",
        deployments: { environments: ["prod"] },
      },
    ]);
  });
});
