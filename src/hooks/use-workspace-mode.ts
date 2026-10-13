"use client";

import { useCallback, useEffect, useState } from "react";
import {
  buildWorkspaceModeUrl,
  parseWorkspaceMode,
  WORKSPACE_MODE_QUERY_PARAM,
  type WorkspaceModeOption,
} from "@/lib/status/workspace-mode";

interface UseWorkspaceModeOptions<TMode extends string> {
  modes: readonly WorkspaceModeOption<TMode>[];
  defaultMode: TMode;
}

interface WorkspaceModeController<TMode extends string> {
  activeMode: TMode;
  selectMode: (mode: TMode) => void;
}

export function useWorkspaceMode<TMode extends string>({
  modes,
  defaultMode,
}: UseWorkspaceModeOptions<TMode>): WorkspaceModeController<TMode> {
  const [activeMode, setActiveMode] = useState<TMode>(defaultMode);

  useEffect(() => {
    const syncModeFromUrl = () => {
      const urlMode = parseWorkspaceMode(modes, window.location.search);
      if (urlMode) {
        setActiveMode(urlMode);
        return;
      }
      // A missing view stays bare so the default (first view with findings)
      // is re-derived on every landing; only an invalid view is canonicalized.
      if (new URLSearchParams(window.location.search).has(WORKSPACE_MODE_QUERY_PARAM)) {
        window.history.replaceState(window.history.state, "", buildWorkspaceModeUrl(window.location, defaultMode));
      }
      setActiveMode(defaultMode);
    };

    syncModeFromUrl();
    window.addEventListener("popstate", syncModeFromUrl);
    return () => window.removeEventListener("popstate", syncModeFromUrl);
  }, [defaultMode, modes]);

  const selectMode = useCallback((mode: TMode) => {
    setActiveMode(mode);
    window.history.replaceState(window.history.state, "", buildWorkspaceModeUrl(window.location, mode));
  }, []);

  return { activeMode, selectMode };
}
