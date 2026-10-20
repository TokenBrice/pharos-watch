import { describe, expect, it } from "vitest";
import { API_KEY_TIER_VALUES, type ApiKeySummary } from "@pharos/contracts/api-keys";
import {
  buildApiKeyInventoryView,
  buildEditableKeyState,
  buildUpdateApiKeyPayload,
  type ApiKeyInventoryQuery,
} from "../api-key-admin-view-model";
import { makeLargeApiKeyInventory } from "@/test-utils/api-key-fixtures";
import { STATUS_FIXTURE_NOW_SECONDS } from "@/test-utils/status-fixtures";

const NOW_SECONDS = STATUS_FIXTURE_NOW_SECONDS;
const DAY_SECONDS = 86_400;

/** Pinned module defaults — the constants themselves are module-private. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Larger than the 75-key fixture, so a query annotated with it returns every match. */
const UNPAGED = MAX_PAGE_SIZE;

function makeReviewInventory(): ApiKeySummary[] {
  return makeLargeApiKeyInventory().keys.map((key, index) => {
    switch (index) {
      case 0:
        return {
          ...key,
          name: "Fixture expired key",
          ownerEmail: null,
          isActive: true,
          expiresAt: NOW_SECONDS - 3_600,
          lastUsedAt: null,
        };
      case 1:
        return {
          ...key,
          name: "Fixture expiring key",
          isActive: true,
          expiresAt: NOW_SECONDS + DAY_SECONDS,
        };
      case 2:
        return {
          ...key,
          name: "Fixture inactive key",
          isActive: false,
          expiresAt: NOW_SECONDS + 30 * DAY_SECONDS,
        };
      case 3:
        return {
          ...key,
          name: "Fixture non-expiring key",
          isActive: true,
          expiresAt: null,
        };
      case 4:
        return {
          ...key,
          name: "Fixture routine active key",
          isActive: true,
          expiresAt: NOW_SECONDS + 30 * DAY_SECONDS,
        };
      case 11:
        return {
          ...key,
          keyPrefix: "fx_BEACON",
          maskedToken: "fx_BEACON...MASKED",
          name: "Fixture Search Beacon",
          ownerEmail: "Beacon.Owner@Example.Invalid",
          tier: "Priority",
          trafficClass: "external",
          lastUsedRoute: "/api/Fixture-Beacon/Latest",
        };
      default:
        return key;
    }
  });
}

/** Every id the model surfaces for `query`, in model order. */
function inventoryIds(keys: readonly ApiKeySummary[], query: ApiKeyInventoryQuery = {}): number[] {
  return buildApiKeyInventoryView(keys, NOW_SECONDS, { pageSize: UNPAGED, ...query }).keys.map((key) => key.id);
}

describe("API key editor tier projection", () => {
  it.each(API_KEY_TIER_VALUES)("preserves %s through an unrelated rename and save", (tier) => {
    const key = { ...makeReviewInventory()[0]!, tier, expiresAt: null };
    const draft = buildEditableKeyState(key);
    expect(draft.tier).toBe(tier);
    expect(buildUpdateApiKeyPayload({ ...draft, name: "Renamed key" })).toEqual({
      name: "Renamed key",
      ownerEmail: key.ownerEmail,
      tier,
      rateLimitPerMinute: key.rateLimitPerMinute,
      expiresAt: null,
    });
  });

  it("falls back only for an unknown historical tier and allows intentional tier changes", () => {
    const key = { ...makeReviewInventory()[0]!, tier: "legacy-partner", expiresAt: null };
    const draft = buildEditableKeyState(key);
    expect(draft.tier).toBe("standard");
    expect(buildUpdateApiKeyPayload(draft).tier).toBe("standard");
    expect(buildUpdateApiKeyPayload({ ...draft, tier: "donor" }).tier).toBe("donor");
    expect(buildUpdateApiKeyPayload({
      ...buildEditableKeyState({ ...key, tier: "donor" }),
      tier: "standard",
    }).tier).toBe("standard");
  });
});

describe("API key inventory workbench model", () => {
  it("applies inclusive expiry windows and includes non-expiring exceptions only when requested", () => {
    const keys = makeReviewInventory();
    const expiresAt = NOW_SECONDS + DAY_SECONDS;
    const nonExpiringIds = keys.filter((key) => key.expiresAt == null).map((key) => key.id);
    const exactWindow = inventoryIds(keys, {
      status: "all",
      expiryWindow: { expiresFrom: expiresAt, expiresThrough: expiresAt },
    });
    const nextWeek = inventoryIds(keys, {
      status: "all",
      expiryWindow: { expiresFrom: NOW_SECONDS, expiresThrough: NOW_SECONDS + 7 * DAY_SECONDS },
    });
    const nextWeekWithExceptions = inventoryIds(keys, {
      status: "all",
      expiryWindow: {
        expiresFrom: NOW_SECONDS,
        expiresThrough: NOW_SECONDS + 7 * DAY_SECONDS,
        includeNonExpiring: true,
      },
    });

    expect(exactWindow).toEqual([2]);
    expect(nextWeek.some((id) => nonExpiringIds.includes(id))).toBe(false);
    expect(nextWeekWithExceptions.filter((id) => nonExpiringIds.includes(id)).sort((a, b) => a - b)).toEqual(
      [...nonExpiringIds].sort((a, b) => a - b),
    );
  });

  it("bounds page size and corrects fractional, invalid, empty, and out-of-range pages", () => {
    const keys = makeReviewInventory();
    const paged = (query: ApiKeyInventoryQuery) => buildApiKeyInventoryView(keys, NOW_SECONDS, { status: "all", ...query });

    expect(paged({ page: 999, pageSize: 20 })).toMatchObject({
      page: 4,
      pageSize: 20,
      totalItems: 75,
      totalPages: 4,
      firstItemNumber: 61,
      lastItemNumber: 75,
      pageWasCorrected: true,
      pageSizeWasCorrected: false,
    });
    expect(paged({ page: 2.9, pageSize: 10.9 })).toMatchObject({
      page: 2,
      pageSize: 10,
      firstItemNumber: 11,
      lastItemNumber: 20,
      pageWasCorrected: true,
      pageSizeWasCorrected: true,
    });
    expect(paged({ page: 0, pageSize: 0 })).toMatchObject({
      page: 1,
      pageSize: 1,
      pageWasCorrected: true,
      pageSizeWasCorrected: true,
    });
    expect(paged({ page: Number.NaN, pageSize: Number.POSITIVE_INFINITY })).toMatchObject({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      pageWasCorrected: true,
      pageSizeWasCorrected: true,
    });
    expect(buildApiKeyInventoryView([], NOW_SECONDS, { status: "all", page: 99, pageSize: 500 })).toMatchObject({
      keys: [],
      page: 1,
      pageSize: MAX_PAGE_SIZE,
      totalItems: 0,
      totalPages: 1,
      firstItemNumber: 0,
      lastItemNumber: 0,
      pageWasCorrected: true,
      pageSizeWasCorrected: true,
    });
  });
});
