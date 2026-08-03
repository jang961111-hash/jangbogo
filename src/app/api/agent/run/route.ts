import { NextRequest } from "next/server";
import { runAgent, type AgentParams, type Scenario } from "@/lib/agent";
import { seedMerchants } from "@/lib/seed";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 자율 구매 에이전트 실행 — SSE 스트림으로 단계별 로그 송출
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  seedMerchants();
  // Cloud Run 등 프록시 뒤에서는 공개 URL self-fetch가 막힐 수 있어 루프백을 우선 사용
  const params: AgentParams = {
    baseUrl: process.env.SELF_URL || new URL(req.url).origin,
    goal: body.goal || "카페 블렌드 원두 5kg 조달",
    category: body.category || "식자재",
    qty: Number(body.qty) || 5,
    budgetUsdc: Number(body.budgetUsdc) || 100,
    maxUnitPriceUsdc: body.maxUnitPriceUsdc ? Number(body.maxUnitPriceUsdc) : undefined,
    scenario: (body.scenario as Scenario) || "normal",
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        await runAgent(params, emit);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
