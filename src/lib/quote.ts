import type { Merchant } from "./store";
import { microToUsdc } from "./fx";

// 머천트 에이전트의 견적 응답 로직 (A2A 메시지 구조 차용)

export interface Quote {
  itemId: string;
  name: string;
  unitPriceUsdc: string;
  unitMicro: number;
  qtyAvailable: number;
  unit: string;
  category: string;
  note: string;
}

export function makeQuotes(
  merchant: Merchant,
  req: { text?: string; category?: string; maxUnitPriceUsdc?: number }
): Quote[] {
  let items = merchant.items.filter((i) => i.stock > 0);
  if (req.category) items = items.filter((i) => i.category === req.category);

  if (req.text) {
    const tokens = req.text.split(/\s+/).filter((t) => t.length >= 2);
    // 키워드가 하나도 안 맞으면 견적 없음 — '아무거나 전체 반환' 폴백은
    // 요청과 무관한 상품(예: 원두 조달에 베이글)을 최저가로 낙찰시키는 결함이 된다
    if (tokens.length > 0)
      items = items.filter((i) => tokens.some((t) => i.name.includes(t)));
  }
  if (req.maxUnitPriceUsdc !== undefined) {
    const maxMicro = Math.round(req.maxUnitPriceUsdc * 1_000_000);
    items = items.filter((i) => i.priceMicro <= maxMicro);
  }

  return items.map((i) => ({
    itemId: i.id,
    name: i.name,
    unitPriceUsdc: microToUsdc(i.priceMicro),
    unitMicro: i.priceMicro,
    qtyAvailable: i.stock,
    unit: i.unit,
    category: i.category,
    note: `재고 ${i.stock}${i.unit} · 당일 출고 · USDC 즉시 정산 시 우선 배정`,
  }));
}
