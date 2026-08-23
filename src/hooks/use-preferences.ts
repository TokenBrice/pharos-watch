"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getWindowStorage,
  readJsonStorageValue,
  safeStorageRemoveItem,
  writeJsonStorageValue,
} from "@/lib/browser-storage";
export {
  ALL_COLUMNS,
  DEFAULT_VISIBLE_COLUMNS,
  MOBILE_DEFAULT_COLUMNS,
  normalizeVisibleColumns,
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

  useEffect(() => {
    defaultValueRef.current = defaultValue;
    decodeRef.current = decode;
  }, [defaultValue, decode]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const storage = getWindowStorage("local");
      const fallback = defaultValueRef.current;
      const decodeStored = decodeRef.current;
      if (!storage) {
        setStorageLoadedKey(key);
        return;
      }
      const storedValue = readJsonStorageValue(
        storage,
        key,
        (parsed) => (decodeStored ? decodeStored(parsed) : (parsed as T)),
        fallback,
      );
      setValue(storedValue);
      setStorageLoadedKey(key);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [key]);

  // Persist to localStorage on change
  useEffect(() => {
    if (storageLoadedKey !== key) return;
    const storage = getWindowStorage("local");
    if (!storage) return;
    writeJsonStorageValue(storage, key, value);
  }, [key, storageLoadedKey, value]);

  const reset = useCallback(() => {
    setValue(defaultValue);
    safeStorageRemoveItem(getWindowStorage("local"), key);
  }, [key, defaultValue]);

  return [value, setValue, reset];
}
