import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = localFont({
  variable: "--font-geist-sans",
  src: [
    { path: "../public/fonts/Geist-Thin.ttf", weight: "100", style: "normal" },
    { path: "../public/fonts/Geist-ThinItalic.ttf", weight: "100", style: "italic" },
    { path: "../public/fonts/Geist-ExtraLight.ttf", weight: "200", style: "normal" },
    { path: "../public/fonts/Geist-ExtraLightItalic.ttf", weight: "200", style: "italic" },
    { path: "../public/fonts/Geist-Light.ttf", weight: "300", style: "normal" },
    { path: "../public/fonts/Geist-LightItalic.ttf", weight: "300", style: "italic" },
    { path: "../public/fonts/Geist-Regular.ttf", weight: "400", style: "normal" },
    { path: "../public/fonts/Geist-Italic.ttf", weight: "400", style: "italic" },
    { path: "../public/fonts/Geist-Medium.ttf", weight: "500", style: "normal" },
    { path: "../public/fonts/Geist-MediumItalic.ttf", weight: "500", style: "italic" },
    { path: "../public/fonts/Geist-SemiBold.ttf", weight: "600", style: "normal" },
    { path: "../public/fonts/Geist-SemiBoldItalic.ttf", weight: "600", style: "italic" },
    { path: "../public/fonts/Geist-Bold.ttf", weight: "700", style: "normal" },
    { path: "../public/fonts/Geist-BoldItalic.ttf", weight: "700", style: "italic" },
    { path: "../public/fonts/Geist-ExtraBold.ttf", weight: "800", style: "normal" },
    { path: "../public/fonts/Geist-ExtraBoldItalic.ttf", weight: "800", style: "italic" },
    { path: "../public/fonts/Geist-Black.ttf", weight: "900", style: "normal" },
    { path: "../public/fonts/Geist-BlackItalic.ttf", weight: "900", style: "italic" },
  ],
});
const geistMono = localFont({
  variable: "--font-geist-mono",
  src: [
    { path: "../public/fonts/GeistMono-Thin.ttf", weight: "100", style: "normal" },
    { path: "../public/fonts/GeistMono-ThinItalic.ttf", weight: "100", style: "italic" },
    { path: "../public/fonts/GeistMono-ExtraLight.ttf", weight: "200", style: "normal" },
    { path: "../public/fonts/GeistMono-ExtraLightItalic.ttf", weight: "200", style: "italic" },
    { path: "../public/fonts/GeistMono-Light.ttf", weight: "300", style: "normal" },
    { path: "../public/fonts/GeistMono-LightItalic.ttf", weight: "300", style: "italic" },
    { path: "../public/fonts/GeistMono-Regular.ttf", weight: "400", style: "normal" },
    { path: "../public/fonts/GeistMono-Italic.ttf", weight: "400", style: "italic" },
    { path: "../public/fonts/GeistMono-Medium.ttf", weight: "500", style: "normal" },
    { path: "../public/fonts/GeistMono-MediumItalic.ttf", weight: "500", style: "italic" },
    { path: "../public/fonts/GeistMono-SemiBold.ttf", weight: "600", style: "normal" },
    { path: "../public/fonts/GeistMono-SemiBoldItalic.ttf", weight: "600", style: "italic" },
    { path: "../public/fonts/GeistMono-Bold.ttf", weight: "700", style: "normal" },
    { path: "../public/fonts/GeistMono-BoldItalic.ttf", weight: "700", style: "italic" },
    { path: "../public/fonts/GeistMono-ExtraBold.ttf", weight: "800", style: "normal" },
    { path: "../public/fonts/GeistMono-ExtraBoldItalic.ttf", weight: "800", style: "italic" },
    { path: "../public/fonts/GeistMono-Black.ttf", weight: "900", style: "normal" },
    { path: "../public/fonts/GeistMono-BlackItalic.ttf", weight: "900", style: "italic" },
  ],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const ogImage = `${protocol}://${host}/og.png`;

  return {
    title: "Hack Club Ranked",
    description: "the best coopertive competitive coding game for teens",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Hack Club Ranked",
      description: "make a better website than kevin.",
      type: "website",
      images: [{ url: ogImage, width: 1792, height: 928, alt: "Hack Club Ranked — Build fast. Ship open." }],
    },
    twitter: { card: "summary_large_image", title: "Ranked — build stuff against your friends", description: "Build fast. Ship open.", images: [ogImage] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
