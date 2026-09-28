/* 결제 무결성 통합 테스트 — 실제 라우트 핸들러 + 파일 DB + sandbox 체인을 프로세스 안에서 돌린다.
   서버·외부 네트워크(devnet·Gemini) 없이 동작한다.
   T8-A 같은 결제 증빙 동시 전송 · T8-B 예산 경합 · T12 지불 후 거절 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { POST as buyRoute } from "../src/app/api/m/[id]/buy/route";
import { POST as quoteRoute } from "../src/app/api/m/[id]/quote/route";
import { loadDB, mutateDB } from "../src/lib/store";
import { ensureSetup, transferUsdc } from "../src/lib/chain";
import { seedMerchants } from "../src/lib/seed";
import { makeIntentMandate, makeCartMandate, intentHash } from "../src/lib/mandate";
import { encodePaymentHeader, type X402Body } from "../src/lib/x402";
import { MICRO } from "../src/lib/fx";

// store·chain은 환경변수를 호출 시점에 읽는다 → import 이후에 설정해도 된다
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jangbogo-test-"));
process.env.JANGBOGO_DATA_DIR = TMP;
process.env.CHAIN_MODE = "sandbox";

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(async () => {
  fs.rmSync(path.join(TMP, "db.json"), { force: true });
  await ensureSetup();
  seedMerchants();
});
afterEach(() => {
  delete process.env.SBX_VERIFY_DELAY_MS;
});

const QTY = 5; // 블렌드 원두 1kg × 5 = 65.517240 USDC

function scenario(budgetUsdc: number) {
  const db = loadDB();
  const m = db.merchants.find((x) => x.name === "성수 로스터리")!;
  const item = m.items.find((i) => i.name === "블렌드 원두 1kg")!;
  const intent = makeIntentMandate({
    principal: db.principal!,
    agentPubB58: db.buyer!.pubB58,
    scopeCategories: ["식자재"],
    budgetMicro: budgetUsdc * MICRO,
    expiresAt: Date.now() + 86400_000,
  });
  const body = () => {
    const cart = makeCartMandate({
      agentSecretB58: db.buyer!.secretB58,
      intent,
      merchantId: m.id,
      items: [{ itemId: item.id, qty: QTY, unitMicro: item.priceMicro }],
    });
    return JSON.stringify({ cart: { items: cart.items }, mandates: { intent, cart } });
  };
  return { db, m, item, intent, h: intentHash(intent), body };
}

async function buy(merchantId: string, body: string, xpay?: string) {
  const req = new NextRequest(`http://test.local/api/m/${merchantId}/buy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(xpay ? { "X-PAYMENT": xpay } : {}) },
    body,
  });
  const res = await buyRoute(req, { params: Promise.resolve({ id: merchantId }) });
  return { status: res.status, json: await res.json() };
}

/** 402를 받고 sandbox에서 실제로 지불한 뒤 X-PAYMENT 헤더를 돌려준다. 402가 아니면 null */
async function requestAndPay(s: ReturnType<typeof scenario>, body: string) {
  const r = await buy(s.m.id, body);
  if (r.status !== 402) return { first: r, xpay: null as string | null, paidMicro: 0 };
  const req = (r.json as X402Body).accepts[0];
  const { sig } = await transferUsdc({
    fromSecretB58: s.db.buyer!.secretB58,
    payToB58: req.payTo,
    amountMicro: req.amountMicro,
    memo: req.memo,
  });
  const xpay = encodePaymentHeader({ signature: sig, payer: s.db.buyer!.pubB58, nonce: req.nonce });
  return { first: r, xpay, paidMicro: req.amountMicro, sig };
}

const stockOf = (s: ReturnType<typeof scenario>) =>
  loadDB().merchants.find((x) => x.id === s.m.id)!.items.find((i) => i.id === s.item.id)!.stock;

describe("T8-A 같은 결제 증빙의 동시 전송 (리플레이 경합)", () => {
  it("같은 X-PAYMENT 10개를 동시에 보내도 주문·재고 차감·원장은 1건", async () => {
    process.env.SBX_VERIFY_DELAY_MS = "50";
    const s = scenario(1000);
    const body = s.body();
    const p = await requestAndPay(s, body);
    expect(p.first.status).toBe(402);
    const stockBefore = stockOf(s);
    const ledgerBefore = loadDB().ledger.length;

    const rs = await Promise.all(Array.from({ length: 10 }, () => buy(s.m.id, body, p.xpay!)));

    const db = loadDB();
    expect(db.orders.filter((o) => o.txSig === p.sig)).toHaveLength(1);
    expect(stockBefore - stockOf(s)).toBe(QTY);
    expect(db.ledger.length - ledgerBefore).toBe(1);
    const okIds = new Set(rs.filter((r) => r.status === 200).map((r) => r.json.order.id));
    expect(okIds.size).toBe(1);
    for (const r of rs.filter((r) => r.status !== 200)) {
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("PAYMENT_IN_PROGRESS");
    }
  });

  it("확정 후 같은 X-PAYMENT 재전송은 기존 주문을 돌려준다 (멱등 재시도)", async () => {
    const s = scenario(1000);
    const body = s.body();
    const p = await requestAndPay(s, body);
    const r1 = await buy(s.m.id, body, p.xpay!);
    expect(r1.status).toBe(200);
    const r2 = await buy(s.m.id, body, p.xpay!);
    expect(r2.status).toBe(200);
    expect(r2.json.order.id).toBe(r1.json.order.id);
    expect(r2.json.idempotentReplay).toBe(true);
    expect(loadDB().orders.filter((o) => o.txSig === p.sig)).toHaveLength(1);
  });

  it("사용된 서명을 새 nonce에 붙이면 PAYMENT_REPLAYED", async () => {
    const s = scenario(1000);
    const body = s.body();
    const p = await requestAndPay(s, body);
    expect((await buy(s.m.id, body, p.xpay!)).status).toBe(200);
    const r402 = await buy(s.m.id, body);
    const nonce2 = (r402.json as X402Body).accepts[0].nonce;
    const xpay2 = encodePaymentHeader({ signature: p.sig!, payer: s.db.buyer!.pubB58, nonce: nonce2 });
    const r = await buy(s.m.id, body, xpay2);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("PAYMENT_REPLAYED");
  });
});

describe("T8-B · T12 위임 예산 (예산 100 USDC, 주문 65.52 USDC)", () => {
  async function run(K: number, concurrent: boolean) {
    const s = scenario(100);
    const pays: ({ body: string } & Awaited<ReturnType<typeof requestAndPay>>)[] = [];
    for (let i = 0; i < K; i++) {
      const body = s.body();
      pays.push({ body, ...(await requestAndPay(s, body)) });
    }
    const send = (p: (typeof pays)[number]) => (p.xpay ? buy(s.m.id, p.body, p.xpay) : null);
    const rs = concurrent
      ? await Promise.all(pays.map(send))
      : await pays.reduce<Promise<unknown[]>>(async (acc, p) => [...(await acc), await send(p)], Promise.resolve([]));
    const spent = loadDB().mandateSpend[s.h] ?? 0;
    const moved = pays.reduce((a, p) => a + p.paidMicro, 0);
    return { s, pays, rs, spent, moved };
  }

  it("T8-B: X-PAYMENT를 동시에 보내도 누적 확정액이 예산을 넘지 않는다", async () => {
    process.env.SBX_VERIFY_DELAY_MS = "50";
    const { spent, moved } = await run(3, true);
    expect(spent).toBeLessThanOrEqual(100 * MICRO);
    expect(spent).toBeGreaterThan(0);
    expect(moved).toBe(spent); // 주문 없이 이동한 돈 0
  });

  it("T12: 순차로 402를 받아도 예산을 넘는 402는 발급되지 않는다 (지불 후 거절 0)", async () => {
    const { pays, spent, moved } = await run(3, false);
    expect(pays[0].first.status).toBe(402);
    for (const p of pays.slice(1)) {
      expect(p.first.status).toBe(403);
      expect(p.first.json.error.code).toBe("MANDATE_BUDGET_EXCEEDED");
      expect(p.xpay).toBeNull();
    }
    expect(spent).toBe(pays[0].paidMicro);
    expect(moved).toBe(spent);
  });

  it("402 요청을 동시에 보내도 예산 안의 402만 발급된다", async () => {
    const s = scenario(100);
    const rs = await Promise.all(Array.from({ length: 5 }, () => buy(s.m.id, s.body())));
    expect(rs.filter((r) => r.status === 402)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 403 && r.json.error.code === "MANDATE_BUDGET_EXCEEDED")).toHaveLength(4);
  });

  it("만료된 402의 예약은 해제되어 예산을 돌려준다", async () => {
    const s = scenario(100);
    expect((await buy(s.m.id, s.body())).status).toBe(402);
    expect((await buy(s.m.id, s.body())).status).toBe(403);
    mutateDB((d) => {
      for (const p of d.pendingOrders) p.expiresAt = Date.now() - 1;
    });
    expect((await buy(s.m.id, s.body())).status).toBe(402);
  });
});

describe("견적 라우트 (A2A)", () => {
  async function quote(merchantId: string, text: string) {
    const req = new NextRequest(`http://test.local/api/m/${merchantId}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { role: "buyer-agent", parts: [{ kind: "text", text }], metadata: { category: "식자재" } } }),
    });
    const res = await quoteRoute(req, { params: Promise.resolve({ id: merchantId }) });
    return res.json();
  }

  it("요청과 일치하는 상품만 견적하고, 무관한 요청엔 견적 0건", async () => {
    const m = loadDB().merchants.find((x) => x.name === "성수 로스터리")!;
    const hit = (await quote(m.id, "블렌드 원두")).message.parts[0].data.quotes;
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((q: { name: string }) => q.name.includes("원두"))).toBe(true);
    const miss = (await quote(m.id, "플레인 베이글")).message.parts[0].data.quotes;
    expect(miss).toHaveLength(0);
  });
});

describe("지불됨·미확정 — 지불 확인 뒤 확정할 수 없으면 조용히 거절하지 않고 기록한다", () => {
  it("재고가 먼저 소진되면 두 번째 지불은 PAYMENT_RECEIVED_UNCONFIRMED로 기록된다", async () => {
    const a = scenario(1000);
    mutateDB((d) => {
      d.merchants.find((x) => x.id === a.m.id)!.items.find((i) => i.id === a.item.id)!.stock = QTY;
    });
    const b = scenario(1000);
    const bodyA = a.body();
    const bodyB = b.body();
    const pa = await requestAndPay(a, bodyA);
    const pb = await requestAndPay(b, bodyB);
    expect(pb.first.status).toBe(402); // 재고는 예약하지 않는다 → 둘 다 402를 받고 지불한다

    expect((await buy(a.m.id, bodyA, pa.xpay!)).status).toBe(200);
    const rb = await buy(b.m.id, bodyB, pb.xpay!);
    expect(rb.status).toBe(409);
    expect(rb.json.error.code).toBe("PAYMENT_RECEIVED_UNCONFIRMED");

    const db = loadDB();
    expect(db.unconfirmedPayments).toHaveLength(1);
    const rec = db.unconfirmedPayments[0];
    expect(rec).toMatchObject({ txSig: pb.sig, amountMicro: pb.paidMicro, reason: "CART_STOCK_INSUFFICIENT", status: "paid_unconfirmed" });
    expect(db.orders.filter((o) => o.txSig === pb.sig)).toHaveLength(0);

    // 같은 증빙 재전송 → 같은 기록을 다시 알려준다 (새 기록·주문 없음)
    const again = await buy(b.m.id, bodyB, pb.xpay!);
    expect(again.status).toBe(409);
    expect(again.json.unconfirmedPayment.id).toBe(rec.id);
    expect(loadDB().unconfirmedPayments).toHaveLength(1);
  });

  it("402가 만료된 뒤 도착한 지불도 검증되면 미확정으로 기록된다", async () => {
    const s = scenario(1000);
    const body = s.body();
    const p = await requestAndPay(s, body);
    mutateDB((d) => {
      for (const x of d.pendingOrders) x.expiresAt = Date.now() - 1;
    });
    const r = await buy(s.m.id, body, p.xpay!);
    expect(r.status).toBe(409);
    expect(r.json.unconfirmedPayment).toMatchObject({ txSig: p.sig, reason: "PAYMENT_EXPIRED" });
  });

  it("검증에 실패한 지불(과소지불)은 기록하지 않고 기존대로 거절한다", async () => {
    const s = scenario(1000);
    const body = s.body();
    const r402 = await buy(s.m.id, body);
    const req = (r402.json as X402Body).accepts[0];
    const { sig } = await transferUsdc({ fromSecretB58: s.db.buyer!.secretB58, payToB58: req.payTo, amountMicro: req.amountMicro - 1, memo: req.memo });
    const r = await buy(s.m.id, body, encodePaymentHeader({ signature: sig, payer: s.db.buyer!.pubB58, nonce: req.nonce }));
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("PAYMENT_AMOUNT_MISMATCH");
    expect(loadDB().unconfirmedPayments).toHaveLength(0);
  });
});

describe("보안 리뷰 회귀 — 위조·불일치 요청은 상태를 바꾸지 않는다", () => {
  const forge = (body: string) => {
    const b = JSON.parse(body);
    b.mandates.cart.sigB58 = b.mandates.intent.sigB58; // 형식은 맞지만 cart 서명이 아닌 값
    return JSON.stringify(b);
  };

  it("서명 위조 cart + 유효 지불로 선요청 → 거절·상태 불변 → 정당한 요청은 성공", async () => {
    const s = scenario(1000);
    const body = s.body();
    const p = await requestAndPay(s, body);
    const r = await buy(s.m.id, forge(body), p.xpay!);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("MANDATE_CART_SIG_INVALID");
    const db = loadDB();
    expect(db.usedSigs).not.toContain(p.sig);
    expect(db.unconfirmedPayments).toHaveLength(0);
    expect(db.pendingOrders.some((x) => x.nonce === JSON.parse(Buffer.from(p.xpay!, "base64").toString()).nonce)).toBe(true);
    expect((await buy(s.m.id, body, p.xpay!)).status).toBe(200);
  });

  it("402와 품목이 다른 cart(총액·서명은 유효)는 PAYMENT_CART_CHANGED로 거절된다", async () => {
    const s = scenario(1000);
    const other = s.m.items.find((i) => i.id !== s.item.id)!;
    mutateDB((d) => {
      d.merchants.find((x) => x.id === s.m.id)!.items.find((i) => i.id === other.id)!.priceMicro = s.item.priceMicro;
    });
    const body = s.body();
    const p = await requestAndPay(s, body);
    const swapped = makeCartMandate({
      agentSecretB58: s.db.buyer!.secretB58, intent: s.intent, merchantId: s.m.id,
      items: [{ itemId: other.id, qty: QTY, unitMicro: s.item.priceMicro }],
    });
    const r = await buy(s.m.id, JSON.stringify({ cart: { items: swapped.items }, mandates: { intent: s.intent, cart: swapped } }), p.xpay!);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("PAYMENT_CART_CHANGED");
    expect(loadDB().orders.filter((o) => o.txSig === p.sig)).toHaveLength(0);
    expect((await buy(s.m.id, body, p.xpay!)).status).toBe(200);
  });

  it("확정 뒤 멱등 반환도 mandate 서명 검증을 통과해야 한다", async () => {
    const s = scenario(1000);
    const body = s.body();
    const p = await requestAndPay(s, body);
    expect((await buy(s.m.id, body, p.xpay!)).status).toBe(200);
    const r = await buy(s.m.id, forge(body), p.xpay!);
    expect(r.status).toBe(403);
    expect(r.json.order).toBeUndefined();
  });

  it("검증 대기 중 402가 만료되면 커밋 단계에서 잡아 미확정으로 기록한다", async () => {
    process.env.SBX_VERIFY_DELAY_MS = "80";
    const s = scenario(1000);
    const body = s.body();
    const p = await requestAndPay(s, body);
    mutateDB((d) => {
      for (const x of d.pendingOrders) x.expiresAt = Date.now() + 20;
    });
    const r = await buy(s.m.id, body, p.xpay!);
    expect(r.status).toBe(409);
    expect(r.json.unconfirmedPayment.reason).toBe("PAYMENT_EXPIRED");
  });

  it("검증 실패(과소지불) 뒤 정당한 지불로 재시도하면 성공한다", async () => {
    const s = scenario(1000);
    const body = s.body();
    const req = ((await buy(s.m.id, body)).json as X402Body).accepts[0];
    const pay = async (amt: number) => {
      const { sig } = await transferUsdc({ fromSecretB58: s.db.buyer!.secretB58, payToB58: req.payTo, amountMicro: amt, memo: req.memo });
      return encodePaymentHeader({ signature: sig, payer: s.db.buyer!.pubB58, nonce: req.nonce });
    };
    expect((await buy(s.m.id, body, await pay(req.amountMicro - 1))).status).toBe(403);
    expect((await buy(s.m.id, body, await pay(req.amountMicro))).status).toBe(200);
  });

  it("깨진 DB 파일은 빈 DB로 대체하지 않고 실패한다 (fail-closed — 리플레이 목록 소실 방지)", () => {
    fs.writeFileSync(path.join(TMP, "db.json"), '{"usedSigs": ["a"');
    expect(() => loadDB()).toThrow();
  });
});
