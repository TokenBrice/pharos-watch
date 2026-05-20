// Yield — same circle-dollar glyph as the primary navigation, using
// currentColor so the homepage tile can carry its product accent.

import type { JSX } from "react";
import { CircleDollarSign } from "lucide-react";

export function YieldEmblem(): JSX.Element {
  return <CircleDollarSign size={45} strokeWidth={1.75} aria-hidden="true" />;
}
