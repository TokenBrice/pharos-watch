import homepageBootstrapPayload from "@/generated/homepage-bootstrap.json";
import {
  HOMEPAGE_BOOTSTRAP_SCRIPT_ID,
  normalizeHomepageBootstrapPayload,
} from "@/lib/homepage-bootstrap";
import { safeJsonLd } from "@/lib/json-ld";

export function HomepageBootstrapScript() {
  const payload = normalizeHomepageBootstrapPayload(homepageBootstrapPayload);
  if (!payload || Object.keys(payload.queries).length === 0) {
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
