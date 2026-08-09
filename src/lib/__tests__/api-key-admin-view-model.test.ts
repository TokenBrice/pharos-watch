import { describe, expect, it } from "vitest";
import type { ApiKeySummary } from "@shared/types";
import {
  buildApiKeyExpiryWindow,
  buildApiKeyInventoryView,
  type ApiKeyInventoryQuery,
  type ApiKeyInventoryStatus,
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

const INVENTORY_STATUSES: readonly ApiKeyInventoryStatus[] = [
  "expired",
  "expiring-soon",
  "inactive",
  "non-expiring",
  "active",
];

const STATUS_PRIORITY: Readonly<Record<ApiKeyInventoryStatus, number>> = {
  expired: 0,
  "expiring-soon": 1,
  inactive: 2,
  "non-expiring": 3,
  active: 4,
};

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

/** Status per key, read back through the model's own status filters. */
function statusById(keys: readonly ApiKeySummary[]): Map<number, ApiKeyInventoryStatus> {
  const byId = new Map<number, ApiKeyInventoryStatus>();
  for (const status of INVENTORY_STATUSES) {
    for (const id of inventoryIds(keys, { status })) byId.set(id, status);
  }
  return byId;
}

describe("API key inventory workbench model", () => {
  it("uses a sanitized 75-key inventory with nullable review fields", () => {
    const keys = makeReviewInventory();

    expect(keys).toHaveLength(75);
    expect(keys.some((key) => key.ownerEmail == null)).toBe(true);
    expect(keys.some((key) => key.expiresAt == null)).toBe(true);
    expect(keys.some((key) => key.lastUsedAt == null)).toBe(true);
    expect(
      keys.filter((key) => key.ownerEmail != null).every((key) => key.ownerEmail?.toLowerCase().endsWith(".invalid")),
    ).toBe(true);
  });

  it("searches every planned field case-insensitively and supports multi-term queries", () => {
    const keys = makeReviewInventory();
    const expectedId = 12;

    for (const search of [
      "SEARCH BEACON",
      "beacon.owner@example.invalid",
      "FX_BEACON",
      "beacon...masked",
      "PRIORITY",
      "FIXTURE-BEACON/LATEST",
    ]) {
      expect(inventoryIds(keys, { search, status: "all" })).toContain(expectedId);
    }

    expect(inventoryIds(keys, { search: "beacon.owner fixture-beacon/latest", status: "all" })).toEqual([expectedId]);
    expect(inventoryIds(keys, { search: "   ", status: "all" })).toHaveLength(keys.length);
  });

  it("classifies mutually exclusive statuses and builds the attention filter from them", () => {
    const keys = makeReviewInventory();
    const firstFive = keys.slice(0, 5);

    // The fixture seeds one key per status, in declaration order.
    INVENTORY_STATUSES.forEach((status, index) => {
      expect(inventoryIds(firstFive, { status })).toEqual([index + 1]);
    });

    // Deactivation outranks every expiry-derived status.
    for (const deactivated of [
      { ...keys[0], isActive: false },
      { ...keys[1], isActive: false, expiresAt: NOW_SECONDS + DAY_SECONDS },
      { ...keys[3], isActive: false, expiresAt: null },
    ]) {
      expect(inventoryIds([deactivated], { status: "inactive" })).toEqual([deactivated.id]);
    }

    const byStatus = INVENTORY_STATUSES.map((status) => inventoryIds(keys, { status }));
    for (const ids of byStatus) expect(ids.length).toBeGreaterThan(0);
    expect(byStatus.flat()).toHaveLength(keys.length);

    const attention = inventoryIds(keys, { status: "attention" });
    const active = inventoryIds(keys, { status: "active" });
    expect(attention.some((id) => active.includes(id))).toBe(false);
    expect([...attention, ...active].sort((a, b) => a - b)).toEqual(keys.map((key) => key.id).sort((a, b) => a - b));
  });

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

  it("maps expiration presets to explicit rolling windows", () => {
    expect(buildApiKeyExpiryWindow("any", NOW_SECONDS)).toBeNull();
    expect(buildApiKeyExpiryWindow("expired", NOW_SECONDS)).toEqual({ expiresThrough: NOW_SECONDS });
    expect(buildApiKeyExpiryWindow("next-7-days", NOW_SECONDS)).toEqual({
      expiresFrom: NOW_SECONDS,
      expiresThrough: NOW_SECONDS + 7 * DAY_SECONDS,
    });
    expect(buildApiKeyExpiryWindow("next-30-days", NOW_SECONDS)).toEqual({
      expiresFrom: NOW_SECONDS,
      expiresThrough: NOW_SECONDS + 30 * DAY_SECONDS,
    });
    expect(buildApiKeyExpiryWindow("after-30-days", NOW_SECONDS)).toEqual({
      expiresFrom: NOW_SECONDS + 30 * DAY_SECONDS,
    });
  });

  it("combines null-owner, owner, tier, and traffic-class filters without fuzzy matches", () => {
    const keys = makeReviewInventory();

    expect(inventoryIds(keys, { status: "all", owner: null })).toEqual([1]);
    expect(inventoryIds(keys, { status: "all", owner: "beacon.owner@example.invalid" })).toEqual([12]);
    expect(
      inventoryIds(keys, {
        status: "all",
        owner: "BEACON.OWNER@EXAMPLE.INVALID",
        tier: "priority",
        trafficClass: "external",
      }),
    ).toEqual([12]);
    expect(inventoryIds(keys, { status: "all", owner: "beacon", tier: "priority" })).toEqual([]);
  });

  it("sorts expiry in both directions with nulls last and id as the stable tie-break", () => {
    const keys = makeReviewInventory();
    const sortable = [
      { ...keys[3], expiresAt: null },
      { ...keys[1], expiresAt: NOW_SECONDS + 10 },
      { ...keys[4], expiresAt: NOW_SECONDS + 20 },
      { ...keys[0], expiresAt: NOW_SECONDS + 10 },
    ];
    const originalIds = sortable.map((key) => key.id);

    expect(inventoryIds(sortable, { status: "all", sort: { field: "expiry", direction: "asc" } })).toEqual([1, 2, 5, 4]);
    expect(inventoryIds(sortable, { status: "all", sort: { field: "expiry", direction: "desc" } })).toEqual([
      5, 1, 2, 4,
    ]);
    expect(sortable.map((key) => key.id)).toEqual(originalIds);
  });

  it("sorts last use in both directions with never-used keys last", () => {
    const keys = makeReviewInventory();
    const sortable = [
      { ...keys[0], lastUsedAt: null },
      { ...keys[1], lastUsedAt: NOW_SECONDS - 20 },
      { ...keys[2], lastUsedAt: NOW_SECONDS - 20 },
      { ...keys[3], lastUsedAt: NOW_SECONDS - 10 },
    ];

    expect(inventoryIds(sortable, { status: "all", sort: { field: "last-use", direction: "asc" } })).toEqual([
      2, 3, 4, 1,
    ]);
    expect(inventoryIds(sortable, { status: "all", sort: { field: "last-use", direction: "desc" } })).toEqual([
      4, 2, 3, 1,
    ]);
  });

  it("sorts rate limit and case-insensitive names deterministically", () => {
    const keys = makeReviewInventory();
    const byId = new Map(keys.map((key) => [key.id, key] as const));
    const rateLimitSorted = inventoryIds(keys, { status: "all", sort: { field: "rate-limit", direction: "asc" } })
      .map((id) => byId.get(id)!);
    const rateLimitDescending = inventoryIds(keys, { status: "all", sort: { field: "rate-limit", direction: "desc" } })
      .map((id) => byId.get(id)!);
    const named = [
      { ...keys[2], name: "Beta" },
      { ...keys[1], name: "ALPHA" },
      { ...keys[0], name: "alpha" },
    ];

    expect(rateLimitSorted).toHaveLength(keys.length);
    for (let index = 1; index < rateLimitSorted.length; index += 1) {
      const previous = rateLimitSorted[index - 1];
      const current = rateLimitSorted[index];
      expect(previous.rateLimitPerMinute).toBeLessThanOrEqual(current.rateLimitPerMinute);
      if (previous.rateLimitPerMinute === current.rateLimitPerMinute) {
        expect(previous.id).toBeLessThan(current.id);
      }
    }
    for (let index = 1; index < rateLimitDescending.length; index += 1) {
      const previous = rateLimitDescending[index - 1];
      const current = rateLimitDescending[index];
      expect(previous.rateLimitPerMinute).toBeGreaterThanOrEqual(current.rateLimitPerMinute);
      if (previous.rateLimitPerMinute === current.rateLimitPerMinute) {
        expect(previous.id).toBeLessThan(current.id);
      }
    }
    expect(inventoryIds(named, { status: "all", sort: { field: "name", direction: "asc" } })).toEqual([1, 2, 3]);
    expect(inventoryIds(named, { status: "all", sort: { field: "name", direction: "desc" } })).toEqual([3, 1, 2]);
  });

  it("uses status priority by default and applies the id tie-break within each status", () => {
    const keys = makeReviewInventory();
    const statuses = statusById(keys);
    const attentionIds = inventoryIds(keys, { status: "attention" });
    const view = buildApiKeyInventoryView(keys, NOW_SECONDS);

    expect(view.totalInventoryItems).toBe(75);
    expect(view.totalItems).toBe(attentionIds.length);
    expect(view.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(view.keys.map((key) => key.id)).toEqual(attentionIds.slice(0, DEFAULT_PAGE_SIZE));
    expect(view.keys.every((key) => statuses.get(key.id) !== "active")).toBe(true);
    expect(inventoryIds(keys.slice(0, 5), { status: "all", sort: { field: "status", direction: "desc" } })).toEqual([
      5, 4, 3, 2, 1,
    ]);

    for (let index = 1; index < attentionIds.length; index += 1) {
      const previousId = attentionIds[index - 1];
      const currentId = attentionIds[index];
      const previousStatus = statuses.get(previousId);
      const currentStatus = statuses.get(currentId);
      if (previousStatus == null || currentStatus == null) {
        throw new Error("Missing API key status priority fixture");
      }
      expect(STATUS_PRIORITY[previousStatus]).toBeLessThanOrEqual(STATUS_PRIORITY[currentStatus]);
      if (previousStatus === currentStatus) {
        expect(previousId).toBeLessThan(currentId);
      }
    }
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

  it("corrects the requested page after all search and filters are applied", () => {
    const keys = makeReviewInventory();
    const view = buildApiKeyInventoryView(keys, NOW_SECONDS, {
      search: "Fixture Search Beacon",
      status: "all",
      sort: { field: "name", direction: "asc" },
      page: 8,
      pageSize: 10,
    });

    expect(view).toMatchObject({
      totalInventoryItems: 75,
      totalItems: 1,
      totalPages: 1,
      page: 1,
      pageWasCorrected: true,
    });
    expect(view.keys.map((key) => key.id)).toEqual([12]);
  });
});
