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
    const pays: { body: string; xpay: string | null; paidMicro: number }[] = [];
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
