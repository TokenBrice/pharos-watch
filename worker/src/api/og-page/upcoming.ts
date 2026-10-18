import { type OgPageLoader, unavailable } from "./types";

/**
 * `/upcoming` card: timeless by decision. The page's figures are registry
 * counts that change per deploy, so the route always serves the figure-free
 * card (docs/og-images.md).
 */
export const loadUpcomingOgPage: OgPageLoader = async () => unavailable("timeless-by-decision");
