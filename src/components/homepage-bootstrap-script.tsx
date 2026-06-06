import homepageBootstrapPayload from "@/generated/homepage-bootstrap.json";
import {
  HOMEPAGE_BOOTSTRAP_SCRIPT_ID,
  countSeedableHomepageBootstrapQueries,
  normalizeHomepageBootstrapPayload,
} from "@/lib/homepage-bootstrap-runtime";
import { safeJsonLd } from "@/lib/json-ld";

export function HomepageBootstrapScript() {
  const payload = normalizeHomepageBootstrapPayload(homepageBootstrapPayload);
  if (!payload || countSeedableHomepageBootstrapQueries(payload) === 0) {
    return null;
  }

  return (
    <script
      id={HOMEPAGE_BOOTSTRAP_SCRIPT_ID}
      type="application/json"
      dangerouslySetInnerHTML={{ __html: safeJsonLd(payload as unknown as Record<string, unknown>) }}
    />
  );
}
