import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const checker = resolve(process.cwd(), "scripts/ci/check-phishing-signatures.ts");

function runChecker(html: string) {
  const cwd = mkdtempSync(resolve(tmpdir(), "pharos-phishing-signatures-"));
  mkdirSync(resolve(cwd, "out"));
  writeFileSync(resolve(cwd, "out/index.html"), html);
  try {
    return execFileSync(process.execPath, [checker], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("check-phishing-signatures", () => {
  it("scans executable inline scripts even when they carry data-src attributes", () => {
    expect(() =>
      runChecker(
        `<html><body><script data-src="inline-metadata">try { const params = new URLSearchParams(window.location.hash.slice(1)); window.__PHAROS_TOKEN__ = params.get("token"); history.replaceState(null, "", location.pathname); } catch (error) {}</script></body></html>`,
      ),
    ).toThrow(/Inline-script phishing-kit signatures detected/);
  });

  it("scans inline scripts when src-like text appears inside another attribute value", () => {
    expect(() =>
      runChecker(
        `<html><body><script data-note=" src = not-an-attribute">try { const params = new URLSearchParams(window.location.hash.slice(1)); window.__PHAROS_TOKEN__ = params.get("token"); history.replaceState(null, "", location.pathname); } catch (error) {}</script></body></html>`,
      ),
    ).toThrow(/Inline-script phishing-kit signatures detected/);
  });

  it("continues to skip external script tags that use a real src attribute", () => {
    expect(() =>
      runChecker(
        `<html><body><script src="/bundle.js">try { const params = new URLSearchParams(window.location.hash.slice(1)); window.__PHAROS_TOKEN__ = params.get("token"); history.replaceState(null, "", location.pathname); } catch (error) {}</script></body></html>`,
      ),
    ).not.toThrow();
  });

  it("ignores commented fake external scripts before scanning real inline scripts", () => {
    expect(() =>
      runChecker(
        `<html><body><!-- <script src="/ignored.js"> --><script>try { const params = new URLSearchParams(window.location.hash.slice(1)); window.__PHAROS_TOKEN__ = params.get("token"); history.replaceState(null, "", location.pathname); } catch (error) {}</script></body></html>`,
      ),
    ).toThrow(/Inline-script phishing-kit signatures detected/);
  });

  it("does not scan script-looking markup that only appears inside HTML comments", () => {
    expect(() =>
      runChecker(
        `<html><body><!-- <script>window.__PHAROS_TOKEN__ = "comment-only";</script> --><script src="/bundle.js"></script></body></html>`,
      ),
    ).not.toThrow();
  });

  it("scans executable inline scripts after legacy comment markers inside prior scripts", () => {
    expect(() =>
      runChecker(
        `<html><body><script>console.log("<!-- benign legacy marker");</script><script>try { const params = new URLSearchParams(window.location.hash.slice(1)); window.__PHAROS_TOKEN__ = params.get("token"); history.replaceState(null, "", location.pathname); } catch (error) {}</script></body></html>`,
      ),
    ).toThrow(/Inline-script phishing-kit signatures detected/);
  });

  it("detects inline phishing signatures when script end tags contain browser-accepted spacing", () => {
    expect(() =>
      runChecker(
        `<html><body><script>try { const params = new URLSearchParams(window.location.hash.slice(1)); window.__PHAROS_TOKEN__ = params.get("token"); history.replaceState(null, "", location.pathname); } catch (error) {}</script ></body></html>`,
      ),
    ).toThrow(/Inline-script phishing-kit signatures detected/);
  });
});
