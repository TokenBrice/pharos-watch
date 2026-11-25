"use client";

import { usePathname } from "next/navigation";
import { getClientRouteSeeAlsoLinks } from "@/lib/see-also-graph-client";
import { SeeAlsoFooterView } from "./see-also-footer-view";

/**
 * Route-aware discovery footer mounted beside the global site footer for hubs
 * that do not render `<SeeAlsoFooter>` inline on the server.
 */
export function RouteSeeAlsoFooter() {
  const pathname = usePathname();
  if (!pathname) return null;
  const links = getClientRouteSeeAlsoLinks(pathname);
  if (links.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[120rem] px-4 pb-8 lg:px-5 xl:px-9">
      <SeeAlsoFooterView links={links} className="mt-0" />
    </div>
  );
}
