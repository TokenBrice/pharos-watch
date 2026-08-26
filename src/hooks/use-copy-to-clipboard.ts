"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";

/**
 * Clipboard copy with auto-reset.  Returns `copied` (boolean) and a `copy`
 * function that writes `text` to the clipboard and resets the flag after
 * `resetDelayMs` milliseconds (default 1500).
 *
 * DOM-side only — safe to use in any "use client" component.
 */
export function useCopyToClipboard(resetDelayMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      const result = await copyText(text);
      if (!result.ok) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), resetDelayMs);
    },
    [resetDelayMs],
  );

  return { copied, copy };
}
