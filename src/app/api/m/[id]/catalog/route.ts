import { NextRequest, NextResponse } from "next/server";
import { loadDB } from "@/lib/store";
import { microToUsdc } from "@/lib/fx";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
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
  return NextResponse.json({
    protocol: "jangbogo/v1",
    payment: ["x402"],
    network: db.mode === "sandbox" ? "sandbox" : "solana-devnet",
    asset: db.mintB58 ?? null,
    merchant: { id: m.id, name: m.name, category: m.category, wallet: m.walletPubB58 },
    items: m.items.map((i) => ({
      id: i.id,
      name: i.name,
      priceUsdc: microToUsdc(i.priceMicro),
      priceKrw: i.priceKrw,
      stock: i.stock,
      unit: i.unit,
      category: i.category,
    })),
  });
}
