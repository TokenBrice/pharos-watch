import { expect, test } from "@playwright/test";

const GOOGLE_ANALYTICS_HOSTS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
];

function isGoogleAnalyticsRequest(url: string): boolean {
  const hostname = new URL(url).hostname;
  return GOOGLE_ANALYTICS_HOSTS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

test("embedded Mini App makes no Google analytics requests and serves a Google-free CSP", async ({ page }) => {
  const analyticsRequests: string[] = [];
  page.on("request", (request) => {
    if (isGoogleAnalyticsRequest(request.url())) analyticsRequests.push(request.url());
  });

  const response = await page.goto("/pharoswatchbot/app/", { waitUntil: "domcontentloaded" });
  expect(response).not.toBeNull();
  const csp = (await response?.headerValue("content-security-policy")) ?? "";

  await page.waitForTimeout(2_250);

  expect(analyticsRequests).toEqual([]);
  expect(csp).toContain("https://telegram.org");
  for (const domain of GOOGLE_ANALYTICS_HOSTS) {
    expect(csp).not.toContain(domain);
  }
});

test("public PharosWatchBot page retains the normal site analytics CSP", async ({ page }) => {
  const response = await page.goto("/pharoswatchbot/", { waitUntil: "domcontentloaded" });
  expect(response).not.toBeNull();
  const csp = (await response?.headerValue("content-security-policy")) ?? "";

  expect(csp).toContain("https://www.googletagmanager.com");
  expect(csp).toContain("https://www.google-analytics.com");
});
