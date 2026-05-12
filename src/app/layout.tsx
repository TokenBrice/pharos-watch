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
import { RouteChrome } from "@/components/route-chrome";
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
        <Script id="api-key-verify-url-sanitizer" strategy="beforeInteractive">
          {`(function(){
            try {
              var url = new URL(window.location.href);
              var token = url.searchParams.get('verify');
              function tokenFromHash(hash) {
                var raw = hash && hash.charAt(0) === '#' ? hash.slice(1) : hash;
                if (!raw) return null;
                if (raw.indexOf('verify=') === 0 || raw.indexOf('token=') === 0) {
                  var params = new URLSearchParams(raw);
                  return params.get('verify') || params.get('token');
                }
                var queryStart = raw.indexOf('?');
                return queryStart >= 0 ? new URLSearchParams(raw.slice(queryStart + 1)).get('verify') : null;
              }
              function scrubHash(hash) {
                var raw = hash && hash.charAt(0) === '#' ? hash.slice(1) : hash;
                if (!raw) return '';
                if (raw.indexOf('verify=') === 0 || raw.indexOf('token=') === 0) {
                  var params = new URLSearchParams(raw);
                  params.delete('verify');
                  params.delete('token');
                  var next = params.toString();
                  return next ? '#' + next : '';
                }
                var queryStart = raw.indexOf('?');
                if (queryStart < 0) return hash || '';
                var path = raw.slice(0, queryStart);
                var params = new URLSearchParams(raw.slice(queryStart + 1));
                params.delete('verify');
                var next = params.toString();
                return '#' + path + (next ? '?' + next : '');
              }
              token = token || tokenFromHash(url.hash);
              var nextHash = scrubHash(url.hash);
              var changed = url.searchParams.has('verify') || nextHash !== url.hash;
              if (token) window.__PHAROS_API_KEY_VERIFY_TOKEN__ = String(token).trim();
              if (url.searchParams.has('verify')) url.searchParams.delete('verify');
              var search = url.searchParams.toString();
              var sanitizedPath = url.pathname + (search ? '?' + search : '');
              window.__PHAROS_SANITIZED_PATH__ = sanitizedPath;
              if (changed) window.history.replaceState(null, '', sanitizedPath + nextHash);
            } catch (_) {
              window.__PHAROS_SANITIZED_PATH__ = window.location.pathname + window.location.search;
            }
          })();`}
        </Script>
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {gaId && (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />
            <Script id="gtag-init" strategy="afterInteractive">
              {`window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                var pharosPagePath = window.__PHAROS_SANITIZED_PATH__ || (window.location.pathname + window.location.search);
                gtag('config', ${JSON.stringify(gaId)}, { send_page_view: false });
                gtag('event', 'page_view', {
                  page_path: pharosPagePath,
                  page_location: window.location.origin + pharosPagePath,
                  page_title: document.title
                });`}
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
          <RouteChrome>
            <RegimeBar />
            <div className="h-[3px] shrink-0" />
            <Header />
          </RouteChrome>
          <SidebarProvider>
            <div className="flex min-h-screen">
              <RouteChrome>
                <Sidebar />
                <SidebarSpacer />
              </RouteChrome>
              <div className="flex-1 flex flex-col min-w-0">
                <main
                  id="main-content"
                  className="pharos-mobile-utility-safe flex-1 container mx-auto px-4 py-6 md:py-7 lg:px-6"
                >
                  {children}
                </main>
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
