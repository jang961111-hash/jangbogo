import { microToUsdc } from "./fx";

// x402 스펙 준거 402 응답/헤더 구성 (scheme: exact, network: solana-devnet)

export interface PaymentRequirements {
  scheme: "exact";
  network: "solana-devnet" | "sandbox";
  asset: string; // mock USDC mint
  amount: string; // USDC 소수 문자열
  amountMicro: number;
  payTo: string; // devnet: 머천트 ATA / sandbox: owner
  nonce: string;
  memo: string;
  expiresInSec: number;
}

export interface X402Body {
  x402Version: 1;
  error: "payment_required";
  accepts: PaymentRequirements[];
}

export function buildRequirements(params: {
  network: "solana-devnet" | "sandbox";
  mintB58: string;
  payToB58: string;
  amountMicro: number;
  nonce: string;
}): X402Body {
  return {
    x402Version: 1,
    error: "payment_required",
    accepts: [
      {
        scheme: "exact",
        network: params.network,
        asset: params.mintB58,
        amount: microToUsdc(params.amountMicro),
        amountMicro: params.amountMicro,
        payTo: params.payToB58,
        nonce: params.nonce,
        memo: params.nonce,
        expiresInSec: 300,
      },
    ],
  };
}

export interface PaymentHeader {
  signature: string;
  payer: string;
  nonce: string;
}

export function encodePaymentHeader(p: PaymentHeader): string {
  return Buffer.from(JSON.stringify(p), "utf-8").toString("base64");
}

export function parsePaymentHeader(header: string | null): PaymentHeader | null {
  if (!header) return null;
  try {
    const obj = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
    if (typeof obj.signature === "string") return obj as PaymentHeader;
    return null;
  } catch {
    return null;
  }
}
