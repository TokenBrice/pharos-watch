"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  const { decode } = options;
  const [value, setValue] = useState<T>(defaultValue);
  const [storageLoadedKey, setStorageLoadedKey] = useState<string | null>(null);
  const defaultValueRef = useRef(defaultValue);
  const decodeRef = useRef(decode);

  defaultValueRef.current = defaultValue;
  decodeRef.current = decode;

  useEffect(() => {
    const storage = getWindowStorage("local");
    const fallback = defaultValueRef.current;
    const decodeStored = decodeRef.current;
    if (!storage) {
      setStorageLoadedKey(key);
      return;
    }
    try {
      const stored = safeStorageGetItem(storage, key);
      if (stored === null) {
        setValue(fallback);
        setStorageLoadedKey(key);
        return;
      }
      const parsed = JSON.parse(stored) as unknown;
      // When no decode function is provided, the parsed value is trusted as T.
      // Callers handling complex types should supply a decoder for runtime validation.
      setValue(decodeStored ? decodeStored(parsed) : (parsed as T));
    } catch {
      setValue(fallback);
    } finally {
      setStorageLoadedKey(key);
    }
  }, [key]);

  // Persist to localStorage on change
  useEffect(() => {
    if (storageLoadedKey !== key) return;
    const storage = getWindowStorage("local");
    if (!storage) return;
    safeStorageSetItem(storage, key, JSON.stringify(value));
  }, [key, storageLoadedKey, value]);

  const reset = useCallback(() => {
    setValue(defaultValue);
    safeStorageRemoveItem(getWindowStorage("local"), key);
  }, [key, defaultValue]);

  return [value, setValue, reset];
}
