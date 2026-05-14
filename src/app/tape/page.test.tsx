import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import TapePage from "@/app/tape/page";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/app/tape/client", () => ({
  TapeClient: () => <div data-testid="tape-client" />,
}));

describe("TapePage", () => {
  it("renders the page shell with title, breadcrumb, CollectionPage + ItemList JSON-LD", () => {
    const html = renderToStaticMarkup(<TapePage />);

    expect(html).toContain("The Tape");
    expect(html).toContain("CollectionPage");
    expect(html).toContain("ItemList");
    // `safeJsonLd` escapes `/` as `/`; check the escaped path instead.
    expect(html).toContain("\\u002ftape\\u002f");
    expect(html).toContain("tape-client");
    // ItemList enumerates all 12 class category links.
    expect(html).toContain("Depegs");
    expect(html).toContain("Freezes");
    expect(html).toContain("Methodology");
  });
});
