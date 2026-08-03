import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  makeIntentMandate,
  makeCartMandate,
  verifyMandatePair,
  intentHash,
} from "../src/lib/mandate";
import { validatePolicy } from "../src/lib/policy";
import { buildRequirements, encodePaymentHeader, parsePaymentHeader } from "../src/lib/x402";
import { krwToMicro, microToUsdc, MICRO } from "../src/lib/fx";
import type { Merchant } from "../src/lib/store";

function key() {
  const kp = Keypair.generate();
  return { pubB58: kp.publicKey.toBase58(), secretB58: bs58.encode(kp.secretKey) };
}

const principal = key();
const agent = key();
const DAY = 86400_000;

const merchant: Merchant = {
  id: "mch_test",
  name: "테스트상회",
  category: "식자재",
  walletPubB58: key().pubB58,
  walletSecretB58: key().secretB58,
  items: [
    { id: "itm_a", name: "블렌드 원두 1kg", priceKrw: 19000, priceMicro: krwToMicro(19000), stock: 10, unit: "kg", category: "식자재" },
    { id: "itm_b", name: "종이컵", priceKrw: 38000, priceMicro: krwToMicro(38000), stock: 5, unit: "box", category: "포장재" },
  ],
  createdAt: 0,
};

function freshMandates(over?: {
  budgetMicro?: number; expiresAt?: number; scope?: string[];
  itemId?: string; qty?: number;
}) {
  const intent = makeIntentMandate({
    principal,
    agentPubB58: agent.pubB58,
    scopeCategories: over?.scope ?? ["식자재"],
    budgetMicro: over?.budgetMicro ?? 100 * MICRO,
    expiresAt: over?.expiresAt ?? Date.now() + 7 * DAY,
  });
  const itemId = over?.itemId ?? "itm_a";
  const item = merchant.items.find((i) => i.id === itemId)!;
  const cart = makeCartMandate({
    agentSecretB58: agent.secretB58,
    intent,
    merchantId: merchant.id,
    items: [{ itemId, qty: over?.qty ?? 2, unitMicro: item.priceMicro }],
  });
  return { intent, cart };
}

describe("mandate (U1-U3)", () => {
  it("U1: 정상 서명 생성 → 검증 통과", () => {
    const { intent, cart } = freshMandates();
    expect(verifyMandatePair(intent, cart)).toEqual({ ok: true });
  });

  it("U2: intent 서명 위조 → 거절", () => {
    const { intent, cart } = freshMandates();
    const forged = { ...intent, budgetMicro: 999999 * MICRO };
    const r = verifyMandatePair(forged, cart);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MANDATE_INTENT_SIG_INVALID");
  });

  it("U3: cart의 intentHash 불일치 → 거절", () => {
    const a = freshMandates();
    const b = freshMandates({ budgetMicro: 5 * MICRO });
    const r = verifyMandatePair(b.intent, a.cart);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["MANDATE_HASH_MISMATCH", "MANDATE_CART_SIG_INVALID"]).toContain(r.code);
  });
});

describe("policy (U4-U7)", () => {
  it("U4: 만료된 mandate → MANDATE_EXPIRED", () => {
    const { intent, cart } = freshMandates({ expiresAt: Date.now() - DAY });
    const r = validatePolicy({ intent, cart, merchant, spentMicro: 0 });
    expect(r.code).toBe("MANDATE_EXPIRED");
  });

  it("U5: 카테고리 범위 밖 → MANDATE_SCOPE_VIOLATION", () => {
    const { intent, cart } = freshMandates({ itemId: "itm_b" }); // 포장재 구매, 식자재 위임
    const r = validatePolicy({ intent, cart, merchant, spentMicro: 0 });
    expect(r.code).toBe("MANDATE_SCOPE_VIOLATION");
  });

  it("U6: 누적지출+주문 > 예산 → MANDATE_BUDGET_EXCEEDED", () => {
    const { intent, cart } = freshMandates({ budgetMicro: 30 * MICRO });
    const spent = 30 * MICRO - cart.totalMicro + 1; // 1 micro 초과 유도
    const r = validatePolicy({ intent, cart, merchant, spentMicro: spent });
    expect(r.code).toBe("MANDATE_BUDGET_EXCEEDED");
  });

  it("U7: 경계값 — 누적+주문 = 예산 → 통과", () => {
    const { intent, cart } = freshMandates({ budgetMicro: 30 * MICRO });
    const spent = 30 * MICRO - cart.totalMicro;
    const r = validatePolicy({ intent, cart, merchant, spentMicro: spent });
    expect(r.ok).toBe(true);
  });

  it("추가: 카트 단가 조작 → CART_PRICE_MISMATCH", () => {
    const intent = makeIntentMandate({
      principal, agentPubB58: agent.pubB58, scopeCategories: ["식자재"],
      budgetMicro: 100 * MICRO, expiresAt: Date.now() + DAY,
    });
    const cart = makeCartMandate({
      agentSecretB58: agent.secretB58, intent, merchantId: merchant.id,
      items: [{ itemId: "itm_a", qty: 1, unitMicro: 1 }], // 1 micro로 후려침
    });
    const r = validatePolicy({ intent, cart, merchant, spentMicro: 0 });
    expect(r.code).toBe("CART_PRICE_MISMATCH");
  });
});

describe("x402 (U8)", () => {
  it("U8: requirements 생성 + 헤더 라운드트립", () => {
    const body = buildRequirements({
      network: "solana-devnet", mintB58: "MintX", payToB58: "AtaY",
      amountMicro: 65_517_240, nonce: "ord_abc",
    });
    expect(body.accepts[0].amount).toBe("65.517240");
    expect(body.accepts[0].memo).toBe("ord_abc");
    const h = encodePaymentHeader({ signature: "sig123", payer: "payerX", nonce: "ord_abc" });
    expect(parsePaymentHeader(h)).toEqual({ signature: "sig123", payer: "payerX", nonce: "ord_abc" });
    expect(parsePaymentHeader(null)).toBeNull();
    expect(parsePaymentHeader("not-base64!!!")).toBeNull();
  });
});

describe("fx (U9)", () => {
  it("U9: KRW→micro-USDC 변환 정밀도", () => {
    expect(krwToMicro(1450)).toBe(MICRO);
    expect(krwToMicro(19000)).toBe(13103448);
    expect(microToUsdc(13103448)).toBe("13.103448");
  });

  it("intentHash는 서명 제외 본문에 결정적", () => {
    const { intent } = freshMandates();
    expect(intentHash(intent)).toBe(intentHash({ ...intent, sigB58: "다른서명" }));
  });
});
