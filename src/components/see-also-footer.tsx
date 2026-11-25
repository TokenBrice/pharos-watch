import { getSeeAlsoLinks } from "@/lib/see-also-graph";
import { SeeAlsoFooterView, type SeeAlsoLink } from "./see-also-footer-view";

export type { SeeAlsoLink };

interface SeeAlsoFooterProps {
  links?: ReadonlyArray<SeeAlsoLink>;
  /** Optional route key resolved against `SEE_ALSO_GRAPH` when `links` is omitted. */
  route?: string;
  className?: string;
}

/**
 * Server-safe hatnote-style "See also" block rendered at the bottom of
 * long-form and hub pages. Caps at 4 links per the IA council's discoverability
 * rule; extra entries are silently dropped to keep the footer scannable.
 */
export function SeeAlsoFooter({ links, route, className }: SeeAlsoFooterProps) {
  const resolved = links ?? (route ? getSeeAlsoLinks(route) : []);
  return <SeeAlsoFooterView links={resolved} className={className} />;
}
