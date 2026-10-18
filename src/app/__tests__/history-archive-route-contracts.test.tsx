import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { METHODOLOGY_CHANGELOG_REGISTRY } from "@shared/lib/methodology-versions/registry";
import {
  METHODOLOGY_HISTORY_ARCHIVES,
  METHODOLOGY_RECENT_VERSIONS,
  methodologyArchivePath,
  methodologyDetailAnchors,
  methodologyHistoryAnchor,
} from "@shared/lib/methodology-versions/archives";
import { changelogs } from "@/data/changelogs";
import { CHANGELOG_MONTH_ARCHIVES, RECENT_CHANGELOGS } from "@/lib/changelog-history";
import { PUBLIC_ROUTE_PATHS } from "@/lib/public-route-inventory";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("next/link", async () => {
  // Vitest hoists mock factories, so load the real shared mock helper inside the factory.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});
vi.mock("@/components/longform-scrollspy-nav", () => ({ LongformScrollspyNav: () => null }));

import MethodologyPage from "@/app/methodology/[slug]/page";
import MethodologyArchivePage, * as methodologyArchiveRoute from "@/app/methodology/[slug]/archive/[archive]/page";
import ChangelogPage from "@/app/changelog/page";
import ChangelogArchivePage, * as changelogArchiveRoute from "@/app/changelog/archive/[month]/page";

function idsIn(html: string) {
  return Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
}

describe("registry-backed static history documents", () => {
  it("enrolls exactly the generated archive params in the public inventory", () => {
    expect(methodologyArchiveRoute.generateStaticParams()).toEqual(METHODOLOGY_HISTORY_ARCHIVES.map(({ slug, archive }) => ({ slug, archive })));
    expect(changelogArchiveRoute.generateStaticParams()).toEqual(CHANGELOG_MONTH_ARCHIVES.map(({ month }) => ({ month })));
    for (const archive of [...METHODOLOGY_HISTORY_ARCHIVES, ...CHANGELOG_MONTH_ARCHIVES]) expect(PUBLIC_ROUTE_PATHS).toContain(archive.path);
    expect(PUBLIC_ROUTE_PATHS).toContain("/api/reference/");
    for (const changelog of METHODOLOGY_CHANGELOG_REGISTRY) {
      expect(METHODOLOGY_HISTORY_ARCHIVES.filter((archive) => archive.changelog.key === changelog.key).flatMap((archive) => archive.entries)).toEqual(changelog.entries);
    }
  });

  it.each(METHODOLOGY_CHANGELOG_REGISTRY)("keeps every $key citation and archive link on a compact overview", async (changelog) => {
    const slug = changelog.publicPath.split("/")[2];
    const html = renderToStaticMarkup(await MethodologyPage({ params: Promise.resolve({ slug }) }));
    const ids = idsIn(html);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of changelog.entries) expect(ids).toContain(methodologyHistoryAnchor(changelog, entry.version));
    for (const entry of changelog.entries.slice(METHODOLOGY_RECENT_VERSIONS)) {
      expect(html).toContain(`${methodologyArchivePath(changelog, entry.version)}#${methodologyHistoryAnchor(changelog, entry.version)}`);
      for (const anchor of methodologyDetailAnchors(entry.detail)) expect(ids).toContain(anchor.id);
    }
    // Component markup guard; the final Next HTML/Flight budget is checked on the export.
    expect(new TextEncoder().encode(html).length).toBeLessThan(300 * 1024);
  });

  it("preserves each historical PDF release in its full archive, before the unknown-path fallback", async () => {
    const rules = readFileSync("public/_redirects", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const [source, destination, status] = line.split(/\s+/);
        return { source, destination, status };
      });
    const aliases = rules.filter(({ source }) => /^\/methodology\/pdf\/.+-v[\d.]+\.pdf$/.test(source));
    expect(aliases.map(({ source }) => source)).toContain("/methodology/pdf/scoring-v7.26.pdf");
    const archiveMarkup = new Map<string, string>();

    for (const alias of aliases) {
      const [, name, version] = alias.source.match(/^\/methodology\/pdf\/(.+)-v([\d.]+)\.pdf$/)!;
      const changelog = METHODOLOGY_CHANGELOG_REGISTRY.find(({ key }) => key === (name === "scoring" ? "safety-score" : name));
      expect(changelog, alias.source).toBeDefined();
      if (!changelog) throw new Error(`Unregistered methodology PDF: ${alias.source}`);
      expect(changelog.entries.some((entry) => entry.version === version), alias.source).toBe(true);
      const path = methodologyArchivePath(changelog, version);
      const anchor = methodologyHistoryAnchor(changelog, version);
      expect(alias).toMatchObject({ destination: `${path}#${anchor}`, status: "301" });
      const archive = METHODOLOGY_HISTORY_ARCHIVES.find((item) => item.path === path);
      expect(archive, path).toBeDefined();
      if (!archive) throw new Error(`Missing methodology archive: ${path}`);
      if (!archiveMarkup.has(path)) {
        archiveMarkup.set(path, renderToStaticMarkup(await MethodologyArchivePage({
          params: Promise.resolve({ slug: archive.slug, archive: archive.archive }),
        })));
      }
      expect(idsIn(archiveMarkup.get(path)!)).toContain(anchor);
      expect(rules.indexOf(alias)).toBeLessThan(rules.findIndex(({ source }) => source === "/methodology/pdf/*"));
    }

    const unknownPath = "/methodology/pdf/unregistered-v999.0.pdf";
    expect(rules.find(({ source }) => source === unknownPath || (
      source.endsWith("*") && unknownPath.startsWith(source.slice(0, -1))
    ))).toMatchObject({ source: "/methodology/pdf/*", destination: "/methodology/", status: "301" });
  });

  it("retains every weekly fragment on the hub while older bodies live only in complete month archives", () => {
    const html = renderToStaticMarkup(<ChangelogPage />);
    const ids = idsIn(html);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of changelogs) {
      expect(ids).toContain(`week-${entry.dateRange.to}`);
      expect(ids).toContain(entry.dateRange.to);
    }
    for (const archive of CHANGELOG_MONTH_ARCHIVES) expect(html).toContain(archive.path);
    expect(RECENT_CHANGELOGS).toHaveLength(2);
    expect(CHANGELOG_MONTH_ARCHIVES.flatMap((archive) => archive.entries)).toEqual(changelogs);
    expect(new TextEncoder().encode(html).length).toBeLessThan(300 * 1024);
  });

  it("gives archive documents self-canonicals and rejects missing archives", async () => {
    const archive = METHODOLOGY_HISTORY_ARCHIVES[0];
    const params = Promise.resolve({ slug: archive.slug, archive: archive.archive });
    expect((await methodologyArchiveRoute.generateMetadata({ params })).alternates?.canonical).toBe(archive.path);
    const month = CHANGELOG_MONTH_ARCHIVES[0];
    expect((await changelogArchiveRoute.generateMetadata({ params: Promise.resolve({ month: month.month }) })).alternates?.canonical).toBe(month.path);
    await expect(MethodologyArchivePage({ params: Promise.resolve({ slug: archive.slug, archive: "v999" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(ChangelogArchivePage({ params: Promise.resolve({ month: "1900-01" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
