/* 통합 테스트 — 서버(기본 http://localhost:3402)가 떠 있어야 한다.
   I1 카탈로그/견적 · I2 자율구매 풀사이클 · I3~I5 네거티브 3종 ·
   I6 과소지불 공격 · I7 리플레이 공격 */
import { loadDB } from "../src/lib/store";
import { makeIntentMandate, makeCartMandate } from "../src/lib/mandate";
import { transferUsdc } from "../src/lib/chain";
import { encodePaymentHeader, type X402Body } from "../src/lib/x402";
import { MICRO } from "../src/lib/fx";

const BASE = process.env.BASE_URL || "http://localhost:3402";
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface AgentEvent { step: string; level: string; message: string; data?: Record<string, unknown> }

async function runAgent(scenario: string): Promise<AgentEvent[]> {
  const res = await fetch(`${BASE}/api/agent/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario, goal: "카페 블렌드 원두 5kg 조달", category: "식자재", qty: 5, budgetUsdc: 100 }),
  });
  const text = await res.text();
  return text
    .split("\n\n")
    .map((c) => c.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)));
}

async function main() {
  console.log(`\n=== 장보고 통합 테스트 (${BASE}) ===\n`);

  // 셋업
  const setup = await (await fetch(`${BASE}/api/setup`, { method: "POST" })).json();
  console.log(`[셋업] 모드: ${setup.mode} · mint: ${setup.mintB58?.slice(0, 12)}… · 에이전트 잔액 ${setup.buyerUsdcMicro / MICRO} USDC\n`);

  // I1: 카탈로그 + 견적
  console.log("[I1] 카탈로그·견적");
  const state = await (await fetch(`${BASE}/api/state`)).json();
  check("가맹점 4곳 이상 시딩", state.merchants.length >= 4);
  const m0 = state.merchants[0];
  const catalog = await (await fetch(`${BASE}/api/m/${m0.id}/catalog`)).json();
  check("카탈로그 protocol=jangbogo/v1", catalog.protocol === "jangbogo/v1");
  check("카탈로그에 x402 명시", Array.isArray(catalog.payment) && catalog.payment.includes("x402"));
  const quoteRes = await (await fetch(`${BASE}/api/m/${m0.id}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { role: "buyer-agent", parts: [{ kind: "text", text: "블렌드 원두" }], metadata: { category: "식자재" } } }),
  })).json();
  const quotes = quoteRes?.message?.parts?.[0]?.data?.quotes ?? [];
  check("A2A 견적 1건 이상", quotes.length >= 1);

  // I2: 자율 구매 풀사이클
  console.log("\n[I2] 자율 구매 풀사이클 (normal)");
  const ev2 = await runAgent("normal");
  const receipt = ev2.find((e) => e.step === "receipt");
  const done2 = ev2.find((e) => e.step === "done");
  check("영수증 수취", !!receipt, ev2.map((e) => e.message).join(" | ").slice(0, 300));
  check("완주(done success)", done2?.level === "success");
  const quoteEvents = ev2.filter((e) => e.step === "quote");
  check("견적 3곳 이상 비교", quoteEvents.length >= 3);
  const orderState = await (await fetch(`${BASE}/api/state`)).json();
  check("주문 생성", orderState.orders.length >= 1);
  check("정산 원장 생성 (수수료 0.5%)", orderState.ledger.length >= 1 &&
    orderState.ledger[0].feeMicro === Math.round(orderState.ledger[0].grossMicro * 0.005));

  // I3~I5: 네거티브
  for (const [id, scenario, code] of [
    ["I3", "over_budget", "MANDATE_BUDGET_EXCEEDED"],
    ["I4", "expired", "MANDATE_EXPIRED"],
    ["I5", "out_of_scope", "MANDATE_SCOPE_VIOLATION"],
  ] as const) {
    console.log(`\n[${id}] 네거티브: ${scenario}`);
    const ev = await runAgent(scenario);
    const blocked = ev.find((e) => e.step === "blocked");
    check(`${code}로 차단`, !!blocked && blocked.message.includes(code),
      ev.map((e) => e.message).join(" | ").slice(0, 200));
    check("결제 전 차단(자금 미이동)", !ev.some((e) => e.step === "pay" && e.level === "success"));
  }

  // I6: 과소지불 공격 — 402 수신 후 1 micro 모자라게 지불
  console.log("\n[I6] 과소지불 공격");
  const db = loadDB();
  const target = db.merchants[0];
  const item = target.items.find((i) => i.stock > 0)!;
  const intent = makeIntentMandate({
    principal: db.principal!,
    agentPubB58: db.buyer!.pubB58,
    scopeCategories: [item.category],
    budgetMicro: 100 * MICRO,
    expiresAt: Date.now() + 86400_000,
  });
  const cart = makeCartMandate({
    agentSecretB58: db.buyer!.secretB58,
    intent,
    merchantId: target.id,
    items: [{ itemId: item.id, qty: 1, unitMicro: item.priceMicro }],
  });
  const buyUrl = `${BASE}/api/m/${target.id}/buy`;
  const buyBody = JSON.stringify({ cart: { items: cart.items }, mandates: { intent, cart } });
  const r402 = await fetch(buyUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: buyBody });
  check("1차 응답 402", r402.status === 402);
  const x402 = (await r402.json()) as X402Body;
  const req = x402.accepts[0];
  const { sig: underSig } = await transferUsdc({
    fromSecretB58: db.buyer!.secretB58,
    payToB58: req.payTo,
    amountMicro: req.amountMicro - 1,
    memo: req.memo,
  });
  const rUnder = await fetch(buyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": encodePaymentHeader({ signature: underSig, payer: db.buyer!.pubB58, nonce: req.nonce }),
    },
    body: buyBody,
  });
  const underBody = await rUnder.json();
  check("과소지불 403 거절", rUnder.status === 403, JSON.stringify(underBody).slice(0, 200));
  check("코드 PAYMENT_AMOUNT_MISMATCH", underBody?.error?.code === "PAYMENT_AMOUNT_MISMATCH");

  // I7: 리플레이 — 이미 사용된 서명 재사용
  console.log("\n[I7] 리플레이 공격");
  const usedSig = loadDB().orders.at(-1)?.txSig;
  if (!usedSig) {
    check("리플레이 테스트 준비(기사용 서명 존재)", false, "선행 주문 없음");
  } else {
    const r402b = await fetch(buyUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: buyBody });
    const nonce2 = ((await r402b.json()) as X402Body).accepts[0].nonce;
    const rReplay = await fetch(buyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": encodePaymentHeader({ signature: usedSig, payer: db.buyer!.pubB58, nonce: nonce2 }),
      },
      body: buyBody,
    });
    const replayBody = await rReplay.json();
    check("리플레이 403 거절", rReplay.status === 403);
    check("코드 PAYMENT_REPLAYED", replayBody?.error?.code === "PAYMENT_REPLAYED", JSON.stringify(replayBody).slice(0, 200));
  }

  console.log(`\n=== 결과: ${pass} 통과 / ${fail} 실패 (모드: ${setup.mode}) ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("통합 테스트 실행 오류:", e);
  process.exit(1);
});
