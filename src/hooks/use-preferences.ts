"use client";

import { useState, useEffect, useCallback } from "react";
import { getWindowStorage, safeStorageGetItem, safeStorageRemoveItem, safeStorageSetItem } from "@/lib/browser-storage";
export {
  ALL_COLUMNS,
  DEFAULT_VISIBLE_COLUMNS,
  MOBILE_DEFAULT_COLUMNS,
  normalizeVisibleColumns,
  isColumnId,
  LOCKED_COLUMNS,
  type ColumnId,
} from "@/lib/column-visibility";

interface UsePreferenceOptions<T> {
  decode?: (raw: unknown) => T;
}

/**
 * Generic hook that persists a value to localStorage.
 * SSR-safe: returns defaultValue during hydration, syncs after mount.
 */
export function usePreference<T>(
  key: string,
  defaultValue: T,
  options: UsePreferenceOptions<T> = {},
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => {
    const storage = getWindowStorage("local");
    if (!storage) return defaultValue;
    try {
      const stored = safeStorageGetItem(storage, key);
      if (stored === null) {
        return defaultValue;
      }
      const parsed = JSON.parse(stored) as unknown;
      // When no decode function is provided, the parsed value is trusted as T.
      // Callers handling complex types should supply a decoder for runtime validation.
      return options.decode ? options.decode(parsed) : (parsed as T);
    } catch {
      return defaultValue;
    }
  });

  // Persist to localStorage on change
  useEffect(() => {
    const storage = getWindowStorage("local");
    if (!storage) return;
    safeStorageSetItem(storage, key, JSON.stringify(value));
  }, [key, value]);

  const reset = useCallback(() => {
    setValue(defaultValue);
    safeStorageRemoveItem(getWindowStorage("local"), key);
  }, [key, defaultValue]);

  return [value, setValue, reset];
}
