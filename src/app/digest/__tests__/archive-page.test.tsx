import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/digest-archive-client", () => ({ DigestArchiveClient: () => null }));
vi.mock("@/components/digest-nameplate", () => ({ DigestNameplate: () => null }));
vi.mock("@/components/digest-colophon", () => ({ DigestColophon: () => null }));
vi.mock("@/components/preferred-source-prompt", () => ({ PreferredSourcePrompt: () => null }));

import DigestArchivePage from "../page";
import { DIGEST_ENTRIES } from "@/lib/digest-registry";

describe("digest archive static navigation", () => {
  it("makes every daily and weekly edition available by month without the client archive", () => {
    const html = renderToStaticMarkup(<DigestArchivePage />);
    const index = html.match(/<nav aria-labelledby="digest-month-index"[\s\S]*?<\/nav>/)?.[0];
    expect(index).toBeDefined();
    expect(index).not.toContain("sr-only");
    const links = Array.from(index!.matchAll(/href="([^"]+)"/g), (match) => match[1]);
    expect(links.sort()).toEqual(
      DIGEST_ENTRIES.map((entry) => `/digest/${entry.date}/`).sort(),
    );
    expect(index!.match(/<summary /g)).toHaveLength(
      new Set(DIGEST_ENTRIES.map((entry) => entry.date.slice(0, 7))).size,
    );
  });
});
