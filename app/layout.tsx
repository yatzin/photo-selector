import type { Metadata } from "next";
import { openSans, poppins, geistMono } from "./fonts";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { DragGhost } from "@/components/drag-ghost";
import "./globals.css";

export const metadata: Metadata = {
  title: "Photo Selector",
  description: "Sort mobile uploads: keep, delete, or move to the drop-off folder",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${openSans.variable} ${poppins.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
          <Toaster richColors />
          <DragGhost />
        </ThemeProvider>
      </body>
    </html>
  );
}
