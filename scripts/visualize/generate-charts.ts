#!/usr/bin/env node
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output", "charts");

interface LanguageSummary {
  language: string | null;
  repoCount: number;
  deployMedian: number;
  deployP75: number;
  deployP95: number;
  prMedian: number;
  prP75: number;
  prP95: number;
}

interface SizeSummary {
  sizeTier: string;
  repoCount: number;
  deployMedian: number;
  deployP75: number;
  deployP95: number;
  prMedian: number;
  prP75: number;
  prP95: number;
}

interface PRSizeRow {
  repo: string;
  prCount: number;
  prCycleTimeHoursMedian: number | null;
  medianChanges: number | null;
}

async function main() {
  await fs.ensureDir(OUTPUT_DIR);

  const segmentationPath = path.join(PROJECT_ROOT, "output", "metrics-segmentation.json");
  const segmentation = await fs.readJson(segmentationPath) as {
    languageSummary: LanguageSummary[];
    sizeSummary: SizeSummary[];
  };

  const prSizePath = path.join(PROJECT_ROOT, "output", "metrics-pr-size.json");
  const prSizeData = await fs.readJson(prSizePath) as { repos: PRSizeRow[] };

  await renderLanguageDeploymentChart(segmentation.languageSummary);
  await renderSizeTierCycleChart(segmentation.sizeSummary);
  await renderPRSizeBucketChart(prSizeData.repos);

  console.log("✅ Charts saved to", path.relative(PROJECT_ROOT, OUTPUT_DIR));
}

async function renderLanguageDeploymentChart(languageSummary: LanguageSummary[]) {
  const focusLanguages = ["Go", "TypeScript", "Python", "Java", "C++"];
  const rows = languageSummary.filter((row) => row.language && focusLanguages.includes(row.language));
  const data = rows.map((row) => ({
    label: row.language as string,
    values: [
      { series: "Median", value: row.deployMedian },
      { series: "P75", value: row.deployP75 },
      { series: "P95", value: row.deployP95 },
    ],
  }));

  await renderGroupedBarChart({
    title: "Deployment Frequency by Language",
    subtitle: "Deploys per week (Median, P75, P95)",
    yLabel: "Deploys per week",
    data,
    valueFormatter: (value) => value.toFixed(value >= 10 ? 0 : 1),
    outputPath: path.join(OUTPUT_DIR, "deploy-frequency-by-language.svg"),
  });
}

async function renderSizeTierCycleChart(sizeSummary: SizeSummary[]) {
  const tiersOrder = ["small", "medium", "large"];
  const rows = sizeSummary
    .filter((row) => tiersOrder.includes(row.sizeTier))
    .sort((a, b) => tiersOrder.indexOf(a.sizeTier) - tiersOrder.indexOf(b.sizeTier));

  const prettyLabel: Record<string, string> = {
    small: "Small (<100 PRs)",
    medium: "Medium (100–499)",
    large: "Large (≥500)",
  };

  const data = rows.map((row) => ({
    label: prettyLabel[row.sizeTier],
    values: [
      { series: "Median", value: row.prMedian },
      { series: "P75", value: row.prP75 },
      { series: "P95", value: row.prP95 },
    ],
  }));

  await renderGroupedBarChart({
    title: "PR Cycle Time by Repo Size",
    subtitle: "Hours from PR open to merge (Median, P75, P95)",
    yLabel: "Hours",
    data,
    valueFormatter: (value) => value.toFixed(0),
    outputPath: path.join(OUTPUT_DIR, "pr-cycle-by-size-tier.svg"),
  });
}

async function renderPRSizeBucketChart(rows: PRSizeRow[]) {
  const pairs = rows
    .filter((row) => row.medianChanges !== null && row.prCycleTimeHoursMedian !== null && row.prCount >= 10)
    .map((row) => ({ changes: row.medianChanges as number, cycle: row.prCycleTimeHoursMedian as number }));

  if (!pairs.length) {
    throw new Error("No PR size data available for chart");
  }

  const changeValues = pairs.map((p) => p.changes).sort((a, b) => a - b);
  const q1 = percentile(changeValues, 0.25);
  const q2 = percentile(changeValues, 0.5);
  const q3 = percentile(changeValues, 0.75);

  const buckets: { label: string; cycles: number[] }[] = [
    { label: `≤${Math.round(q1)} lines`, cycles: [] },
    { label: `${Math.round(q1) + 1}–${Math.round(q2)} lines`, cycles: [] },
    { label: `${Math.round(q2) + 1}–${Math.round(q3)} lines`, cycles: [] },
    { label: `>${Math.round(q3)} lines`, cycles: [] },
  ];

  for (const pair of pairs) {
    const { changes, cycle } = pair;
    if (changes <= q1) {
      buckets[0].cycles.push(cycle);
    } else if (changes <= q2) {
      buckets[1].cycles.push(cycle);
    } else if (changes <= q3) {
      buckets[2].cycles.push(cycle);
    } else {
      buckets[3].cycles.push(cycle);
    }
  }

  const data = buckets.map((bucket) => ({
    label: bucket.label,
    values: [
      { series: "Median", value: median(bucket.cycles) },
    ],
  }));

  await renderGroupedBarChart({
    title: "PR Cycle Time vs Diff Size",
    subtitle: "Median PR cycle hours by per-repo median diff size",
    yLabel: "Hours",
    data,
    valueFormatter: (value) => value.toFixed(1),
    outputPath: path.join(OUTPUT_DIR, "pr-cycle-vs-pr-size.svg"),
    colors: ["#1f77b4"],
  });
}

interface ChartSeriesValue {
  series: string;
  value: number;
}

interface GroupedBarChartData {
  label: string;
  values: ChartSeriesValue[];
}

interface GroupedBarChartOptions {
  title: string;
  subtitle?: string;
  yLabel: string;
  data: GroupedBarChartData[];
  valueFormatter?: (value: number) => string;
  colors?: string[];
  outputPath: string;
}

async function renderGroupedBarChart(options: GroupedBarChartOptions) {
  const {
    title,
    subtitle,
    yLabel,
    data,
    valueFormatter = (value) => value.toString(),
    colors = ["#1f77b4", "#ff7f0e", "#2ca02c"],
    outputPath,
  } = options;

  const width = 960;
  const height = 540;
  const margin = { top: 80, right: 40, bottom: 100, left: 80 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const seriesNames = Array.from(new Set(data.flatMap((group) => group.values.map((value) => value.series))));
  const colorMap = new Map<string, string>();
  seriesNames.forEach((name, index) => {
    colorMap.set(name, colors[index % colors.length]);
  });

  const maxValue = Math.max(
    ...data.flatMap((group) => group.values.map((value) => value.value))
  );
  const niceMax = niceCeil(maxValue);
  const ticks = generateTicks(niceMax, 5);

  const groupCount = data.length;
  const seriesCount = seriesNames.length;
  const groupSpacing = 40;
  const barSpacing = 10;
  const totalGroupWidth = chartWidth / groupCount;
  const innerGroupWidth = totalGroupWidth - groupSpacing;
  const barWidth = seriesCount > 0 ? (innerGroupWidth - barSpacing * (seriesCount - 1)) / seriesCount : innerGroupWidth;

  const yScale = (value: number) => chartHeight - (value / niceMax) * chartHeight;

  const svgParts: string[] = [];
  svgParts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  svgParts.push(
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <style>
        text { font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; fill: #111827; }
        .title { font-size: 24px; font-weight: 600; }
        .subtitle { font-size: 16px; fill: #4b5563; }
        .axis { font-size: 12px; fill: #374151; }
        .legend { font-size: 12px; }
        .tick line { stroke: #e5e7eb; }
      </style>
    `
  );

  svgParts.push(`<text class="title" x="${margin.left}" y="${margin.top - 36}">${title}</text>`);
  if (subtitle) {
    svgParts.push(`<text class="subtitle" x="${margin.left}" y="${margin.top - 12}">${subtitle}</text>`);
  }

  svgParts.push(
    `<text class="axis" transform="translate(${margin.left - 50}, ${margin.top + chartHeight / 2}) rotate(-90)" text-anchor="middle">${yLabel}</text>`
  );

  ticks.forEach((tick) => {
    const y = margin.top + yScale(tick);
    svgParts.push(`<line class="tick" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e5e7eb" />`);
    svgParts.push(`<text class="axis" x="${margin.left - 10}" y="${y + 4}" text-anchor="end">${tick.toFixed(tick >= 10 ? 0 : 1)}</text>`);
  });

  data.forEach((group, groupIndex) => {
    const groupStart = margin.left + groupIndex * (totalGroupWidth);
    const groupLabelX = groupStart + (innerGroupWidth) / 2;

    group.values.forEach((value, seriesIndex) => {
      const barHeight = (value.value / niceMax) * chartHeight;
      const x = groupStart + seriesIndex * (barWidth + barSpacing);
      const y = margin.top + chartHeight - barHeight;
      const color = colorMap.get(value.series) ?? colors[seriesIndex % colors.length];
      svgParts.push(`<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${color}" rx="4" />`);
      svgParts.push(
        `<text class="axis" x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle">${valueFormatter(value.value)}</text>`
      );
    });

    svgParts.push(
      `<text class="axis" x="${groupLabelX}" y="${margin.top + chartHeight + 36}" text-anchor="middle" style="font-weight: 600;">${group.label}</text>`
    );
  });

  if (seriesNames.length > 1) {
    const legendX = width - margin.right - 180;
    let legendY = margin.top - 20;
    seriesNames.forEach((series) => {
      const color = colorMap.get(series) ?? "#1f77b4";
      svgParts.push(`<rect x="${legendX}" y="${legendY - 12}" width="12" height="12" fill="${color}" rx="2" />`);
      svgParts.push(`<text class="legend" x="${legendX + 18}" y="${legendY - 2}">${series}</text>`);
      legendY += 18;
    });
  }

  svgParts.push("</svg>");

  await fs.writeFile(outputPath, svgParts.join("\n"), "utf8");
}

function percentile(values: number[], pct: number): number {
  if (!values.length) {
    return 0;
  }
  if (values.length === 1) {
    return values[0];
  }
  const position = (values.length - 1) * pct;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = values[lowerIndex];
  const upper = values[upperIndex];
  const weight = position - lowerIndex;
  return lower + (upper - lower) * weight;
}

function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function niceCeil(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / Math.pow(10, exponent);
  let niceFraction: number;
  if (fraction <= 1) {
    niceFraction = 1;
  } else if (fraction <= 2) {
    niceFraction = 2;
  } else if (fraction <= 5) {
    niceFraction = 5;
  } else {
    niceFraction = 10;
  }
  return niceFraction * Math.pow(10, exponent);
}

function generateTicks(max: number, count: number): number[] {
  const ticks: number[] = [];
  const step = max / count;
  for (let i = 0; i <= count; i++) {
    ticks.push(step * i);
  }
  return ticks;
}

main().catch((error) => {
  console.error("❌ Failed to generate charts", error);
  process.exit(1);
});
