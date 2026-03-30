import type { ReserveSlice } from "@shared/types/core";
import { computeUnknownExposurePct, slicesFromValues } from "./slice-math";

interface BucketedExposureOptions<Item, Bucket extends string> {
  items: Item[];
  getValue: (item: Item) => number;
  getBucket: (item: Item) => Bucket;
  isUnknown?: (item: Item, bucket: Bucket) => boolean;
  getUnknownKey?: (item: Item) => string;
}

export interface ValueBucketRule<Item, Bucket extends string = string> {
  key: Bucket;
  name: string | ((item: Item) => string);
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  blacklistable?: boolean;
  match: (item: Item) => boolean;
}

interface ClassifyBucketedValuesOptions<Item, Bucket extends string> {
  items: Item[];
  rules: readonly ValueBucketRule<Item, Bucket>[];
  getValue: (item: Item) => number;
  getUnknownLabel: (item: Item) => string;
  totalValue?: number;
  decimals?: number;
  unknownSliceName?: string;
  unknownRisk?: ReserveSlice["risk"];
}

export interface ClassifiedBucketedValuesResult<Bucket extends string> {
  slices: ReserveSlice[];
  bucketTotals: Map<Bucket, number>;
  unknownItems: string[];
  unknownValue: number;
  unknownExposurePct: number;
}

export function accumulateBucketedExposure<Item, Bucket extends string>({
  items,
  getValue,
  getBucket,
  isUnknown,
  getUnknownKey,
}: BucketedExposureOptions<Item, Bucket>): {
  bucketTotals: Map<Bucket, number>;
  totalValue: number;
  unknownValue: number;
  unknownValuesByKey: Map<string, number>;
} {
  const bucketTotals = new Map<Bucket, number>();
  const unknownValuesByKey = new Map<string, number>();
  let totalValue = 0;
  let unknownValue = 0;

  for (const item of items) {
    const value = getValue(item);
    if (!Number.isFinite(value) || value <= 0) continue;

    totalValue += value;
    const bucket = getBucket(item);
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + value);

    if (isUnknown?.(item, bucket)) {
      unknownValue += value;
      const key = getUnknownKey?.(item);
      if (key) {
        unknownValuesByKey.set(key, (unknownValuesByKey.get(key) ?? 0) + value);
      }
    }
  }

  return { bucketTotals, totalValue, unknownValue, unknownValuesByKey };
}

export function classifyBucketedValues<Item, Bucket extends string>({
  items,
  rules,
  getValue,
  getUnknownLabel,
  totalValue,
  decimals = 1,
  unknownSliceName = "Unmapped reserve positions",
  unknownRisk = "high",
}: ClassifyBucketedValuesOptions<Item, Bucket>): ClassifiedBucketedValuesResult<Bucket> {
  const bucketTotals = new Map<Bucket, number>();
  const bucketNames = new Map<Bucket, string>();
  const unknownItems: string[] = [];
  let knownValue = 0;
  let unknownValue = 0;

  for (const item of items) {
    const value = getValue(item);
    if (!Number.isFinite(value) || value <= 0) continue;

    const rule = rules.find((candidate) => candidate.match(item));
    if (!rule) {
      unknownItems.push(getUnknownLabel(item));
      unknownValue += value;
      continue;
    }

    knownValue += value;
    bucketTotals.set(rule.key, (bucketTotals.get(rule.key) ?? 0) + value);
    if (!bucketNames.has(rule.key)) {
      bucketNames.set(
        rule.key,
        typeof rule.name === "function" ? rule.name(item) : rule.name,
      );
    }
  }

  const slices = slicesFromValues(
    [
      ...rules.flatMap((rule) => {
        const value = bucketTotals.get(rule.key);
        if (value == null || value <= 0) return [];
        return [{
          value,
          name: bucketNames.get(rule.key) ?? (typeof rule.name === "string" ? rule.name : rule.key),
          risk: rule.risk,
          ...(rule.coinId ? { coinId: rule.coinId } : {}),
          ...(rule.depType ? { depType: rule.depType } : {}),
          ...(rule.blacklistable != null ? { blacklistable: rule.blacklistable } : {}),
        }];
      }),
      ...(unknownValue > 0
        ? [{ value: unknownValue, name: unknownSliceName, risk: unknownRisk }]
        : []),
    ],
    decimals,
  );

  return {
    slices,
    bucketTotals,
    unknownItems: unknownItems.sort((a, b) => a.localeCompare(b)),
    unknownValue,
    unknownExposurePct: computeUnknownExposurePct(unknownValue, totalValue ?? (knownValue + unknownValue)),
  };
}
