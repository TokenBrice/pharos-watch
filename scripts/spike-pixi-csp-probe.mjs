import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:8788/lighthouse-spike/";
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push({ kind: "pageerror", msg: e.message }));
page.on("console", (m) => { if (m.type() === "error") errors.push({ kind: "console.error", msg: m.text() }); });
await page.goto(url, { waitUntil: "load" });
await page.waitForSelector("[data-testid=spike-status]", { timeout: 10000 });
await page.waitForTimeout(500);
const status = await page.locator("[data-testid=spike-status]").textContent();
const errText = await page.locator("[data-testid=spike-error]").textContent().catch(() => null);
const cspViolations = errors.filter((e) => /unsafe-eval|EvalError|Refused to evaluate|Refused to compile|CSP/i.test(e.msg));
console.log(JSON.stringify({ status, errText, totalErrors: errors.length, cspViolations, allErrors: errors }, null, 2));
await page.screenshot({ path: "agents/screenshots/2026-04-25-pixi-csp-probe.png" });
await browser.close();
process.exit(status === "ok" && cspViolations.length === 0 ? 0 : 1);
