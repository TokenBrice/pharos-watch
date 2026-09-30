import { test, expect, type Page } from "@playwright/test";

// Route-level contracts of /cemetery/ that jsdom cannot observe: the Autopsy
// Register's no-JS `:target` fold, the phone portrait plan's touch geometry
// (the strict mobile smoke exempts SVG and `*map*` targets), and the desktop
// plan's single roving tab stop. Everything is measured from the rendered page;
// no record id, count or class name is pinned.

const REGISTER_ROW_SELECTOR = "#register tbody tr[id]:not([data-detail])";
const PLOT_READY_SELECTOR = '[data-plot-root][data-ready="true"]';
// The register folds rows past the first 25; row 60 is deep inside the fold.
const DEEP_ROW_POSITION = 60;

const PHONE_VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
] as const;

test.describe.configure({ timeout: 90_000 });

/** Register row ids in the server-rendered (canonical, newest-first) order. */
async function registerRowIds(page: Page): Promise<string[]> {
  await page.goto("/cemetery/");
  const ids = await page.locator(REGISTER_ROW_SELECTOR).evaluateAll((rows) => rows.map((row) => row.id));
  expect(ids.length, "register rows rendered on the server").toBeGreaterThan(DEEP_ROW_POSITION);
  return ids;
}

async function expectRecordOnScreen(page: Page, id: string): Promise<void> {
  const row = page.locator(`[id="${id}"]`);
  await expect(row, "linked register row").toBeVisible();
  await expect(row, "linked register row scrolled into view").toBeInViewport();
  // Full rows pair with an `autopsy-<id>` row; the pristine register renders a folded record as one compact row
  // that carries the obituary itself.
  const autopsy = page.locator(`[id="autopsy-${id}"]`);
  const obituary = (await autopsy.count()) > 0 ? autopsy : row;
  await expect(obituary, "linked record's obituary").toBeVisible();
  await expect(obituary, "linked record's obituary in view").toBeInViewport();
  expect((await obituary.innerText()).trim().length, "the obituary carries its text").toBeGreaterThan(40);
}

test.describe("cemetery without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test(`cemetery: /cemetery/#<row ${DEEP_ROW_POSITION} id> shows that row and its obituary on screen`, async ({ page }) => {
    // Known failure on every route: `Providers` wraps the body in `<Suspense fallback={null}>` around the lazy
    // `InteractiveProviders` (src/components/providers.tsx), so the prerendered body streams into a hidden
    // `<div hidden id="S:0">` that only JS swaps in. Without JS the page shows just the skip link. Fixing that flips this.
    test.fail();
    await page.setViewportSize({ width: 1440, height: 800 });
    const id = (await registerRowIds(page))[DEEP_ROW_POSITION - 1];

    await page.goto("about:blank");
    await page.goto(`/cemetery/#${id}`);
    await expectRecordOnScreen(page, id);
  });

  // The register's own CSS contract, independent of the page-level wrapper above: computed styles, not visibility.
  test(`cemetery: the :target fold unfolds /cemetery/#<row ${DEEP_ROW_POSITION} id> and keeps its neighbours folded`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    const ids = await registerRowIds(page);
    const id = ids[DEEP_ROW_POSITION - 1];
    const neighbourId = ids[DEEP_ROW_POSITION];

    await page.goto("about:blank");
    await page.goto(`/cemetery/#${id}`);
    const state = await page.evaluate(
      ([targetId, otherId]) => {
        const display = (element: Element | null) => (element ? getComputedStyle(element).display : null);
        const row = document.getElementById(targetId);
        // Compact folded rows carry the obituary themselves; full rows pair with an `autopsy-<id>` row.
        const obituary = document.getElementById(`autopsy-${targetId}`) ?? row;
        const other = document.getElementById(otherId);
        return {
          rowIsTarget: row?.matches(":target") ?? false,
          rowFolded: row?.hasAttribute("data-folded") ?? false,
          rowDisplay: display(row),
          obituaryDisplay: display(obituary),
          obituaryText: obituary?.textContent?.trim() ?? "",
          otherFolded: other?.hasAttribute("data-folded") ?? false,
          otherDisplay: display(other),
          otherAutopsyDisplay: display(document.getElementById(`autopsy-${otherId}`)),
        };
      },
      [id, neighbourId] as const,
    );

    expect(state.rowFolded, "the linked row sits inside the fold").toBe(true);
    expect(state.rowIsTarget, "the linked row is the :target").toBe(true);
    expect(state.rowDisplay, "the linked row unfolds").toBe("table-row");
    expect(state.obituaryDisplay, "the linked record's obituary shows").toBe("table-row");
    expect(state.obituaryText.length, "the obituary carries its text").toBeGreaterThan(40);
    expect(state.otherFolded, "the neighbouring row sits inside the fold").toBe(true);
    expect(state.otherDisplay, "an unlinked folded row stays folded").toBe("none");
    expect(state.otherAutopsyDisplay ?? "none", "an unlinked obituary stays collapsed").toBe("none");
  });
});

// The legacy alias has no element of its own; the selection provider rewrites it to `#<id>`, so it needs JavaScript.
test("cemetery: the legacy #obituary-<id> alias reveals the canonical record", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const id = (await registerRowIds(page))[DEEP_ROW_POSITION - 1];

  await page.goto("about:blank");
  await page.goto(`/cemetery/#obituary-${id}`);
  await expect.poll(() => new URL(page.url()).hash, { message: "alias normalised to the canonical anchor" }).toBe(`#${id}`);
  await expectRecordOnScreen(page, id);
});

for (const viewport of PHONE_VIEWPORTS) {
  test(`cemetery: phone plan geometry and focus at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/cemetery/");
    await expect(page.locator(PLOT_READY_SELECTOR), "plot map never hydrated").toBeVisible({ timeout: 45_000 });
    await expect(page.locator('a[id^="walk-"]').first(), "phone portrait plan never mounted").toBeAttached();

    const walkBoxes = await page.locator('a[id^="walk-"]').evaluateAll((graves) =>
      graves.map((grave) => {
        const rect = grave.getBoundingClientRect();
        return { id: grave.id, width: rect.width, height: rect.height };
      }),
    );
    expect(walkBoxes.length, "portrait graves").toBeGreaterThan(0);
    expect(
      walkBoxes.filter((box) => box.width < 44 || box.height < 44),
      "portrait grave hit boxes under 44x44",
    ).toEqual([]);

    const duplicateIds = await page.evaluate(() => {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const element of document.querySelectorAll("[id]")) {
        if (seen.has(element.id)) duplicates.add(element.id);
        seen.add(element.id);
      }
      return [...duplicates];
    });
    expect(duplicateIds, "duplicate element ids").toEqual([]);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "document horizontal overflow (px)").toBeLessThanOrEqual(0);

    // Programmatic focus succeeds on any rendered grave, roving tabindex or not,
    // so this proves the desktop hit layer is out of the phone's focus order.
    const desktopGraves = page.locator('a[id^="grave-"]');
    expect(await desktopGraves.count(), "desktop plan graves in the document").toBeGreaterThan(0);
    const focusableDesktopGraves = await desktopGraves.evaluateAll((graves) =>
      graves.filter((grave) => {
        (grave as SVGAElement).focus();
        return document.activeElement === grave;
      }).map((grave) => grave.id),
    );
    expect(focusableDesktopGraves, "focusable desktop graves on a phone").toEqual([]);
  });
}

test("cemetery: the desktop plan exposes exactly one grave tab stop at 1440x800", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/cemetery/");
  const root = page.locator(PLOT_READY_SELECTOR);
  await expect(root, "plot map never hydrated").toBeVisible({ timeout: 45_000 });

  expect(await root.locator("a[data-grave-id]").count(), "hero graves").toBeGreaterThan(1);
  await expect(root.locator('a[data-grave-id][tabindex="0"]'), "hero graves with tabindex=0").toHaveCount(1);
});
