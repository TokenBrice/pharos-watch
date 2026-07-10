import { describe, expect, it } from "vitest";
import type { ApiKeySummary } from "@shared/types";
import {
  API_KEY_INVENTORY_DEFAULT_PAGE_SIZE,
  API_KEY_INVENTORY_MAX_PAGE_SIZE,
  DEFAULT_API_KEY_INVENTORY_SORT,
  buildApiKeyInventoryView,
  filterApiKeys,
  getApiKeyInventoryStatus,
  paginateApiKeys,
  searchApiKeys,
  sortApiKeys,
} from "../api-key-admin-view-model";
import { makeLargeApiKeyInventory } from "@/test-utils/api-key-fixtures";
import { STATUS_FIXTURE_NOW_SECONDS } from "@/test-utils/status-fixtures";

const NOW_SECONDS = STATUS_FIXTURE_NOW_SECONDS;
const DAY_SECONDS = 86_400;

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
      expect(searchApiKeys(keys, search).map((key) => key.id)).toContain(expectedId);
    }

    expect(searchApiKeys(keys, "beacon.owner fixture-beacon/latest").map((key) => key.id)).toEqual([expectedId]);
    expect(searchApiKeys(keys, "   ")).toEqual(keys);
  });

  it("classifies mutually exclusive statuses and builds the attention filter from them", () => {
    const keys = makeReviewInventory();

    expect(keys.slice(0, 5).map((key) => getApiKeyInventoryStatus(key, NOW_SECONDS))).toEqual([
      "expired",
      "expiring-soon",
      "inactive",
      "non-expiring",
      "active",
    ]);
    expect(getApiKeyInventoryStatus({ ...keys[0], isActive: false }, NOW_SECONDS)).toBe("inactive");
    expect(
      getApiKeyInventoryStatus({ ...keys[1], isActive: false, expiresAt: NOW_SECONDS + DAY_SECONDS }, NOW_SECONDS),
    ).toBe("inactive");
    expect(getApiKeyInventoryStatus({ ...keys[3], isActive: false, expiresAt: null }, NOW_SECONDS)).toBe("inactive");

    for (const status of ["expired", "expiring-soon", "inactive", "non-expiring", "active"] as const) {
      const matches = filterApiKeys(keys, { status }, NOW_SECONDS);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((key) => getApiKeyInventoryStatus(key, NOW_SECONDS) === status)).toBe(true);
    }

    expect(
      filterApiKeys(keys, { status: "attention" }, NOW_SECONDS).every(
        (key) => getApiKeyInventoryStatus(key, NOW_SECONDS) !== "active",
      ),
    ).toBe(true);
  });

  it("applies inclusive expiry windows and includes non-expiring exceptions only when requested", () => {
    const keys = makeReviewInventory();
    const expiresAt = NOW_SECONDS + DAY_SECONDS;
    const exactWindow = filterApiKeys(
      keys,
      {
        status: "all",
        expiryWindow: { expiresFrom: expiresAt, expiresThrough: expiresAt },
      },
      NOW_SECONDS,
    );
    const nextWeek = filterApiKeys(
      keys,
      {
        status: "all",
        expiryWindow: { expiresFrom: NOW_SECONDS, expiresThrough: NOW_SECONDS + 7 * DAY_SECONDS },
      },
      NOW_SECONDS,
    );
    const nextWeekWithExceptions = filterApiKeys(
      keys,
      {
        status: "all",
        expiryWindow: {
          expiresFrom: NOW_SECONDS,
          expiresThrough: NOW_SECONDS + 7 * DAY_SECONDS,
          includeNonExpiring: true,
        },
      },
      NOW_SECONDS,
    );

    expect(exactWindow.map((key) => key.id)).toEqual([2]);
    expect(nextWeek.every((key) => key.expiresAt != null)).toBe(true);
    expect(nextWeekWithExceptions.filter((key) => key.expiresAt == null)).toEqual(
      keys.filter((key) => key.expiresAt == null),
    );
  });

  it("combines null-owner, owner, tier, and traffic-class filters without fuzzy matches", () => {
    const keys = makeReviewInventory();

    expect(filterApiKeys(keys, { owner: null }, NOW_SECONDS).map((key) => key.id)).toEqual([1]);
    expect(filterApiKeys(keys, { owner: "beacon.owner@example.invalid" }, NOW_SECONDS).map((key) => key.id)).toEqual([
      12,
    ]);
    expect(
      filterApiKeys(
        keys,
        { owner: "BEACON.OWNER@EXAMPLE.INVALID", tier: "priority", trafficClass: "external" },
        NOW_SECONDS,
      ).map((key) => key.id),
    ).toEqual([12]);
    expect(filterApiKeys(keys, { owner: "beacon", tier: "priority" }, NOW_SECONDS)).toEqual([]);
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

    expect(sortApiKeys(sortable, { field: "expiry", direction: "asc" }, NOW_SECONDS).map((key) => key.id)).toEqual([
      1, 2, 5, 4,
    ]);
    expect(sortApiKeys(sortable, { field: "expiry", direction: "desc" }, NOW_SECONDS).map((key) => key.id)).toEqual([
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

    expect(sortApiKeys(sortable, { field: "last-use", direction: "asc" }, NOW_SECONDS).map((key) => key.id)).toEqual([
      2, 3, 4, 1,
    ]);
    expect(sortApiKeys(sortable, { field: "last-use", direction: "desc" }, NOW_SECONDS).map((key) => key.id)).toEqual([
      4, 2, 3, 1,
    ]);
  });

  it("sorts rate limit and case-insensitive names deterministically", () => {
    const keys = makeReviewInventory();
    const rateLimitSorted = sortApiKeys(keys, { field: "rate-limit", direction: "asc" }, NOW_SECONDS);
    const rateLimitDescending = sortApiKeys(keys, { field: "rate-limit", direction: "desc" }, NOW_SECONDS);
    const named = [
      { ...keys[2], name: "Beta" },
      { ...keys[1], name: "ALPHA" },
      { ...keys[0], name: "alpha" },
    ];

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
    expect(sortApiKeys(named, { field: "name", direction: "asc" }, NOW_SECONDS).map((key) => key.id)).toEqual([
      1, 2, 3,
    ]);
    expect(sortApiKeys(named, { field: "name", direction: "desc" }, NOW_SECONDS).map((key) => key.id)).toEqual([
      3, 1, 2,
    ]);
  });

  it("uses status priority by default and applies the id tie-break within each status", () => {
    const keys = makeReviewInventory();
    const attentionKeys = filterApiKeys(keys, { status: "attention" }, NOW_SECONDS);
    const expected = sortApiKeys(attentionKeys, DEFAULT_API_KEY_INVENTORY_SORT, NOW_SECONDS);
    const view = buildApiKeyInventoryView(keys, NOW_SECONDS);
    const priorities = new Map([
      ["expired", 0],
      ["expiring-soon", 1],
      ["inactive", 2],
      ["non-expiring", 3],
      ["active", 4],
    ] as const);

    expect(view.totalInventoryItems).toBe(75);
    expect(view.totalItems).toBe(attentionKeys.length);
    expect(view.keys).toEqual(expected.slice(0, API_KEY_INVENTORY_DEFAULT_PAGE_SIZE));
    expect(view.keys.every((key) => getApiKeyInventoryStatus(key, NOW_SECONDS) !== "active")).toBe(true);
    expect(
      sortApiKeys(keys.slice(0, 5), { field: "status", direction: "desc" }, NOW_SECONDS).map((key) => key.id),
    ).toEqual([5, 4, 3, 2, 1]);
    for (let index = 1; index < expected.length; index += 1) {
      const previous = expected[index - 1];
      const current = expected[index];
      const previousStatus = getApiKeyInventoryStatus(previous, NOW_SECONDS);
      const currentStatus = getApiKeyInventoryStatus(current, NOW_SECONDS);
      const previousPriority = priorities.get(previousStatus);
      const currentPriority = priorities.get(currentStatus);
      if (previousPriority == null || currentPriority == null) {
        throw new Error("Missing API key status priority fixture");
      }
      expect(previousPriority).toBeLessThanOrEqual(currentPriority);
      if (previousStatus === currentStatus) {
        expect(previous.id).toBeLessThan(current.id);
      }
    }
  });

  it("bounds page size and corrects fractional, invalid, empty, and out-of-range pages", () => {
    const keys = makeReviewInventory();

    expect(paginateApiKeys(keys, 999, 20)).toMatchObject({
      page: 4,
      pageSize: 20,
      totalItems: 75,
      totalPages: 4,
      firstItemNumber: 61,
      lastItemNumber: 75,
      pageWasCorrected: true,
      pageSizeWasCorrected: false,
    });
    expect(paginateApiKeys(keys, 2.9, 10.9)).toMatchObject({
      page: 2,
      pageSize: 10,
      firstItemNumber: 11,
      lastItemNumber: 20,
      pageWasCorrected: true,
      pageSizeWasCorrected: true,
    });
    expect(paginateApiKeys(keys, 0, 0)).toMatchObject({
      page: 1,
      pageSize: 1,
      pageWasCorrected: true,
      pageSizeWasCorrected: true,
    });
    expect(paginateApiKeys(keys, Number.NaN, Number.POSITIVE_INFINITY)).toMatchObject({
      page: 1,
      pageSize: API_KEY_INVENTORY_DEFAULT_PAGE_SIZE,
      pageWasCorrected: true,
      pageSizeWasCorrected: true,
    });
    expect(paginateApiKeys([], 99, 500)).toMatchObject({
      keys: [],
      page: 1,
      pageSize: API_KEY_INVENTORY_MAX_PAGE_SIZE,
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
