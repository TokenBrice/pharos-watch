// Safety — same shield-check glyph as the primary navigation, using
// currentColor so the homepage tile can carry its safety accent.

import type { JSX } from "react";
import { ShieldCheck } from "lucide-react";

export function SafetyEmblem(): JSX.Element {
  return <ShieldCheck size={45} strokeWidth={1.75} aria-hidden="true" />;
}
