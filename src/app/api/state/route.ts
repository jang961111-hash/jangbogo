import { NextResponse } from "next/server";
import { loadDB, publicMerchant } from "@/lib/store";
import { getUsdcBalance } from "@/lib/chain";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = loadDB();
  const buyerPub = db.buyer?.pubB58 ?? null;
  const buyerUsdcMicro = buyerPub && db.mode ? await getUsdcBalance(buyerPub) : 0;
  return NextResponse.json({
    mode: db.mode,
    mintB58: db.mintB58 ?? null,
    agentWallet: buyerPub ? { pubB58: buyerPub, usdcMicro: buyerUsdcMicro } : null,
    principalPubB58: db.principal?.pubB58 ?? null,
    merchants: db.merchants.map(publicMerchant),
    orders: [...db.orders].sort((a, b) => b.createdAt - a.createdAt),
    ledger: [...db.ledger].sort((a, b) => b.settledAt - a.settledAt),
    mandateSpend: db.mandateSpend,
  });
}
