import Link from "next/link";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Compact "Alerts" action for the instrument header's meta row, sized to sit
 * beside `ShareButton`. The full pitch lives in the accessible name instead
 * of a banner above the fold.
 */
export function AlertsHeaderLink({ href, description }: { href: string; description: string }) {
  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className="min-h-11 rounded-full px-4 lg:min-h-9 lg:rounded-md"
    >
      <Link href={href} aria-label={`Alerts: ${description}`}>
        <Bell aria-hidden="true" />
        <span>Alerts</span>
      </Link>
    </Button>
  );
}
