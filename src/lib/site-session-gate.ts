// Keep the eager API bridge free of runtime imports.
export const SITE_SESSION_CHECK_ENABLED = process.env.NEXT_PUBLIC_PHAROS_SITE_SESSION_CHECK === "true";

type SiteSessionGate = Pick<typeof import("./site-session-client"),
  "hasValidSiteSession" | "invalidateSiteSession" | "waitForSiteSession">;
let gate: SiteSessionGate | null = null;

export function setSiteSessionGate(session: SiteSessionGate): void {
  gate = session;
}

export function getSiteSessionGate(): SiteSessionGate | null {
  return gate;
}
