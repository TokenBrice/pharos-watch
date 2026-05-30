import { useCallback, useMemo } from "react";
import type { useRouter } from "next/navigation";
import {
  buildVerbPreview,
  executeParsedVerb,
  type CommandPaletteVerbPreview,
} from "@/components/command-palette-actions";
import { parsePaletteInput } from "@/lib/command-palette-verbs";

interface UseCommandPaletteVerbActionsOptions {
  query: string;
  router: ReturnType<typeof useRouter>;
  closePalette: () => void;
  addToWatchlist: (stablecoinId: string) => void;
  removeFromWatchlist: (stablecoinId: string) => void;
  clearWatchlist: () => void;
}

interface UseCommandPaletteVerbActionsResult {
  verbPreview: CommandPaletteVerbPreview | null;
  runVerb: () => boolean;
}

export function useCommandPaletteVerbActions({
  query,
  router,
  closePalette,
  addToWatchlist,
  removeFromWatchlist,
  clearWatchlist,
}: UseCommandPaletteVerbActionsOptions): UseCommandPaletteVerbActionsResult {
  const parsedVerb = useMemo(() => parsePaletteInput(query), [query]);

  const runVerb = useCallback((): boolean => {
    return executeParsedVerb(parsedVerb, {
      push: router.push,
      closePalette,
      addToWatchlist,
      removeFromWatchlist,
      clearWatchlist,
    });
  }, [parsedVerb, router, closePalette, addToWatchlist, removeFromWatchlist, clearWatchlist]);

  const verbPreview = useMemo(() => buildVerbPreview(parsedVerb), [parsedVerb]);

  return { verbPreview, runVerb };
}
