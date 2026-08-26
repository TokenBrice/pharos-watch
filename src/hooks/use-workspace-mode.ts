"use client";

import { useCallback, useEffect, useState } from "react";
import {
  buildWorkspaceModeUrl,
  parseWorkspaceMode,
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
      window.history.replaceState(window.history.state, "", buildWorkspaceModeUrl(window.location, defaultMode));
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
