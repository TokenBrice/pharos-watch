import type { SeeAlsoLink } from "@/components/see-also-footer";

/**
 * Currently consumed only by the coverage page. Additional curated routes were
 * pruned because no page reads them.
 */
export const SEE_ALSO_GRAPH: Record<string, ReadonlyArray<SeeAlsoLink>> = {
  "/coverage/": [
    {
      href: "/methodology/",
      label: "Methodology",
      description: "How each tracked feature is computed.",
    },
    {
      href: "/api/",
      label: "API access",
      description: "Pull coverage programmatically.",
    },
    {
      href: "/upcoming/",
      label: "Upcoming launches",
      description: "Pre-launch assets excluded from coverage.",
    },
    {
      href: "/cemetery/",
      label: "Cemetery",
      description: "Archived assets excluded from live coverage.",
    },
  ],
};
