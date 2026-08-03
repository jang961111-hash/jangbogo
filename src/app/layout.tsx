import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "장보고 — Agent Commerce Gateway",
  description:
    "가맹점을 5분 만에 AI 에이전트가 결제하는 헤드리스 상점으로. AP2 mandate 검증 + x402 + Solana USDC.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
