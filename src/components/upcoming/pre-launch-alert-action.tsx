import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

const PHAROS_CHANNEL_URL = "https://t.me/pharoswatch";

/**
 * Header action pointing launch-curious readers at the @pharoswatch channel,
 * sized like `AlertsHeaderLink`. Per-user launch alerts are retired; the
 * channel digest lists stablecoins Pharos starts tracking.
 */
export function PreLaunchAlertAction({ description }: { description: string }) {
  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className="min-h-11 rounded-full px-4 lg:min-h-8 lg:rounded-md"
    >
      <a
        href={PHAROS_CHANNEL_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Follow @pharoswatch: ${description}`}
      >
        <ExternalLink aria-hidden="true" />
        <span>Follow @pharoswatch</span>
      </a>
    </Button>
  );
}
