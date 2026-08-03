import nacl from "tweetnacl";
import bs58 from "bs58";
import { createHash } from "crypto";

// AP2 스펙의 Intent/Cart Mandate 구조를 ed25519 서명 JSON으로 축약 구현 (ap2-lite/1)

export interface IntentMandate {
  ver: "ap2-lite/1";
  principalPubB58: string;
  agentPubB58: string;
  scopeCategories: string[];
  budgetMicro: number;
  issuedAt: number;
  expiresAt: number;
  humanNotPresent: true;
  sigB58: string;
}

export interface CartMandate {
  ver: "ap2-lite/1";
  intentHash: string;
  merchantId: string;
  items: { itemId: string; qty: number; unitMicro: number }[];
  totalMicro: number;
  issuedAt: number;
  sigB58: string;
}

/** 키 정렬 재귀 canonical JSON — 서명·해시 입력 안정화 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

function stripSig<T extends { sigB58: string }>(m: T): Omit<T, "sigB58"> {
  const { sigB58: _sig, ...rest } = m;
  return rest;
}

export function signPayload(payload: object, secretB58: string): string {
  const secret = bs58.decode(secretB58);
  const msg = new TextEncoder().encode(canonicalize(payload));
  return bs58.encode(nacl.sign.detached(msg, secret));
}

export function verifyPayload(payload: object, sigB58: string, pubB58: string): boolean {
  try {
    const msg = new TextEncoder().encode(canonicalize(payload));
    return nacl.sign.detached.verify(msg, bs58.decode(sigB58), bs58.decode(pubB58));
  } catch {
    return false;
  }
}

export function intentHash(intent: IntentMandate): string {
  return createHash("sha256").update(canonicalize(stripSig(intent))).digest("hex");
}

export function makeIntentMandate(params: {
  principal: { pubB58: string; secretB58: string };
  agentPubB58: string;
  scopeCategories: string[];
  budgetMicro: number;
  expiresAt: number;
  issuedAt?: number;
}): IntentMandate {
  const body = {
    ver: "ap2-lite/1" as const,
    principalPubB58: params.principal.pubB58,
    agentPubB58: params.agentPubB58,
    scopeCategories: params.scopeCategories,
    budgetMicro: params.budgetMicro,
    issuedAt: params.issuedAt ?? Date.now(),
    expiresAt: params.expiresAt,
    humanNotPresent: true as const,
  };
  return { ...body, sigB58: signPayload(body, params.principal.secretB58) };
}

export function makeCartMandate(params: {
  agentSecretB58: string;
  intent: IntentMandate;
  merchantId: string;
  items: { itemId: string; qty: number; unitMicro: number }[];
}): CartMandate {
  const totalMicro = params.items.reduce((s, i) => s + i.unitMicro * i.qty, 0);
  const body = {
    ver: "ap2-lite/1" as const,
    intentHash: intentHash(params.intent),
    merchantId: params.merchantId,
    items: params.items,
    totalMicro,
    issuedAt: Date.now(),
  };
  return { ...body, sigB58: signPayload(body, params.agentSecretB58) };
}

export type MandateFail =
  | "MANDATE_INTENT_SIG_INVALID"
  | "MANDATE_CART_SIG_INVALID"
  | "MANDATE_HASH_MISMATCH";

/** 서명·해시 무결성 검증 (정책 검증은 policy.ts) */
export function verifyMandatePair(
  intent: IntentMandate,
  cart: CartMandate
): { ok: true } | { ok: false; code: MandateFail } {
  if (!verifyPayload(stripSig(intent), intent.sigB58, intent.principalPubB58))
    return { ok: false, code: "MANDATE_INTENT_SIG_INVALID" };
  if (!verifyPayload(stripSig(cart), cart.sigB58, intent.agentPubB58))
    return { ok: false, code: "MANDATE_CART_SIG_INVALID" };
  if (cart.intentHash !== intentHash(intent))
    return { ok: false, code: "MANDATE_HASH_MISMATCH" };
  return { ok: true };
}
