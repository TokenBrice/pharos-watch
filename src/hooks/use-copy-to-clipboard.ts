"use client";

import { useCallback, useState } from "react";

interface UseCopyToClipboardOptions {
  timeout?: number;
  onSuccess?: (text: string) => void;
  onError?: (error: Error) => void;
}

interface CopyState {
  copied: boolean;
  error: Error | null;
}

export function useCopyToClipboard(options: UseCopyToClipboardOptions = {}) {
  const { timeout = 2000, onSuccess, onError } = options;
  const [state, setState] = useState<CopyState>({ copied: false, error: null });

  const copy = useCallback(
    async (text: string) => {
      try {
        if (!navigator.clipboard) {
          throw new Error("Clipboard API not available");
        }

        await navigator.clipboard.writeText(text);
        setState({ copied: true, error: null });
        onSuccess?.(text);

        // Reset after timeout
        setTimeout(() => {
          setState((prev) => ({ ...prev, copied: false }));
        }, timeout);

        return true;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState({ copied: false, error });
        onError?.(error);
        return false;
      }
    },
    [timeout, onSuccess, onError]
  );

  return { copy, ...state };
}
