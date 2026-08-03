import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { mutateDB, newId, publicMerchant, type Item } from "@/lib/store";
import { krwToMicro } from "@/lib/fx";

export const dynamic = "force-dynamic";

export async function GET() {
  const merchants = mutateDB((db) => db.merchants.map(publicMerchant));
  return NextResponse.json({ merchants });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, category, items } = body ?? {};
  if (!name || !category || !Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: { code: "INVALID_INPUT", message: "name, category, items가 필요합니다" } },
      { status: 400 }
    );
  }
  const kp = Keypair.generate();
  const merchant = mutateDB((db) => {
    const m = {
      id: newId("mch"),
      name: String(name),
      category: String(category),
      walletPubB58: kp.publicKey.toBase58(),
      walletSecretB58: bs58.encode(kp.secretKey),
      items: items.map(
        (i: { name: string; priceKrw: number; stock: number; unit?: string; category?: string }): Item => ({
          id: newId("itm"),
          name: String(i.name),
          priceKrw: Number(i.priceKrw),
          priceMicro: krwToMicro(Number(i.priceKrw)),
          stock: Number(i.stock),
          unit: i.unit ? String(i.unit) : "ea",
          category: i.category ? String(i.category) : String(category),
        })
      ),
      createdAt: Date.now(),
    };
    db.merchants.push(m);
    return m;
  });
  return NextResponse.json({ merchant: publicMerchant(merchant) }, { status: 201 });
}
