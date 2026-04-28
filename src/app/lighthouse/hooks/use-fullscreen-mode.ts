import { useCallback, useEffect, useState, type RefObject } from "react";

export function useFullscreenMode(shellRef: RefObject<HTMLElement | null>) {
  const [fullscreenMode, setFullscreenMode] = useState(false);

  const exitFullscreen = useCallback(() => {
    const shell = shellRef.current;
    setFullscreenMode(false);
    if (shell && document.fullscreenElement === shell) {
      void document.exitFullscreen?.();
    }
  }, [shellRef]);

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (fullscreenMode) {
      exitFullscreen();
      return;
    }
    setFullscreenMode(true);
    if (document.fullscreenEnabled && document.fullscreenElement !== shell) {
      const request = shell.requestFullscreen?.();
      if (request && typeof request.catch === "function") {
        request.catch(() => {
          // The fixed-position fullscreen class remains as the fallback surface.
        });
      }
    }
  }, [exitFullscreen, fullscreenMode, shellRef]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const handleFullscreenChange = () => {
      if (document.fullscreenElement === shell) {
        setFullscreenMode(true);
      } else if (document.fullscreenElement === null) {
        setFullscreenMode(false);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [shellRef]);

  return { exitFullscreen, fullscreenMode, toggleFullscreen };
}
