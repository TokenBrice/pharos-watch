#!/usr/bin/env node
/**
 * Queries Google's Safe Browsing v4 threatMatches:find API for pharos.watch
 * and key public URLs. Prints any matches and exits non-zero on a flag, so
 * this can be wired into a daily CI cron or invoked manually after deploys.
 *
 * Requires GOOGLE_SAFE_BROWSING_API_KEY. The Safe Browsing API is free for
 * the volumes we need (thousands of lookups per day). Get a key at:
 * https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com
 *
 * Threat lists checked: MALWARE, SOCIAL_ENGINEERING (deceptive/phishing),
 * UNWANTED_SOFTWARE, POTENTIALLY_HARMFUL_APPLICATION across WINDOWS / LINUX /
 * OSX / ALL_PLATFORMS for URL targets.
 */

const API_KEY = process.env.GOOGLE_SAFE_BROWSING_API_KEY;

const URLS_TO_CHECK = [
  "https://pharos.watch/",
  "https://pharos.watch/api/",
  "https://pharos.watch/funding/",
  "https://pharos.watch/stablecoins/",
  "https://pharos.watch/methodology/",
  "https://pharosville.pharos.watch/",
];

const THREAT_TYPES = [
  "MALWARE",
  "SOCIAL_ENGINEERING",
  "UNWANTED_SOFTWARE",
  "POTENTIALLY_HARMFUL_APPLICATION",
];

const PLATFORM_TYPES = ["ANY_PLATFORM"];

interface SafeBrowsingThreatMatch {
  threat?: { url?: string };
  threatType?: string;
  platformType?: string;
  cacheDuration?: string;
}

interface SafeBrowsingResponse {
  matches?: SafeBrowsingThreatMatch[];
}

async function findThreats(apiKey: string): Promise<SafeBrowsingThreatMatch[]> {
  const endpoint = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`;
  const body = {
    client: { clientId: "pharos-watch-ci", clientVersion: "1.0" },
    threatInfo: {
      threatTypes: THREAT_TYPES,
      platformTypes: PLATFORM_TYPES,
      threatEntryTypes: ["URL"],
      threatEntries: URLS_TO_CHECK.map((url) => ({ url })),
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Safe Browsing API error ${response.status}: ${text.slice(0, 400)}`);
  }

  const payload = (await response.json()) as SafeBrowsingResponse;
  return Array.isArray(payload.matches) ? payload.matches : [];
}

async function main() {
  if (!API_KEY) {
    console.error("[check:safe-browsing] GOOGLE_SAFE_BROWSING_API_KEY is not set.");
    console.error("Get a free key: https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com");
    process.exit(2);
  }

  const matches = await findThreats(API_KEY);
  if (matches.length === 0) {
    console.log(`OK: ${URLS_TO_CHECK.length} URLs clean against Google Safe Browsing (${THREAT_TYPES.join(", ")}).`);
    return;
  }

  console.error("");
  console.error(`✗ Google Safe Browsing reports ${matches.length} threat match(es):`);
  console.error("");
  for (const match of matches) {
    console.error(`  URL:    ${match.threat?.url ?? "<unknown>"}`);
    console.error(`  Type:   ${match.threatType}`);
    console.error(`  Platform: ${match.platformType}`);
    console.error(`  Cache TTL: ${match.cacheDuration ?? "<unset>"}`);
    console.error("");
  }
  console.error("Open Search Console → Security & Manual Actions for the verdict and");
  console.error("review-request path. Playbook: docs/incident-response/safe-browsing-flag.md");
  process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[check:safe-browsing] ${message}`);
  process.exit(2);
});
