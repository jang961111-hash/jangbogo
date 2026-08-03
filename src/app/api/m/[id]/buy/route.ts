import { NextRequest, NextResponse } from "next/server";
import { loadDB, mutateDB, newId } from "@/lib/store";
import { validatePolicy, POLICY_MESSAGES, type PolicyFail } from "@/lib/policy";
import { intentHash, signPayload, type IntentMandate, type CartMandate } from "@/lib/mandate";
import { buildRequirements, parsePaymentHeader } from "@/lib/x402";
import { ensurePayTo, verifyPayment, explorerUrl } from "@/lib/chain";
import { feeMicro, microToKrw } from "@/lib/fx";

export const dynamic = "force-dynamic";

const PENDING_TTL_MS = 300_000;

function reject(code: string, message: string, detail?: string, status = 403) {
  return NextResponse.json({ error: { code, message, detail } }, { status });
}

// x402 구매 플로우 — 1차: 402 Payment Required / 2차(X-PAYMENT): 온체인 검증 후 주문 확정
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const db = loadDB();
  const merchant = db.merchants.find((x) => x.id === id);
  if (!merchant) return reject("MERCHANT_NOT_FOUND", "가맹점 없음", undefined, 404);

  const body = await req.json().catch(() => null);
  const intent = body?.mandates?.intent as IntentMandate | undefined;
  const cartMandate = body?.mandates?.cart as CartMandate | undefined;
  if (!intent || !cartMandate)
    return reject("MANDATE_REQUIRED", "AP2 mandate(intent/cart)가 필요합니다", undefined, 400);
  if (cartMandate.merchantId !== merchant.id)
    return reject("MANDATE_MERCHANT_MISMATCH", "다른 가맹점용 카트입니다");

  // ── 결정론 정책 검증 (결제 이전 프리체크 — 실패 시 자금 이동 자체가 없음)
  const iHash = intentHash(intent);
  const spentMicro = db.mandateSpend[iHash] ?? 0;
  const policy = validatePolicy({ intent, cart: cartMandate, merchant, spentMicro });
  if (!policy.ok)
    return reject(policy.code!, POLICY_MESSAGES[policy.code as PolicyFail], policy.detail);

  const payment = parsePaymentHeader(req.headers.get("X-PAYMENT"));

  // ── 1차 호출: 402 + PaymentRequirements
  if (!payment) {
    const payToB58 = await ensurePayTo(merchant.walletPubB58);
    const nonce = newId("ord");
    mutateDB((d) => {
      d.pendingOrders = d.pendingOrders.filter((p) => Date.now() < p.expiresAt);
      d.pendingOrders.push({
        nonce,
        payToB58,
        merchantId: merchant.id,
        items: cartMandate.items.map((i) => ({ itemId: i.itemId, qty: i.qty })),
        totalMicro: cartMandate.totalMicro,
        intentHash: iHash,
        agentPubB58: intent.agentPubB58,
        createdAt: Date.now(),
        expiresAt: Date.now() + PENDING_TTL_MS,
      });
    });
    const requirements = buildRequirements({
      network: db.mode === "sandbox" ? "sandbox" : "solana-devnet",
      mintB58: db.mintB58!,
      payToB58,
      amountMicro: cartMandate.totalMicro,
      nonce,
    });
    return NextResponse.json(requirements, { status: 402 });
  }

  // ── 2차 호출: 온체인 지불 검증
  const pending = db.pendingOrders.find(
    (p) => p.nonce === payment.nonce && p.merchantId === merchant.id
  );
  if (!pending) return reject("PAYMENT_NONCE_UNKNOWN", "유효한 결제 요청(nonce)이 없습니다");
  if (Date.now() > pending.expiresAt)
    return reject("PAYMENT_EXPIRED", "결제 요청이 만료되었습니다");
  if (pending.intentHash !== iHash || pending.totalMicro !== cartMandate.totalMicro)
    return reject("PAYMENT_CART_CHANGED", "결제 요청 이후 카트가 변경되었습니다");
  if (db.usedSigs.includes(payment.signature))
    return reject("PAYMENT_REPLAYED", "이미 사용된 트랜잭션입니다(리플레이 차단)");

  const verify = await verifyPayment({
    sig: payment.signature,
    payToB58: pending.payToB58,
    amountMicro: pending.totalMicro,
    memo: pending.nonce,
  });
  if (!verify.ok) return reject("PAYMENT_AMOUNT_MISMATCH", "온체인 지불 검증 실패", verify.reason);

  // ── 커밋: 재고 차감 · 예산 집행 기록 · 주문/정산 원장
  const order = mutateDB((d) => {
    const m = d.merchants.find((x) => x.id === merchant.id)!;
    for (const line of cartMandate.items) {
      const item = m.items.find((i) => i.id === line.itemId)!;
      item.stock -= line.qty;
    }
    d.usedSigs.push(payment.signature);
    d.mandateSpend[iHash] = (d.mandateSpend[iHash] ?? 0) + cartMandate.totalMicro;
    d.pendingOrders = d.pendingOrders.filter((p) => p.nonce !== pending.nonce);

    const o = {
      id: newId("order"),
      merchantId: m.id,
      merchantName: m.name,
      items: cartMandate.items.map((line) => {
        const item = m.items.find((i) => i.id === line.itemId)!;
        return { itemId: line.itemId, name: item.name, qty: line.qty, unitMicro: line.unitMicro };
      }),
      totalMicro: cartMandate.totalMicro,
      txSig: payment.signature,
      explorerUrl: explorerUrl(payment.signature),
      agentPubB58: intent.agentPubB58,
      intentHash: iHash,
      createdAt: Date.now(),
    };
    d.orders.push(o);

    const fee = feeMicro(o.totalMicro);
    const net = o.totalMicro - fee;
    d.ledger.push({
      orderId: o.id,
      merchantId: m.id,
      merchantName: m.name,
      grossMicro: o.totalMicro,
      feeMicro: fee,
      netMicro: net,
      netKrw: microToKrw(net),
      settledAt: Date.now(),
    });
    return o;
  });

  // 머천트 서명 영수증 — 부인 불가능성
  const receiptBody = { orderId: order.id, totalMicro: order.totalMicro, txSig: order.txSig };
  const receiptSig = signPayload(receiptBody, merchant.walletSecretB58);
  return NextResponse.json({
    order,
    receipt: { ...receiptBody, merchantPubB58: merchant.walletPubB58, sigB58: receiptSig },
  });
}
