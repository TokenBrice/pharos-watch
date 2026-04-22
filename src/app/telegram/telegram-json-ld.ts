const TELEGRAM_HOW_TO_STEPS = [
  {
    position: 1,
    name: "Open @PharosWatchBot",
    text: "Open @PharosWatchBot in Telegram and send /start.",
  },
  {
    position: 2,
    name: "Subscribe and tune",
    text: "Subscribe and tune with commands like /subscribe dews,depeg USDT,USDC, /presets, /set USDT dews WARNING, and /mute 22-07.",
  },
  {
    position: 3,
    name: "Review active subscriptions",
    text: "Alerts arrive automatically when conditions change. Use /list to check active subscriptions and /presets to discover preset watchlists from inside Telegram.",
  },
] as const;

const TELEGRAM_FEATURE_LIST = [
  "Depeg alerts (triggered, worsening milestones, resolved)",
  "DEWS threat-band alerts (ALERT, WARNING, DANGER)",
  "Safety grade alerts, including global downgrade filtering by score when available",
  "Pre-launch stablecoin launch alerts",
  "Per-coin thresholds and quiet hours",
  "Inline snooze (1h / 4h / 24h)",
] as const;

export function buildTelegramPageJsonLd(siteUrl: string) {
  const gettingStartedUrl = `${siteUrl}/telegram/#getting-started`;

  return [
    {
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: "Set up Pharos stablecoin alerts on Telegram",
      description:
        "Subscribe to depeg, DEWS threat-level, safety-grade, and launch alerts for tracked stablecoins from the Pharos Telegram bot.",
      totalTime: "PT2M",
      tool: [{ "@type": "HowToTool", name: "Telegram" }],
      step: TELEGRAM_HOW_TO_STEPS.map((step) => ({
        "@type": "HowToStep",
        ...step,
        url: gettingStartedUrl,
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "PharosWatchBot",
      applicationCategory: "FinanceApplication",
      operatingSystem: "Telegram",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      url: `${siteUrl}/telegram/`,
      installUrl: "https://t.me/PharosWatchBot",
      description: "Opt-in Telegram bot for stablecoin peg, DEWS, safety, and launch alerts.",
      featureList: TELEGRAM_FEATURE_LIST,
      publisher: { "@id": `${siteUrl}#organization` },
    },
  ];
}
