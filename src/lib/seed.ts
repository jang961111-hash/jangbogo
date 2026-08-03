import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadDB, saveDB, newId, type Merchant, type Item } from "./store";
import { krwToMicro } from "./fx";

function item(name: string, priceKrw: number, stock: number, unit: string, category: string): Item {
  return { id: newId("itm"), name, priceKrw, priceMicro: krwToMicro(priceKrw), stock, unit, category };
}

const SEED: { name: string; category: string; items: [string, number, number, string, string][] }[] = [
  {
    name: "성수 로스터리",
    category: "식자재",
    items: [
      ["블렌드 원두 1kg", 19000, 120, "kg", "식자재"],
      ["에티오피아 예가체프 원두 1kg", 28000, 40, "kg", "식자재"],
      ["콜롬비아 수프리모 원두 1kg", 24000, 60, "kg", "식자재"],
    ],
  },
  {
    name: "강릉 커피팜",
    category: "식자재",
    items: [
      ["블렌드 원두 1kg", 21500, 200, "kg", "식자재"],
      ["디카페인 블렌드 원두 1kg", 26000, 80, "kg", "식자재"],
    ],
  },
  {
    name: "제주 화산커피",
    category: "식자재",
    items: [
      ["블렌드 원두 1kg", 20500, 90, "kg", "식자재"],
      ["케냐 AA 원두 1kg", 29000, 30, "kg", "식자재"],
    ],
  },
  {
    name: "한강 패키징",
    category: "포장재",
    items: [
      ["테이크아웃 종이컵 1000개", 38000, 50, "box", "포장재"],
      ["컵홀더 1000개", 22000, 70, "box", "포장재"],
    ],
  },
];

/** 데모 가맹점 시딩 (멱등) */
export function seedMerchants(): Merchant[] {
  const db = loadDB();
  if (db.merchants.length > 0) return db.merchants;
  for (const s of SEED) {
    const kp = Keypair.generate();
    db.merchants.push({
      id: newId("mch"),
      name: s.name,
      category: s.category,
      walletPubB58: kp.publicKey.toBase58(),
      walletSecretB58: bs58.encode(kp.secretKey),
      items: s.items.map((args) => item(...args)),
      createdAt: Date.now(),
    });
  }
  saveDB(db);
  return db.merchants;
}
