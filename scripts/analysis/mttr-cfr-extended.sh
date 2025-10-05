#!/usr/bin/env bash
set -euo pipefail
OUTPUT="${1:-output/metrics-mttr-cfr-extended.json}"
shift || true

PARTS=()
run_batch() {
  local out="$1"
  shift
  npm run mttr-cfr -- --days 120 --output "$out" "$@"
  PARTS+=("$out")
}

run_batch "$OUTPUT.part1.json" \
  --repo getsentry/sentry \
  --repo growthbook/growthbook \
  --repo openstatusHQ/openstatus \
  --repo Budibase/budibase \
  --repo langfuse/langfuse \
  --repo Unleash/unleash \
  --repo TobikoData/sqlmesh \
  --repo PostHog/posthog \
  "$@"

run_batch "$OUTPUT.part2.json" \
  --repo 18F/identity-idp \
  --repo metabase/metabase \
  --repo chakra-ui/chakra-ui \
  --repo ClickHouse/ClickHouse \
  --repo vercel/next.js \
  --repo toeverything/AFFiNE \
  --repo lumakedr/promptfoo

node - <<'NODE'
const fs = require('fs');
const output = process.argv[2];
const parts = process.argv.slice(3);
const repos = [];
let windowDays = null;
for (const part of parts) {
  const json = JSON.parse(fs.readFileSync(part, 'utf8'));
  windowDays = json.windowDays;
  repos.push(...json.repos);
}
const merged = {
  generatedAt: new Date().toISOString(),
  windowDays,
  repos,
};
fs.writeFileSync(output, JSON.stringify(merged, null, 2) + '\n');
for (const part of parts) {
  fs.unlinkSync(part);
}
NODE "$OUTPUT" "${PARTS[@]}"
