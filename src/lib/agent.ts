import { ensureSetup, transferUsdc, getUsdcBalance } from "./chain";
import { makeIntentMandate, makeCartMandate, type IntentMandate } from "./mandate";
import { encodePaymentHeader, type X402Body } from "./x402";
import { loadDB, publicMerchant } from "./store";
import { decisionReason } from "./llm";
import { MICRO, fmtUsdc } from "./fx";

// 자율 구매 에이전트 — DISCOVER → QUOTE → DECIDE → PAY → x402 RETRY → RECEIPT
// 전 과정에 사람 승인 없음. 안전장치는 mandate(위임장)와 판매자측 정책 엔진.

export type Scenario = "normal" | "over_budget" | "expired" | "out_of_scope";

export interface AgentParams {
  baseUrl: string;
  goal: string;
  category: string;
  qty: number;
  budgetUsdc: number;
  maxUnitPriceUsdc?: number;
  scenario: Scenario;
}

export interface AgentEvent {
  step: string;
  level: "info" | "success" | "error" | "warn";
  message: string;
  data?: unknown;
}

type Emit = (e: AgentEvent) => void;

function issueMandate(params: AgentParams): IntentMandate {
  const db = loadDB();
  const principal = db.principal!;
  const agentPub = db.buyer!.pubB58;
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;

  switch (params.scenario) {
    case "over_budget":
      return makeIntentMandate({
        principal, agentPubB58: agentPub,
        scopeCategories: [params.category],
        budgetMicro: Math.round(50 * MICRO),
        expiresAt: now + 7 * DAY,
      });
    case "expired":
      return makeIntentMandate({
        principal, agentPubB58: agentPub,
        scopeCategories: [params.category],
        budgetMicro: Math.round(params.budgetUsdc * MICRO),
        issuedAt: now - 2 * DAY,
        expiresAt: now - 1 * DAY,
      });
    case "out_of_scope":
      return makeIntentMandate({
        principal, agentPubB58: agentPub,
        scopeCategories: ["포장재"],
        budgetMicro: Math.round(params.budgetUsdc * MICRO),
        expiresAt: now + 7 * DAY,
      });
    default:
      return makeIntentMandate({
        principal, agentPubB58: agentPub,
        scopeCategories: [params.category],
        budgetMicro: Math.round(params.budgetUsdc * MICRO),
        expiresAt: now + 7 * DAY,
      });
  }
}

export async function runAgent(params: AgentParams, emit: Emit): Promise<void> {
  const t0 = Date.now();
  try {
    // 0. 셋업
    emit({ step: "setup", level: "info", message: "지갑·체인 상태 확인 중..." });
    const setup = await ensureSetup();
    emit({
      step: "setup", level: "success",
      message: `체인 준비 완료 [${setup.mode.toUpperCase()}] · 에이전트 지갑 잔액 ${fmtUsdc(setup.buyerUsdcMicro)} USDC`,
      data: { mode: setup.mode, wallet: setup.buyerPubB58 },
    });

    // 1. 위임장 발급 (principal = 사장님 키 서명)
    const intent = issueMandate(params);
    const scenarioNote =
      params.scenario === "normal" ? "" : ` (네거티브 시나리오: ${params.scenario})`;
    emit({
      step: "mandate_issued", level: "info",
      message: `AP2 Intent Mandate 발급${scenarioNote} — 범위 [${intent.scopeCategories.join(",")}] · 예산 ${fmtUsdc(intent.budgetMicro)} USDC · 만료 ${new Date(intent.expiresAt).toLocaleString("ko-KR")}`,
      data: { intent },
    });

    // 2. 가맹점 탐색
    const db = loadDB();
    const merchants = db.merchants.map(publicMerchant);
    emit({
      step: "discover", level: "info",
      message: `등록 가맹점 ${merchants.length}곳 탐색 — 견적 요청 시작`,
      data: { merchants: merchants.map((m) => m.name) },
    });

    // 3. 견적 수집 (A2A 메시지 구조, 실제 HTTP)
    const allQuotes: {
      merchantId: string; merchantName: string;
      itemId: string; itemName: string; unitMicro: number; unitPriceUsdc: string;
      qtyAvailable: number;
    }[] = [];
    for (const m of merchants) {
      const res = await fetch(`${params.baseUrl}/api/m/${m.id}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            role: "buyer-agent",
            parts: [{ kind: "text", text: params.goal }],
            metadata: {
              category: params.category,
              maxUnitPriceUsdc: params.maxUnitPriceUsdc,
            },
          },
        }),
      });
      const body = await res.json();
      const quotes = body?.message?.parts?.[0]?.data?.quotes ?? [];
      if (quotes.length === 0) {
        emit({ step: "quote", level: "warn", message: `${m.name}: 조건에 맞는 견적 없음` });
        continue;
      }
      for (const q of quotes) {
        allQuotes.push({
          merchantId: m.id, merchantName: m.name,
          itemId: q.itemId, itemName: q.name,
          unitMicro: q.unitMicro, unitPriceUsdc: q.unitPriceUsdc,
          qtyAvailable: q.qtyAvailable,
        });
      }
      emit({
        step: "quote", level: "info",
        message: `${m.name}: 견적 ${quotes.length}건 수신 (최저 ${quotes.map((q: { unitPriceUsdc: string }) => q.unitPriceUsdc).sort()[0]} USDC)`,
        data: { merchant: m.name, quotes },
      });
    }
    if (allQuotes.length === 0) {
      emit({ step: "done", level: "error", message: "견적을 받지 못해 종료합니다." });
      return;
    }

    // 4. 의사결정 (결정론: 재고 충족 + 최저 단가 / LLM은 사유 서술만)
    const eligible = allQuotes
      .filter((q) => q.qtyAvailable >= params.qty)
      .sort((a, b) => a.unitMicro - b.unitMicro);
    const chosen = eligible[0] ?? allQuotes.sort((a, b) => a.unitMicro - b.unitMicro)[0];
    const rejected = allQuotes.filter((q) => q !== chosen).slice(0, 3);
    const reason = await decisionReason({
      goal: params.goal,
      chosen: {
        merchantName: chosen.merchantName, itemName: chosen.itemName,
        unitUsdc: chosen.unitPriceUsdc, qty: params.qty,
      },
      rejected: rejected.map((r) => ({
        merchantName: r.merchantName, itemName: r.itemName, unitUsdc: r.unitPriceUsdc,
      })),
    });
    const totalMicro = chosen.unitMicro * params.qty;
    emit({
      step: "decide", level: "success",
      message: `선택: ${chosen.merchantName} — ${chosen.itemName} × ${params.qty} = ${fmtUsdc(totalMicro)} USDC · 사유(${reason.source}): ${reason.text}`,
      data: { chosen, totalMicro, reason },
    });

    // 5. Cart Mandate 서명 + 주문 시도 (x402 1차 — 결제 전 정책 프리체크)
    const cart = makeCartMandate({
      agentSecretB58: loadDB().buyer!.secretB58,
      intent,
      merchantId: chosen.merchantId,
      items: [{ itemId: chosen.itemId, qty: params.qty, unitMicro: chosen.unitMicro }],
    });
    const buyUrl = `${params.baseUrl}/api/m/${chosen.merchantId}/buy`;
    const buyBody = JSON.stringify({
      cart: { items: cart.items },
      mandates: { intent, cart },
    });
    emit({ step: "pay", level: "info", message: `주문 요청 → ${chosen.merchantName} (x402 플로우 개시)` });
    const first = await fetch(buyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buyBody,
    });

    if (first.status === 403) {
      const err = await first.json();
      emit({
        step: "blocked", level: "error",
        message: `가맹점이 결제를 거절했습니다 — [${err?.error?.code}] ${err?.error?.message}${err?.error?.detail ? ` (${err.error.detail})` : ""}`,
        data: err,
      });
      emit({
        step: "done", level: "warn",
        message: "정책 엔진이 결제 이전에 차단 — 온체인 자금은 이동하지 않았습니다. (판매자측 mandate 검증의 가치)",
      });
      return;
    }
    if (first.status !== 402) {
      emit({ step: "done", level: "error", message: `예상 밖 응답 ${first.status}`, data: await first.text() });
      return;
    }

    const x402 = (await first.json()) as X402Body;
    const req = x402.accepts[0];
    emit({
      step: "x402", level: "info",
      message: `402 Payment Required 수신 — ${req.amount} USDC → ${req.payTo.slice(0, 8)}... (nonce ${req.nonce.slice(0, 12)}...)`,
      data: x402,
    });

    // 6. 온체인 지불 (사람 승인 없음 — mandate 한도 내)
    const { sig } = await transferUsdc({
      fromSecretB58: loadDB().buyer!.secretB58,
      payToB58: req.payTo,
      amountMicro: req.amountMicro,
      memo: req.memo,
    });
    emit({
      step: "pay", level: "success",
      message: `USDC 전송 완료 — tx ${sig.slice(0, 20)}...`,
      data: { sig },
    });

    // 7. X-PAYMENT 재시도
    const second = await fetch(buyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": encodePaymentHeader({
          signature: sig,
          payer: loadDB().buyer!.pubB58,
          nonce: req.nonce,
        }),
      },
      body: buyBody,
    });
    const result = await second.json();
    if (second.status !== 200) {
      emit({ step: "done", level: "error", message: `주문 확정 실패 [${second.status}]`, data: result });
      return;
    }
    const remain = await getUsdcBalance(loadDB().buyer!.pubB58);
    emit({
      step: "receipt", level: "success",
      message: `주문 확정 · 영수증 수취 — 주문 ${result.order.id} · 총 ${fmtUsdc(result.order.totalMicro)} USDC · 에이전트 잔액 ${fmtUsdc(remain)} USDC`,
      data: result,
    });
    emit({
      step: "done", level: "success",
      message: `자율 조달 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s, 사람 승인 0회) — 트랜잭션: ${result.order.explorerUrl}`,
      data: { explorerUrl: result.order.explorerUrl },
    });
  } catch (e) {
    emit({ step: "done", level: "error", message: `에이전트 오류: ${(e as Error).message}` });
  }
}
