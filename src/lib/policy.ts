import type { IntentMandate, CartMandate } from "./mandate";
import { verifyMandatePair } from "./mandate";
import type { Merchant } from "./store";

// 판매자측 결정론 정책 엔진 — LLM 판단이 개입하지 않는 신뢰 경계.
// 검증 순서: 서명 → 만료 → 카테고리 범위 → 카트 정합성(가격·재고) → 누적 예산

export type PolicyFail =
  | "MANDATE_INTENT_SIG_INVALID"
  | "MANDATE_CART_SIG_INVALID"
  | "MANDATE_HASH_MISMATCH"
  | "MANDATE_EXPIRED"
  | "MANDATE_SCOPE_VIOLATION"
  | "CART_ITEM_UNKNOWN"
  | "CART_PRICE_MISMATCH"
  | "CART_STOCK_INSUFFICIENT"
  | "CART_TOTAL_MISMATCH"
  | "MANDATE_BUDGET_EXCEEDED";

export interface PolicyResult {
  ok: boolean;
  code?: PolicyFail;
  detail?: string;
}

export function validatePolicy(params: {
  intent: IntentMandate;
  cart: CartMandate;
  merchant: Merchant;
  spentMicro: number; // 이 intent로 이미 집행된 누적 금액
  nowMs?: number;
}): PolicyResult {
  const { intent, cart, merchant, spentMicro } = params;
  const now = params.nowMs ?? Date.now();

  const sig = verifyMandatePair(intent, cart);
  if (!sig.ok) return { ok: false, code: sig.code };

  if (now > intent.expiresAt)
    return {
      ok: false,
      code: "MANDATE_EXPIRED",
      detail: `만료 ${new Date(intent.expiresAt).toISOString()}`,
    };

  let computedTotal = 0;
  for (const line of cart.items) {
    const item = merchant.items.find((i) => i.id === line.itemId);
    if (!item) return { ok: false, code: "CART_ITEM_UNKNOWN", detail: line.itemId };
    if (!intent.scopeCategories.includes(item.category))
      return {
        ok: false,
        code: "MANDATE_SCOPE_VIOLATION",
        detail: `'${item.category}' ∉ [${intent.scopeCategories.join(", ")}]`,
      };
    if (line.unitMicro !== item.priceMicro)
      return { ok: false, code: "CART_PRICE_MISMATCH", detail: item.name };
    if (line.qty <= 0 || line.qty > item.stock)
      return { ok: false, code: "CART_STOCK_INSUFFICIENT", detail: item.name };
    computedTotal += line.unitMicro * line.qty;
  }
  if (computedTotal !== cart.totalMicro)
    return { ok: false, code: "CART_TOTAL_MISMATCH" };

  if (spentMicro + cart.totalMicro > intent.budgetMicro)
    return {
      ok: false,
      code: "MANDATE_BUDGET_EXCEEDED",
      detail: `누적 ${(spentMicro / 1e6).toFixed(2)} + 주문 ${(cart.totalMicro / 1e6).toFixed(2)} > 예산 ${(intent.budgetMicro / 1e6).toFixed(2)} USDC`,
    };

  return { ok: true };
}

export const POLICY_MESSAGES: Record<PolicyFail, string> = {
  MANDATE_INTENT_SIG_INVALID: "위임장(Intent Mandate) 서명이 유효하지 않습니다",
  MANDATE_CART_SIG_INVALID: "장바구니(Cart Mandate) 서명이 유효하지 않습니다",
  MANDATE_HASH_MISMATCH: "장바구니가 참조하는 위임장 해시가 일치하지 않습니다",
  MANDATE_EXPIRED: "위임장이 만료되었습니다",
  MANDATE_SCOPE_VIOLATION: "위임 범위(카테고리) 밖의 구매입니다",
  CART_ITEM_UNKNOWN: "존재하지 않는 상품입니다",
  CART_PRICE_MISMATCH: "카트 단가가 판매가와 다릅니다",
  CART_STOCK_INSUFFICIENT: "재고가 부족합니다",
  CART_TOTAL_MISMATCH: "카트 합계가 맞지 않습니다",
  MANDATE_BUDGET_EXCEEDED: "위임 예산을 초과합니다",
};
