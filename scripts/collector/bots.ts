const DEFAULT_PATTERNS = [
  "dependabot",
  "renovate",
  "github-actions",
  "release-please",
  "semantic-release",
  "stale",
  "snyk",
  "greenkeeper",
  "allstar",
  "automation-bot",
];

export const DEFAULT_BOT_AUTHOR_PATTERNS = DEFAULT_PATTERNS;

export function normalizeBotPatterns(patterns: string[]): string[] {
  return patterns.map((pattern) => pattern.toLowerCase()).filter((pattern) => pattern.length > 0);
}

export function isBotAuthorLogin(login: string | null, patterns: string[]): boolean {
  if (!login) {
    return false;
  }

  const normalized = login.toLowerCase();

  if (normalized.endsWith("[bot]")) {
    return true;
  }

  return patterns.some((pattern) => normalized.includes(pattern));
}

