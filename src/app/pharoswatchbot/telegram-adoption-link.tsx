"use client";

import { forwardRef, type AnchorHTMLAttributes } from "react";
import {
  TELEGRAM_ADOPTION_CTA_ENDPOINT,
  telegramAdoptionEntryForPlacement,
  type TelegramAdoptionCatalogPlacement,
} from "@shared/lib/telegram-adoption-analytics";

interface TelegramAdoptionLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  placement: TelegramAdoptionCatalogPlacement;
}

export const TelegramAdoptionLink = forwardRef<HTMLAnchorElement, TelegramAdoptionLinkProps>(
  function TelegramAdoptionLink({ placement, onClick, ...props }, ref) {
    const entry = telegramAdoptionEntryForPlacement(placement);
    return (
      <a
        {...props}
        ref={ref}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented) return;
          void fetch(TELEGRAM_ADOPTION_CTA_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ campaign: entry.campaign, placement: entry.placement }),
            keepalive: true,
          }).catch(() => undefined);
        }}
      />
    );
  },
);
