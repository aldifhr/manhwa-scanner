import type { Metadata } from "next";
import "./globals.css";
import Navbar from "@/components/Navbar";
import QueryProvider from "@/components/QueryProvider";
import { ToastProvider } from "@/lib/useToast";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "ManhwaScan — Read Manhwa & Manga Free",
  description:
    "Read manhwa, manga, and webtoon for free. Daily updates, best quality.",
  manifest: "/manifest.json",
  other: {
    "theme-color": "#000000",
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="id"
      suppressHydrationWarning
      className={cn("font-sans dark", geist.variable)}
    >
      <head>
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-icon.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-dvh bg-black text-white overflow-x-hidden">
        <QueryProvider>
          <ToastProvider>
            <Navbar />
            <main className="min-h-dvh pb-safe">{children}</main>
          </ToastProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
