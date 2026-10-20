import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

describe("StablecoinModuleTitle", () => {
  it("adds the detail-page coin identity so a screenshotted module names its subject", () => {
    const html = renderToStaticMarkup(
      <StablecoinDetailIdentityProvider symbol="BD" logoSrc={undefined}>
        <StablecoinModuleTitle>Reserve quality</StablecoinModuleTitle>
      </StablecoinDetailIdentityProvider>,
    );

    expect(html).toContain('aria-label="BD logo"');
    expect(html).toContain(">BD<");
    expect(html).toContain("Reserve quality");
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
