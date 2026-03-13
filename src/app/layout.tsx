import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Navigation } from "@/components/Navigation";
import { AuthProvider } from "@/components/AuthProvider";

export const metadata: Metadata = {
  title: "The Stacks",
  description: "AI-powered underground music discovery",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans min-h-screen">
        <AuthProvider>
          <Navigation />
          <main className="pb-20 md:pb-8">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
