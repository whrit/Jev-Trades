import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Clarity from "@microsoft/clarity";

import { ConfirmProvider } from "@/components/terminal/confirm";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Jev Trades",
  description: "Let Jev Trades for you",
};

export const viewport: Viewport = {
  themeColor: "#0b0d11",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const projectId = "yjvti3kyq4";

  Clarity.init(projectId);

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark antialiased`}
    >
      <body>
        <TooltipProvider delayDuration={300}>
          <ConfirmProvider>{children}</ConfirmProvider>
        </TooltipProvider>
        <Toaster position="bottom-right" offset={36} />
      </body>
    </html>
  );
}
