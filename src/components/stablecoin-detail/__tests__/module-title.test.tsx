// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DetailModuleCard,
  StablecoinDetailIdentityProvider,
  StablecoinModuleTitle,
} from "../module-title";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryStateNotice } from "@/components/query-state-notice";
import {
  DETAIL_MODULE_BODY_CLASS, DETAIL_MODULE_HEADER_CLASS,
  DETAIL_MODULE_SHELL_CLASS, DETAIL_MODULE_TITLE_CLASS,
} from "../section-title-class";

/** The visible ticker spans, i.e. the copies a reader sees rather than the sr-only heading text. */
function visibleTickerSpans(symbol: string): Element[] {
  return [...document.querySelectorAll("span")].filter(
    (span) => span.textContent === symbol && !span.classList.contains("sr-only"),
  );
}

describe("StablecoinModuleTitle", () => {
  it("names the coin inside the heading while the visible ticker stays a single visual occurrence", () => {
    render(
      <StablecoinDetailIdentityProvider symbol="BD" logoSrc={undefined}>
        <StablecoinModuleTitle>Reserve quality</StablecoinModuleTitle>
      </StablecoinDetailIdentityProvider>,
    );

    const heading = screen.getByRole("heading", { level: 2, name: "BD Reserve quality" });
    expect(heading.textContent).toBe("BD Reserve quality");
    expect(heading.querySelector(".sr-only")?.textContent).toBe("BD");
    expect(visibleTickerSpans("BD")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "BD logo" })).toBeTruthy();
  });

  it("lets an explicit symbol override the provider identity", () => {
    render(
      <StablecoinDetailIdentityProvider symbol="BD" logoSrc={undefined}>
        <StablecoinModuleTitle symbol="USDC">Reserves</StablecoinModuleTitle>
      </StablecoinDetailIdentityProvider>,
    );

    const heading = screen.getByRole("heading", { level: 2, name: "USDC Reserves" });
    expect(heading.textContent).toBe("USDC Reserves");
    expect(visibleTickerSpans("USDC")).toHaveLength(1);
    expect(visibleTickerSpans("BD")).toHaveLength(0);
  });

  it("keeps the generic label when no coin identity resolves", () => {
    const { container } = render(<StablecoinModuleTitle>Reserves</StablecoinModuleTitle>);

    expect(screen.getByRole("heading", { level: 2, name: "Reserves" })).toBeTruthy();
    expect(container.querySelector(".sr-only")).toBeNull();
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it("keeps the requested heading level and id", () => {
    render(
      <StablecoinDetailIdentityProvider symbol="BD" logoSrc={undefined}>
        <StablecoinModuleTitle as="h3" id="custody-title">Custody</StablecoinModuleTitle>
      </StablecoinDetailIdentityProvider>,
    );

    const heading = screen.getByRole("heading", { level: 3, name: "BD Custody" });
    expect(heading.id).toBe("custody-title");
    expect(document.querySelector("h2")).toBeNull();
  });
});

describe("DetailModuleCard", () => {
  it.each([
    <Skeleton key="loading" className="h-[200px] sm:h-[250px] rounded-xl" />,
    <QueryStateNotice key="unavailable" state="unavailable" label="Distribution" onRetry={() => undefined} />,
    <p key="ready">Observed evidence</p>,
  ])("preserves the plain shell markup for %s", (children) => {
    const title = <span>Evidence <span aria-hidden="true">·</span></span>;
    const headerRight = <span role="status">Updated</span>;
    const reference = (
      <Card className={`${DETAIL_MODULE_SHELL_CLASS} scroll-mt-28`} id="evidence">
        <CardHeader className={DETAIL_MODULE_HEADER_CLASS}>
          <StablecoinModuleTitle className={DETAIL_MODULE_TITLE_CLASS}>{title}</StablecoinModuleTitle>
          {headerRight}
        </CardHeader>
        <CardContent className={`${DETAIL_MODULE_BODY_CLASS} space-y-4`}>{children}</CardContent>
      </Card>
    );
    expect(renderToStaticMarkup(
      <DetailModuleCard title={title} headerRight={headerRight} id="evidence" className="scroll-mt-28" bodyClassName="space-y-4">
        {children}
      </DetailModuleCard>,
    )).toBe(renderToStaticMarkup(reference));
  });
});
