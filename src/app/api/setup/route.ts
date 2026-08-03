import { NextResponse } from "next/server";
import { ensureSetup } from "@/lib/chain";
import { seedMerchants } from "@/lib/seed";
import { publicMerchant } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST() {
  const setup = await ensureSetup();
  const merchants = seedMerchants();
  return NextResponse.json({ ...setup, merchants: merchants.map(publicMerchant) });
}
