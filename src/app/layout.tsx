import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";
import { Footer } from "@/components/footer";
import { ScrollToTop } from "@/components/scroll-to-top";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { DEAD_STABLECOINS } from "@/lib/dead-stablecoins";
import { PEG_CURRENCY_COUNT } from "@/lib/classification";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteDescription = `Track ${TRACKED_STABLECOINS.length} stablecoins across ${PEG_CURRENCY_COUNT} peg currencies (USD, EUR, GBP, gold, silver & more). Market caps, peg deviation heatmaps, blacklist monitoring, DEX liquidity scores, and a cemetery of ${DEAD_STABLECOINS.length} dead stablecoins — updated every 15 minutes.`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0f" },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL("https://pharos.watch"),
  title: {
    template: "%s | Pharos",
    default: "Shining a Light on Every Peg | Pharos",
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
    url: "https://pharos.watch/",
    title: "Shining a Light on Every Peg | Pharos",
    description: siteDescription,
    images: [{ url: "https://pharos.watch/og-card.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
  },
  alternates: {
    canonical: "https://pharos.watch/",
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
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://api.pharos.watch" />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Script src="https://www.googletagmanager.com/gtag/js?id=G-6TS0KG8H04" strategy="afterInteractive" />
        <Script id="gtag-init" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-6TS0KG8H04');`}
        </Script>
        <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring">
          Skip to main content
        </a>
        <Providers>
          <Header />
          <div className="flex min-h-screen">
            <Sidebar />
            {/* Spacer matches collapsed sidebar width on desktop */}
            <div className="hidden md:block w-14 shrink-0" />
            <div className="flex-1 flex flex-col min-w-0">
              <main id="main-content" className="flex-1 container mx-auto px-4 py-6 lg:px-6">{children}</main>
              <Footer />
            </div>
          </div>
          <ScrollToTop />
        </Providers>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify([
              {
                "@context": "https://schema.org",
                "@type": "WebSite",
                name: "Pharos",
                url: "https://pharos.watch",
                description: siteDescription,
                potentialAction: {
                  "@type": "SearchAction",
                  target: "https://pharos.watch/?q={search_term_string}",
                  "query-input": "required name=search_term_string",
                },
              },
              {
                "@context": "https://schema.org",
                "@type": "Organization",
                name: "Pharos",
                url: "https://pharos.watch",
                logo: "https://pharos.watch/pharos-icon.png",
                description: siteDescription,
                sameAs: [
                  "https://x.com/PharosWatch",
                  "https://github.com/TokenBrice/stablecoin-dashboard",
                ],
                founder: {
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
