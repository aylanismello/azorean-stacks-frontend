import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Navigation } from "@/components/Navigation";
import { AuthProvider } from "@/components/AuthProvider";
import { SpotifyProvider } from "@/components/SpotifyProvider";
import { GlobalPlayerProvider } from "@/components/GlobalPlayerProvider";
import { GlobalPlayer } from "@/components/GlobalPlayer";
import { ThemeProvider } from "@/components/ThemeProvider";

export const metadata: Metadata = {
  title: "The Stacks",
  description: "AI-powered underground music discovery",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}})()`,
          }}
        />
      </head>
      <body className="font-sans min-h-screen">
        <ThemeProvider>
          <AuthProvider>
            <SpotifyProvider>
              <GlobalPlayerProvider>
                <Navigation />
                <main className="pb-0 md:pb-20">{children}</main>
                <GlobalPlayer />
              </GlobalPlayerProvider>
            </SpotifyProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
