import {
  hostnameOfSiteDataCallerHeader,
  isSiteDataAllowedUiHostname,
} from "@shared/lib/site-data-lane";

export function rejectIfNotSiteDataUiOrigin(
  request: Request,
  env: { SITE_ORIGIN?: string; OPS_UI_ORIGIN?: string },
  notFound: () => Response,
): Response | null {
  const originHost = hostnameOfSiteDataCallerHeader(request.headers.get("Origin"));
  if (originHost !== null) {
    return isSiteDataAllowedUiHostname(originHost, env) ? null : notFound();
  }

  const refererHost = hostnameOfSiteDataCallerHeader(request.headers.get("Referer"));
  if (refererHost !== null) {
    return isSiteDataAllowedUiHostname(refererHost, env) ? null : notFound();
  }

  return notFound();
}
