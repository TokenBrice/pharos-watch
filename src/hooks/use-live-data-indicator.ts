"use client";

import { useState, useEffect, useRef } from "react";

interface DataPoint {
  value: number;
  timestamp: number;
}

interface LiveDataIndicator {
  isFresh: boolean;
  direction: "up" | "down" | "flat";
  previousValue: number | null;
}

/**
 * Hook to track data changes and provide visual feedback indicators
 * Returns whether data is "fresh" (recently changed) and the direction of change
 */
export function useLiveDataIndicator(
  currentValue: number | null | undefined,
  duration: number = 3000
): LiveDataIndicator {
  const [indicator, setIndicator] = useState<LiveDataIndicator>({
    isFresh: false,
    direction: "flat",
    previousValue: null,
  });

  const previousValueRef = useRef<number | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (currentValue == null) return;

    const previousValue = previousValueRef.current;

    // Only trigger if we have a previous value and it changed
    if (previousValue !== null && previousValue !== currentValue) {
      const direction: "up" | "down" | "flat" =
        currentValue > previousValue ? "up" : currentValue < previousValue ? "down" : "flat";

      // Clear existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      setIndicator({
        isFresh: true,
        direction,
        previousValue,
      });

      // Clear the indicator after duration
      timeoutRef.current = setTimeout(() => {
        setIndicator((prev) => ({
          ...prev,
          isFresh: false,
        }));
      }, duration);
    }

    // Update previous value
    previousValueRef.current = currentValue;

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [currentValue, duration]);

  return indicator;
}

/**
 * Hook to track multiple data points and their freshness
 */
export function useLiveDataIndicators<T extends Record<string, number | null | undefined>>(
  data: T,
  duration: number = 3000
): Record<keyof T, LiveDataIndicator> {
  const [indicators, setIndicators] = useState<Record<string, LiveDataIndicator>>({});
  const previousValuesRef = useRef<Record<string, number | null>>({});
  const timeoutsRef = useRef<Record<string, NodeJS.Timeout>>({});

  useEffect(() => {
    const newIndicators: Record<string, LiveDataIndicator> = {};
    let hasChanges = false;

    Object.entries(data).forEach(([key, currentValue]) => {
      if (currentValue == null) {
        newIndicators[key] = {
          isFresh: false,
          direction: "flat",
          previousValue: null,
        };
        return;
      }

      const previousValue = previousValuesRef.current[key];

      if (previousValue !== null && previousValue !== currentValue) {
        const direction: "up" | "down" | "flat" =
          currentValue > previousValue ? "up" : currentValue < previousValue ? "down" : "flat";

        if (timeoutsRef.current[key]) {
          clearTimeout(timeoutsRef.current[key]);
        }

        newIndicators[key] = {
          isFresh: true,
          direction,
          previousValue,
        };

        timeoutsRef.current[key] = setTimeout(() => {
          setIndicators((prev) => ({
            ...prev,
            [key]: {
              ...prev[key],
              isFresh: false,
            },
          }));
        }, duration);

        hasChanges = true;
      } else {
        newIndicators[key] = indicators[key] || {
          isFresh: false,
          direction: "flat",
          previousValue: previousValue,
        };
      }

      previousValuesRef.current[key] = currentValue;
    });

    if (hasChanges) {
      setIndicators(newIndicators);
    }

    return () => {
      Object.values(timeoutsRef.current).forEach((timeout) => clearTimeout(timeout));
    };
  }, [data, duration, indicators]);

  return indicators as Record<keyof T, LiveDataIndicator>;
}
