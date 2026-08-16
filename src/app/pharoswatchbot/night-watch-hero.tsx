import Link from "next/link";
import { ArrowRight, Bot, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TRACKED_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import { TelegramAdoptionLink } from "./telegram-adoption-link";
import { NightShiftMetric } from "./night-shift-metric";
import { SETUP_DEEP_LINK } from "@/lib/telegram-route-constants";

/**
 * Act I — the lighthouse scene. A single frost beam sweeps dark water at
 * night (dark theme) or a pale day sky (light theme); every tone comes from
 * the page-scoped scene variables so the same drawing works in both. One
 * scene, one beam — the restraint rule. The scene is decorative; the copy
 * carries the information.
 */
function NightScene() {
  return (
    <div className="pharos-night-scene" aria-hidden="true">
      <svg viewBox="0 0 1440 720" preserveAspectRatio="xMaxYMax slice" role="presentation">
        <defs>
          <linearGradient id="nw-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--night-sky-top)" />
            <stop offset="100%" stopColor="var(--night-sky-bottom)" />
          </linearGradient>
          <linearGradient id="nw-beam" gradientUnits="userSpaceOnUse" x1="1182" y1="216" x2="60" y2="265">
            <stop offset="0%" stopColor="var(--frost-blue)" stopOpacity="var(--beam-strong)" />
            <stop offset="30%" stopColor="var(--frost-blue)" stopOpacity="var(--beam-mid)" />
            <stop offset="70%" stopColor="var(--frost-blue)" stopOpacity="var(--beam-far)" />
            <stop offset="100%" stopColor="var(--frost-blue)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="nw-beam-core" gradientUnits="userSpaceOnUse" x1="1182" y1="216" x2="60" y2="258">
            <stop offset="0%" stopColor="var(--frost-blue)" stopOpacity="var(--beam-core-strong)" />
            <stop offset="55%" stopColor="var(--frost-blue)" stopOpacity="var(--beam-core-mid)" />
            <stop offset="100%" stopColor="var(--frost-blue)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width="1440" height="720" fill="url(#nw-sky)" />

        {/* Stars — night sky only, staggered twinkle via CSS */}
        <g className="pharos-night-stars" fill="#ffffff">
          <circle className="pharos-night-star" cx="120" cy="90" r="1.4" opacity="0.5" />
          <circle className="pharos-night-star" cx="260" cy="60" r="1" opacity="0.4" />
          <circle className="pharos-night-star" cx="390" cy="140" r="1.8" opacity="0.55" />
          <circle className="pharos-night-star" cx="520" cy="80" r="1.2" opacity="0.4" />
          <circle className="pharos-night-star" cx="660" cy="52" r="1.5" opacity="0.5" />
          <circle className="pharos-night-star" cx="760" cy="120" r="1" opacity="0.35" />
          <circle className="pharos-night-star" cx="880" cy="70" r="1.6" opacity="0.5" />
          <circle className="pharos-night-star" cx="980" cy="150" r="1.1" opacity="0.4" />
          <circle className="pharos-night-star" cx="1080" cy="64" r="1.3" opacity="0.45" />
          <circle className="pharos-night-star" cx="240" cy="196" r="1" opacity="0.35" />
          <circle className="pharos-night-star" cx="600" cy="176" r="1.2" opacity="0.4" />
          <circle className="pharos-night-star" cx="60" cy="150" r="1.2" opacity="0.4" />
        </g>

        {/* Water */}
        <g className="pharos-night-water">
          <rect x="0" y="470" width="1440" height="250" fill="var(--night-water)" />
          <g stroke="var(--night-line)" strokeWidth="1">
            <line x1="0" y1="470" x2="1440" y2="470" strokeOpacity="0.14" />
            <line x1="180" y1="520" x2="700" y2="520" strokeOpacity="0.08" />
            <line x1="60" y1="575" x2="520" y2="575" strokeOpacity="0.06" />
            <line x1="820" y1="540" x2="1300" y2="540" strokeOpacity="0.08" />
            <line x1="360" y1="640" x2="900" y2="640" strokeOpacity="0.06" />
          </g>
        </g>

        {/* The beam — a bright shaft plus its tight core, sweeping ±8° around
            the lamp every 16s. */}
        <g className="pharos-night-beam-anchor">
          <g className="pharos-night-beam">
            <polygon points="1182,216 40,150 40,380" fill="url(#nw-beam)" />
            <polygon points="1182,216 40,190 40,325" fill="url(#nw-beam-core)" />
          </g>
        </g>

        {/* The lighthouse — drawn silhouette: rock ridge, plinth, tapered
            tower with window slits, railed gallery, glazed lamp room, dome
            and finial. The lamp is the only lit element. */}
        <g className="pharos-night-lighthouse">
          <g fill="var(--lighthouse-ink)">
            <polygon points="1106,470 1144,434 1188,448 1228,436 1258,470" />
            <rect x="1146" y="456" width="72" height="14" />
            <path d="M1154 456 L1163 246 L1201 246 L1210 456 Z" />
            <rect x="1146" y="234" width="72" height="10" />
            <rect x="1152" y="222" width="3" height="12" />
            <rect x="1164" y="222" width="3" height="12" />
            <rect x="1176" y="222" width="3" height="12" />
            <rect x="1188" y="222" width="3" height="12" />
            <rect x="1200" y="222" width="3" height="12" />
            <rect x="1209" y="222" width="3" height="12" />
            <rect x="1162" y="202" width="40" height="32" />
            <polygon points="1158,202 1206,202 1182,182" />
            <rect x="1180.5" y="174" width="3" height="8" />
            <circle cx="1182" cy="172" r="2.5" />
          </g>
          {/* Glazing + window slits carved in the sky tone so they read in both
              themes */}
          <g fill="var(--night-sky-bottom)">
            <rect x="1167" y="207" width="30" height="22" />
            <rect x="1176" y="300" width="4" height="14" />
            <rect x="1184" y="300" width="4" height="14" />
            <rect x="1178" y="360" width="4" height="14" />
            <rect x="1186" y="360" width="4" height="14" />
          </g>
          {/* Lamp room mullions over the glazing */}
          <g fill="var(--lighthouse-ink)">
            <rect x="1176" y="207" width="2.5" height="22" />
            <rect x="1185.5" y="207" width="2.5" height="22" />
          </g>
          <circle cx="1182" cy="219" r="60" fill="var(--frost-blue)" opacity="var(--lamp-halo)" />
          <circle cx="1182" cy="219" r="17" fill="var(--frost-blue)" opacity="var(--lamp-mid)" />
          <circle cx="1182" cy="219" r="6.5" fill="var(--frost-blue)" />
          <circle cx="1182" cy="219" r="2.5" fill="var(--lamp-core)" />
        </g>
      </svg>
    </div>
  );
}

export function NightWatchHero() {
  return (
    <section id="watch" aria-labelledby="night-hero-title" className="pharos-night-abyss relative overflow-hidden">
      <NightScene />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 62% 68% at 32% 52%, color-mix(in oklab, var(--night-abyss) 88%, transparent) 25%, transparent 72%)",
        }}
      />
      <div className="relative mx-auto flex max-w-6xl flex-col px-4 py-16 sm:py-20 lg:px-5 xl:px-9">
        <p className="text-sm text-muted-foreground">
          Free Telegram alerts for {TRACKED_STABLECOIN_COUNT.toLocaleString("en-US")} tracked stablecoins
        </p>
        <h1
          id="night-hero-title"
          className="pharoswatchbot-hero-title mt-4 max-w-2xl text-balance font-display font-extrabold text-foreground"
        >
          Stablecoin alerts, before you have to check.
        </h1>
        <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Six alert families watch every tracked peg through the night — from depeg events to issuer freezes — and land
          in your Telegram chat only when something changes. Start with one preset; tune later.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg" className="gap-2">
            <TelegramAdoptionLink href={SETUP_DEEP_LINK} placement="hero" target="_blank" rel="noopener noreferrer">
              <Bot className="h-4 w-4" aria-hidden="true" />
              Open the bot
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </TelegramAdoptionLink>
          </Button>
          <Button asChild variant="outline" size="lg" className="gap-2 bg-transparent">
            <Link href="#signals">
              See example alerts
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <NightShiftMetric />
      </div>
    </section>
  );
}
