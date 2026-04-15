import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Header } from "@/components/header";
import { Sidebar, SidebarProvider, SidebarSpacer } from "@/components/sidebar";
import { Footer } from "@/components/footer";
import { ScrollToTop } from "@/components/scroll-to-top";
import { FeedbackButton } from "@/components/feedback-button";
import { MobileUtilityDock } from "@/components/mobile-utility-dock";
import { RegimeBar } from "@/components/regime-bar";
import { safeJsonLd } from "@/lib/json-ld";
import { API_ORIGIN as API_URL, SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { geistMono, geistSans } from "@/lib/fonts";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { PEG_CURRENCY_COUNT } from "@shared/lib/classification";

const siteDescription = `Track ${ACTIVE_STABLECOINS.length} stablecoins across ${PEG_CURRENCY_COUNT} peg currencies (USD, EUR, GBP, gold, silver & more). Market caps, peg deviation heatmaps, blacklist monitoring, DEX liquidity scores, and a cemetery of ${DEAD_STABLECOINS.length} dead stablecoins, with core market data updated every 15 minutes.`;

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
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
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
  alternates: {
    canonical: `${SITE_URL}/`,
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
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {gaId && (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />
            <Script id="gtag-init" strategy="afterInteractive">
              {`window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', ${JSON.stringify(gaId)});`}
            </Script>
          </>
        )}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
        >
          Skip to main content
        </a>
        <Providers>
          <RegimeBar />
          <div className="h-[3px] shrink-0" />
          <Header />
          <SidebarProvider>
            <div className="flex min-h-screen">
              <Sidebar />
              <SidebarSpacer />
              <div className="flex-1 flex flex-col min-w-0">
                <main
                  id="main-content"
                  className="pharos-mobile-utility-safe flex-1 container mx-auto px-4 py-6 md:py-7 lg:px-6"
                >
                  {children}
                </main>
                <Footer />
              </div>
            </div>
          </SidebarProvider>
          <MobileUtilityDock />
          <ScrollToTop />
          <FeedbackButton />
        </Providers>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              {
                "@context": "https://schema.org",
                "@type": "WebSite",
                name: "Pharos",
                url: SITE_URL,
                description: siteDescription,
                potentialAction: {
                  "@type": "SearchAction",
                  target: `${SITE_URL}/?q={search_term_string}`,
                  "query-input": "required name=search_term_string",
                },
              },
              {
                "@context": "https://schema.org",
                "@type": "Organization",
                name: "Pharos",
                url: SITE_URL,
                logo: `${SITE_URL}/pharos-icon.png`,
                description: siteDescription,
                sameAs: ["https://x.com/PharosWatch", "https://github.com/TokenBrice/stablecoin-dashboard"],
                founder: {
                  "@type": "Person",
                  name: "TokenBrice",
                  url: "https://tokenbrice.xyz",
                },
              },
              {
                "@context": "https://schema.org",
                "@type": "WebApplication",
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
                creator: {
                  "@type": "Person",
                  name: "TokenBrice",
                  url: "https://tokenbrice.xyz",
                },
              },
            ]),
          }}
        />
      </body>
    </html>
  );
}
