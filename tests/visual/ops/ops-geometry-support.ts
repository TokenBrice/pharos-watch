import { expect, test, type Page, type TestInfo } from "@playwright/test";

/**
 * Geometry assertions for the ops lane — no screenshots, no class pins. Each
 * helper measures observable layout facts (bounding boxes, scroll invariants,
 * overflow) so the visual specs can assert the contracts jsdom cannot.
 *
 * BrowserPublic owns the public-lane specs under tests/visual/; this file is
 * ops-lane-only support.
 */

export const GEOMETRY_TOLERANCE_PX = 1;

/** Pin a spec to a single carrier project and size the viewport exactly. */
export async function sizeViewport(page: Page, testInfo: TestInfo, width: number, height: number): Promise<void> {
  test.skip(testInfo.project.name !== "chromium-390", "geometry runs once on the 390 carrier project");
  await page.setViewportSize({ width, height });
}

/** Every element under `scope` must not overflow horizontally. */
export async function expectNoHorizontalOverflow(
  page: Page,
  scope: string,
  tolerance = GEOMETRY_TOLERANCE_PX,
): Promise<void> {
  const overflowing = await page.evaluate(
    ({ scopeSelector, tol }) => {
      return Array.from(document.querySelectorAll<HTMLElement>(scopeSelector))
        .filter((el) => {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          return el.scrollWidth > el.clientWidth + tol;
        })
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          className: typeof el.className === "string" ? el.className : null,
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
        }));
    },
    { scopeSelector: scope, tol: tolerance },
  );

  expect(overflowing, `elements overflowing horizontally within ${scope}`).toEqual([]);
}

/** Thead `y` must be invariant while `viewport` scrolls; scroll must actually move. */
export async function expectStickyHeaderInvariant(
  page: Page,
  viewportSelector: string,
  headerSelector = "thead",
): Promise<void> {
  const viewport = page.locator(viewportSelector).first();
  const header = viewport.locator(headerSelector).first();
  await expect(viewport).toBeVisible();
  await expect(header).toBeVisible();

  const before = await header.boundingBox();
  expect(before, "sticky header must have a measurable box").not.toBeNull();

  const scrolled = await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(scrolled, "table viewport must scroll for a meaningful sticky-header check").toBeGreaterThan(0);

  await page.waitForTimeout(80);
  const after = await header.boundingBox();
  expect(after, "sticky header must stay measurable after scroll").not.toBeNull();
  expect(Math.abs((after!.y ?? 0) - (before!.y ?? 0)), "sticky header y drifts during local scroll").toBeLessThanOrEqual(
    GEOMETRY_TOLERANCE_PX,
  );
}

/** Every direct child of `parent` must be contained within `parent`'s box. */
export async function expectChildrenContained(
  page: Page,
  parentSelector: string,
  tolerance = GEOMETRY_TOLERANCE_PX,
): Promise<void> {
  await expect(page.locator(parentSelector).first()).toBeVisible();
  expect(await page.locator(`${parentSelector} > *`).count(), "containment requires children").toBeGreaterThan(0);
  const escaping = await page.evaluate(
    ({ parentSelector: sel, tol }) => {
      const parents = Array.from(document.querySelectorAll<HTMLElement>(sel));
      const out: Array<{ parentTag: string; parentText: string; childTag: string; childText: string; dx: number }> = [];
      for (const parent of parents) {
        const box = parent.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        for (const child of Array.from(parent.children) as HTMLElement[]) {
          const rect = child.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const left = Math.max(0, box.left - rect.left);
          const right = Math.max(0, rect.right - box.right);
          const top = Math.max(0, box.top - rect.top);
          const bottom = Math.max(0, rect.bottom - box.bottom);
          const dx = Math.max(left, right, top, bottom);
          if (dx > tol) {
            out.push({
              parentTag: parent.tagName.toLowerCase(),
              parentText: (parent.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
              childTag: child.tagName.toLowerCase(),
              childText: (child.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
              dx: Math.round(dx),
            });
          }
        }
      }
      return out;
    },
    { parentSelector, tol: tolerance },
  );

  expect(escaping, `children escaping ${parentSelector}`).toEqual([]);
}
