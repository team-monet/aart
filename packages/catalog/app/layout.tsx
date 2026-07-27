import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  return {
    metadataBase,
    title: {
      default: "AART Pack Library",
      template: "%s · AART Pack Library",
    },
    description:
      "Discover reusable, inspectable Blocks and Workflows for governed automation.",
    openGraph: {
      title: "AART Pack Library",
      description:
        "Reuse work that already works. Search inspectable Blocks and Workflows, then approve them on your terms.",
      type: "website",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "AART Pack Library — reuse work that already works." }],
    },
    twitter: {
      card: "summary_large_image",
      title: "AART Pack Library",
      description:
        "Discover reusable, inspectable Blocks and Workflows for governed automation.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
