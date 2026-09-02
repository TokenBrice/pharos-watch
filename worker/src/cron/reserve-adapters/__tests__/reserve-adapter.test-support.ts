import { expect, vi } from "vitest";
import type { LiveReserveAdapterKey } from "@shared/types/live-reserves";
import { getReserveAdapter } from "../index";
import { validateAdapterOutput } from "../validate";

export const TEST_SIGNAL = AbortSignal.timeout(5_000);

export function mockedReserveHelper<T extends (...args: never[]) => unknown>(helper: T) {
  return vi.mocked(helper);
}

type ValidationInput = Parameters<typeof validateAdapterOutput>[0];
type ValidationOptions = NonNullable<Parameters<typeof validateAdapterOutput>[1]>;

export function expectValidAdapterOutput(
  adapterKey: LiveReserveAdapterKey,
  result: ValidationInput,
  options: Omit<ValidationOptions, "adapter"> = {},
): ReturnType<typeof validateAdapterOutput> {
  const report = validateAdapterOutput(result, {
    ...options,
    adapter: getReserveAdapter(adapterKey) ?? undefined,
  });
  expect(report.valid).toBe(true);
  return report;
}
