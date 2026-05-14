import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Header } from "@/components/header";
import { Sidebar, SidebarProvider, SidebarSpacer } from "@/components/sidebar";
import { Footer } from "@/components/footer";
import { ScrollToTop } from "@/components/scroll-to-top";
import { FeedbackButton } from "@/components/feedback-button";
import { GoogleAnalytics } from "@/components/google-analytics";
import { MobileUtilityDock } from "@/components/mobile-utility-dock";
import { RegimeBar } from "@/components/regime-bar";
import { HomepageTopTape } from "@/components/homepage-top-tape";
import { MainContent, RouteChrome } from "@/components/route-chrome";
import { PHAROS_ORG_NODE, PHAROS_PERSON_TOKENBRICE_NODE, safeJsonLd } from "@/lib/json-ld";
import { API_ORIGIN as API_URL, SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { geistMono, geistSans } from "@/lib/fonts/geist";
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";
import { ACTIVE_STABLECOIN_COUNT, DEAD_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";

const siteDescription = `Track ${ACTIVE_STABLECOIN_COUNT} stablecoins across ${PEG_CURRENCY_COUNT} peg currencies (USD, EUR, GBP, gold, silver & more). Market caps, peg deviation heatmaps, blacklist monitoring, DEX liquidity scores, and a cemetery of ${DEAD_STABLECOIN_COUNT} dead stablecoins, with core market data updated every 15 minutes.`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0f" },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    template: "%s | Pharos",
    default: "Stablecoin Analytics Dashboard | Pharos",
  },
  description: siteDescription,
  openGraph: {
    type: "website",
    siteName: "Pharos",
    locale: "en_US",
    url: `${SITE_URL}/`,
    title: "Stablecoin Analytics Dashboard | Pharos",
    description: siteDescription,
    images: [{ url: `${SITE_URL}/og-card.png`, width: 1200, height: 628 }],
  },
  twitter: {
    card: "summary_large_image",
    site: "@PharosWatch",
    creator: "@TokenBrice",
    images: [{ url: `${SITE_URL}/og-card.png`, width: 1200, height: 628 }],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const gaId = process.env.NEXT_PUBLIC_GA_ID;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href={API_URL} />
        {gaId && <link rel="preload" href={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} as="script" />}
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {gaId && <GoogleAnalytics measurementId={gaId} />}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
        >
          Skip to main content
        </a>
        <Providers>
          <SidebarProvider>
            <RouteChrome>
              <RegimeBar />
              <div className="h-[3px] shrink-0" />
              <HomepageTopTape />
              <Header />
            </RouteChrome>
            <div className="flex min-h-screen">
              <RouteChrome>
                <Sidebar />
                <SidebarSpacer />
              </RouteChrome>
              <div className="flex-1 flex flex-col min-w-0">
                <MainContent>
                  {children}
                </MainContent>
                <RouteChrome>
                  <Footer />
                </RouteChrome>
              </div>
            </div>
          </SidebarProvider>
          <RouteChrome>
            <MobileUtilityDock />
            <ScrollToTop />
            <FeedbackButton />
          </RouteChrome>
        </Providers>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              {
                "@context": "https://schema.org",
                "@type": "WebSite",
                "@id": `${SITE_URL}#website`,
                name: "Pharos",
                url: SITE_URL,
                description: siteDescription,
                inLanguage: "en",
                relatedLink: ["https://pharosville.pharos.watch/"],
              },
              {
                "@context": "https://schema.org",
                ...PHAROS_ORG_NODE,
                description: siteDescription,
              },
              {
                "@context": "https://schema.org",
                ...PHAROS_PERSON_TOKENBRICE_NODE,
              },
              {
                "@context": "https://schema.org",
                "@type": "WebApplication",
                "@id": `${SITE_URL}#webapp`,
                name: "Pharos",
                url: SITE_URL,
                applicationCategory: "FinanceApplication",
                operatingSystem: "Web",
                description: siteDescription,
                offers: {
                  "@type": "Offer",
                  price: "0",
                  priceCurrency: "USD",
                },
                creator: { "@id": `${SITE_URL}#person-tokenbrice` },
              },
            ]),
          }}
        />
      </body>
    </html>
  );
}
