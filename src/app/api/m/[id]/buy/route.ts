import { NextRequest, NextResponse } from "next/server";
import { loadDB, mutateDB, newId, type DB, type Merchant, type Order, type UnconfirmedPayment } from "@/lib/store";
import { validatePolicy, POLICY_MESSAGES, type PolicyFail } from "@/lib/policy";
import { intentHash, signPayload, type IntentMandate, type CartMandate } from "@/lib/mandate";
import { buildRequirements, parsePaymentHeader, type PaymentHeader } from "@/lib/x402";
import { ensurePayTo, verifyPayment, explorerUrl } from "@/lib/chain";
import { feeMicro, microToKrw } from "@/lib/fx";

export const dynamic = "force-dynamic";

const PENDING_TTL_MS = 300_000;
// 만료된 402도 1시간은 남겨 둔다 — 만료 직후 도착한 지불을 검증해 미확정으로 기록하려면 청구 정보가 필요하다
const PENDING_RETAIN_MS = 3_600_000;

// 결제 증빙 in-flight 잠금 — 같은 서명(또는 nonce)의 검증이 진행 중이면 뒤 요청은 409.
// Node는 단일 스레드라 "검사 → 등록" 사이에 await가 없으면 한 프로세스 안에서 원자적이다.
// 다중 인스턴스에서는 공유 DB의 유니크 제약·트랜잭션이 필요하다 (README 정직 고지 참조).
const inflight = new Set<string>();

function reject(code: string, message: string, detail?: string, status = 403) {
  return NextResponse.json({ error: { code, message, detail } }, { status });
}

// 예산 예약 — 발급했지만 아직 확정되지 않은(만료 전) 402 금액의 합. 402 발급 시점에 예산에서
// 미리 잡아 두고(reserve), 확정되면 mandateSpend로 옮기고(commit), 만료되면 풀린다(release).
function reservedMicro(d: DB, iHash: string, excludeNonce?: string) {
  const now = Date.now();
  return d.pendingOrders
    .filter((p) => p.intentHash === iHash && p.nonce !== excludeNonce && now < p.expiresAt)
    .reduce((sum, p) => sum + p.totalMicro, 0);
}

function unconfirmedResponse(rec: UnconfirmedPayment) {
  return NextResponse.json(
    {
      error: {
        code: "PAYMENT_RECEIVED_UNCONFIRMED",
        message: "지불은 확인됐지만 주문을 확정하지 못했습니다",
        detail: `사유 ${rec.reason} · 지불됨·미확정으로 기록됨 · 환불은 가맹점 수동 처리`,
      },
      unconfirmedPayment: rec,
    },
    { status: 409 }
  );
}

function receiptOf(order: Order, merchant: Merchant) {
  const body = { orderId: order.id, totalMicro: order.totalMicro, txSig: order.txSig };
  return { ...body, merchantPubB58: merchant.walletPubB58, sigB58: signPayload(body, merchant.walletSecretB58) };
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

  const iHash = intentHash(intent);
  const payment = parsePaymentHeader(req.headers.get("X-PAYMENT"));

  if (payment) {
    // 멱등 재시도: 이미 확정된 결제 증빙이면 새 주문 없이 기존 주문을 돌려준다.
    // 정책 재검사보다 먼저 한다 — 확정 뒤에는 재고·예산이 이미 이 주문만큼 줄어 있다.
    const cur = loadDB();
    if (cur.usedSigs.includes(payment.signature)) {
      const prev = cur.orders.find(
        (o) => o.txSig === payment.signature && o.merchantId === merchant.id && o.nonce === payment.nonce
      );
      if (!prev) {
        const rec = cur.unconfirmedPayments.find(
          (u) => u.txSig === payment.signature && u.merchantId === merchant.id && u.nonce === payment.nonce
        );
        if (rec) return unconfirmedResponse(rec);
        return reject("PAYMENT_REPLAYED", "이미 사용된 트랜잭션입니다(리플레이 차단)");
      }
      return NextResponse.json({ order: prev, receipt: receiptOf(prev, merchant), idempotentReplay: true });
    }
    const keys = [`sig:${payment.signature}`, `nonce:${payment.nonce}`];
    if (keys.some((k) => inflight.has(k)))
      return reject(
        "PAYMENT_IN_PROGRESS",
        "같은 결제 증빙을 이미 검증 중입니다",
        "잠시 후 같은 요청을 다시 보내면 확정된 주문을 돌려받습니다",
        409
      );
    keys.forEach((k) => inflight.add(k));
    try {
      return await confirmPayment({ merchant, intent, cartMandate, iHash, payment });
    } finally {
      keys.forEach((k) => inflight.delete(k));
    }
  }

  // ── 결정론 정책 검증 (결제 이전 프리체크 — 실패 시 자금 이동 자체가 없음)
  // 예산은 확정액 + 미결제 402 예약액 기준. 예산을 넘는 402는 발급하지 않는다
  // (발급하면 에이전트가 지불한 뒤에야 예산 초과로 거절되어 돈만 이동한다 — T12).
  const precheck = validatePolicy({
    intent,
    cart: cartMandate,
    merchant,
    spentMicro: (db.mandateSpend[iHash] ?? 0) + reservedMicro(db, iHash),
  });
  if (!precheck.ok)
    return reject(precheck.code!, POLICY_MESSAGES[precheck.code as PolicyFail], precheck.detail);

  // ── 1차 호출: 402 + PaymentRequirements
  const payToB58 = await ensurePayTo(merchant.walletPubB58);
  const nonce = newId("ord");
  // ensurePayTo를 기다리는 동안 다른 402가 예약했을 수 있다 → 기록 직전에 최신 상태로 다시 검사
  const policy = mutateDB((d) => {
    d.pendingOrders = d.pendingOrders.filter((p) => Date.now() < p.expiresAt + PENDING_RETAIN_MS);
    const spentMicro = (d.mandateSpend[iHash] ?? 0) + reservedMicro(d, iHash);
    const m = d.merchants.find((x) => x.id === merchant.id) ?? merchant;
    const r = validatePolicy({ intent, cart: cartMandate, merchant: m, spentMicro });
    if (!r.ok) return r;
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
    return r;
  });
  if (!policy.ok)
    return reject(policy.code!, POLICY_MESSAGES[policy.code as PolicyFail], policy.detail);
  const requirements = buildRequirements({
    network: db.mode === "sandbox" ? "sandbox" : "solana-devnet",
    mintB58: db.mintB58!,
    payToB58,
    amountMicro: cartMandate.totalMicro,
    nonce,
  });
  return NextResponse.json(requirements, { status: 402 });
}

// ── 2차 호출: 온체인 지불 검증 → 재검사 후 커밋 (호출자가 in-flight 잠금을 잡고 있다)
async function confirmPayment(params: {
  merchant: Merchant;
  intent: IntentMandate;
  cartMandate: CartMandate;
  iHash: string;
  payment: PaymentHeader;
}) {
  const { merchant, intent, cartMandate, iHash, payment } = params;
  const db = loadDB(); // 잠금을 잡은 뒤의 최신 상태로 판단한다
  // 자기 402 예약분은 빼고 다른 미결제 예약만 더한다 — 자기 몫은 발급 때 이미 예산 안에 잡혀 있다
  const spentMicro = (db.mandateSpend[iHash] ?? 0) + reservedMicro(db, iHash, payment.nonce);
  const policy = validatePolicy({
    intent,
    cart: cartMandate,
    merchant: db.merchants.find((x) => x.id === merchant.id) ?? merchant,
    spentMicro,
  });
  const pending = db.pendingOrders.find(
    (p) => p.nonce === payment.nonce && p.merchantId === merchant.id
  );
  // 결제 요청과 연결할 수 없는 증빙은 지불 여부와 무관하게 기존대로 거절
  if (!pending || pending.intentHash !== iHash || pending.totalMicro !== cartMandate.totalMicro) {
    if (!policy.ok)
      return reject(policy.code!, POLICY_MESSAGES[policy.code as PolicyFail], policy.detail);
    if (!pending) return reject("PAYMENT_NONCE_UNKNOWN", "유효한 결제 요청(nonce)이 없습니다");
    return reject("PAYMENT_CART_CHANGED", "결제 요청 이후 카트가 변경되었습니다");
  }

  // 402 이후 확정할 수 없게 된 사유(만료·재고 소진 등). 지불이 검증되면 거절 대신 미확정으로 기록한다
  const blocker: { code: string; message: string; detail?: string } | null =
    Date.now() > pending.expiresAt
      ? { code: "PAYMENT_EXPIRED", message: "결제 요청이 만료되었습니다" }
      : !policy.ok
        ? { code: policy.code!, message: POLICY_MESSAGES[policy.code as PolicyFail], detail: policy.detail }
        : null;

  const verify = await verifyPayment({
    sig: payment.signature,
    payToB58: pending.payToB58,
    amountMicro: pending.totalMicro,
    memo: pending.nonce,
  });
  if (!verify.ok) {
    if (blocker) return reject(blocker.code, blocker.message, blocker.detail);
    return reject("PAYMENT_AMOUNT_MISMATCH", "온체인 지불 검증 실패", verify.reason);
  }

  // ── 커밋: 재고 차감 · 예산 집행 기록 · 주문/정산 원장
  // 검증을 기다리는 동안 상태가 바뀌었을 수 있으므로 기록 직전에 다시 확인한다(check-and-set).
  const result = mutateDB((d) => {
    if (d.usedSigs.includes(payment.signature)) return { kind: "replayed" as const };
    const m = d.merchants.find((x) => x.id === merchant.id)!;
    const reason =
      blocker?.code ??
      (!d.pendingOrders.some((p) => p.nonce === pending.nonce)
        ? "PAYMENT_NONCE_UNKNOWN"
        : cartMandate.items.some((l) => (m.items.find((i) => i.id === l.itemId)?.stock ?? 0) < l.qty)
          ? "CART_STOCK_INSUFFICIENT"
          : (d.mandateSpend[iHash] ?? 0) + cartMandate.totalMicro > intent.budgetMicro
            ? "MANDATE_BUDGET_EXCEEDED"
            : null);
    // 지불된 증빙은 어느 쪽이든 사용 처리하고 402 예약을 푼다
    d.usedSigs.push(payment.signature);
    d.pendingOrders = d.pendingOrders.filter((p) => p.nonce !== pending.nonce);
    if (reason) {
      const rec: UnconfirmedPayment = {
        id: newId("unconf"),
        txSig: payment.signature,
        nonce: pending.nonce,
        merchantId: m.id,
        intentHash: iHash,
        amountMicro: pending.totalMicro,
        reason,
        status: "paid_unconfirmed",
        recordedAt: Date.now(),
      };
      d.unconfirmedPayments.push(rec);
      return { kind: "unconfirmed" as const, rec };
    }

    for (const line of cartMandate.items) {
      const item = m.items.find((i) => i.id === line.itemId)!;
      item.stock -= line.qty;
    }
    d.mandateSpend[iHash] = (d.mandateSpend[iHash] ?? 0) + cartMandate.totalMicro;

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
      nonce: pending.nonce,
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
    return { kind: "order" as const, o };
  });
  if (result.kind === "replayed")
    return reject("PAYMENT_REPLAYED", "이미 사용된 트랜잭션입니다(리플레이 차단)");
  if (result.kind === "unconfirmed") return unconfirmedResponse(result.rec);
  const order = result.o;

  // 검증 6단계 통과 내역 — UI 스텝퍼 시각화용
  const usd = (m: number) => (m / 1e6).toFixed(2);
  const verification = [
    { label: "위임장·카트 서명 검증 (ed25519)", detail: "principal·agent 서명 유효" },
    { label: "위임 유효기간", detail: `만료 ${new Date(intent.expiresAt).toLocaleString("ko-KR")}` },
    { label: "위임 범위(카테고리)", detail: `[${intent.scopeCategories.join(", ")}] 내 구매` },
    { label: "카트 정합성 (단가·재고)", detail: "판매가 일치 · 재고 충족" },
    {
      label: "예산 한도 집행",
      detail: `누적·예약 ${usd(spentMicro)} + 이번 ${usd(cartMandate.totalMicro)} ≤ 예산 ${usd(intent.budgetMicro)} USDC`,
    },
    {
      label: "온체인 지불 검증",
      detail: `${usd(pending.totalMicro)} USDC · 수취인·금액·memo(nonce) 일치 · 리플레이 차단`,
    },
  ];
  return NextResponse.json({
    order,
    receipt: receiptOf(order, merchant), // 머천트 서명 영수증 — 부인 불가능성
    verification,
  });
}
