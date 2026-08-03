// 데모 고정 환율. 화면에는 항상 '데모 환율' 라벨과 함께 노출한다.
export const KRW_PER_USDC = 1450;
export const FEE_RATE = 0.005; // 거래 수수료 0.5%

// 내부 금액 단위는 정수 micro-USDC (1 USDC = 1_000_000)
export const MICRO = 1_000_000;

export function krwToMicro(krw: number): number {
  return Math.round((krw / KRW_PER_USDC) * MICRO);
}

export function microToKrw(micro: number): number {
  return Math.round((micro / MICRO) * KRW_PER_USDC);
}

export function microToUsdc(micro: number): string {
  return (micro / MICRO).toFixed(6);
}

export function fmtUsdc(micro: number): string {
  return (micro / MICRO).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtKrw(krw: number): string {
  return krw.toLocaleString("ko-KR");
}

export function feeMicro(gross: number): number {
  return Math.round(gross * FEE_RATE);
}
