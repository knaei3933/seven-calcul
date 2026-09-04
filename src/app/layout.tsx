import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "パウチ参考原価・販売価格シミュレーター",
  description: "パウチの参考原価・参考販売価格をDecimal計算で検証します",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // 번역 확장 프로그램(Trancy 등)이 <html>에 속성을 주입해도 하이드레이션 경고가 발생하지 않도록 억제
  return <html lang="ja" suppressHydrationWarning><body suppressHydrationWarning>{children}</body></html>;
}
