import { NextRequest, NextResponse } from "next/server";
import { loadDB } from "@/lib/store";
import { makeQuotes } from "@/lib/quote";

export const dynamic = "force-dynamic";

// A2A 메시지 구조를 차용한 견적 교환 — 머천트 에이전트 응답
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const db = loadDB();
  const m = db.merchants.find((x) => x.id === id);
  if (!m)
    return NextResponse.json(
      { error: { code: "MERCHANT_NOT_FOUND", message: "가맹점 없음" } },
      { status: 404 }
    );
  const body = await req.json().catch(() => ({}));
  const msg = body?.message ?? {};
  const text = msg?.parts?.find((p: { kind: string }) => p.kind === "text")?.text ?? "";
  const meta = msg?.metadata ?? {};
  const quotes = makeQuotes(m, {
    text,
    category: meta.category,
    maxUnitPriceUsdc: meta.maxUnitPriceUsdc,
  });
  return NextResponse.json({
    message: {
      role: "merchant-agent",
      merchantId: m.id,
      parts: [{ kind: "data", data: { quotes } }],
    },
  });
}
