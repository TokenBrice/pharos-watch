"use client";

import { useSyncExternalStore } from "react";
import { isOpsUiHost } from "@/lib/admin-access";

function subscribeToOpsUiHost(): () => void {
  return () => undefined;
}

function getOpsUiHostSnapshot(): boolean | null {
  return isOpsUiHost();
}

function getServerOpsUiHostSnapshot(): boolean | null {
  return null;
}

export function useOpsUiHost(): boolean | null {
  return useSyncExternalStore(
    subscribeToOpsUiHost,
    getOpsUiHostSnapshot,
    getServerOpsUiHostSnapshot,
  );
}
