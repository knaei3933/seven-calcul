import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "パウチ見積システム",
  description: "パウチ原価・見積りをDecimal計算で検証します",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ja"><body>{children}</body></html>;
}
