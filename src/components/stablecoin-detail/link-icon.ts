import { ExternalLink, FileText, Globe, X } from "lucide-react";

/** Header action glyph for a coin resource link; shared by the live and pre-launch identity headers. */
export function linkIconFor(label: string) {
  const normalized = label.toLowerCase();
  if (normalized.includes("website")) return Globe;
  if (normalized.includes("twitter") || normalized === "x") return X;
  if (normalized.includes("doc")) return FileText;
  return ExternalLink;
}
