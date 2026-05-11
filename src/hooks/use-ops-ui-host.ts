"use client";

import { useEffect, useState } from "react";
import { isOpsUiHost } from "@/lib/admin-access";

export function useOpsUiHost(): boolean | null {
  const [opsUiHost, setOpsUiHost] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const update = () => {
      if (!cancelled) {
        setOpsUiHost(isOpsUiHost());
      }
    };

    if (typeof queueMicrotask === "function") {
      queueMicrotask(update);
    } else {
      window.setTimeout(update, 0);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return opsUiHost;
}
