import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrustStrip } from "@/components/trust-strip";

describe("TrustStrip", () => {
  it("renders three pill links with correct hrefs", () => {
    const html = renderToStaticMarkup(<TrustStrip />);
    // Next.js Link strips trailing slashes during SSR; both /about and /about/ route identically.
    expect(html).toMatch(/href="\/about\/?"/);
    expect(html).toContain("Independent");
    expect(html).toContain('href="https://github.com/TokenBrice/pharos-watch"');
    expect(html).toContain("MIT");
    expect(html).toMatch(/href="\/funding\/?"/);
    expect(html).toContain("No paid placement");
  });

  it("marks the external GitHub link with rel noopener noreferrer", () => {
    const html = renderToStaticMarkup(<TrustStrip />);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("includes the pharos-focus-ring class on each pill", () => {
    const html = renderToStaticMarkup(<TrustStrip />);
    const matches = html.match(/pharos-focus-ring/g) ?? [];
    expect(matches.length).toBe(3);
  });
});
