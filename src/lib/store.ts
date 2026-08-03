import fs from "fs";
import path from "path";

export interface Item {
  id: string;
  name: string;
  priceKrw: number;
  priceMicro: number; // micro-USDC
  stock: number;
  unit: string;
  category: string;
}

export interface Merchant {
  id: string;
  name: string;
  category: string;
  walletPubB58: string;
  walletSecretB58: string; // 데모 전용 — API 응답 전 strip
  ataB58?: string;
  items: Item[];
  createdAt: number;
}

export interface Order {
  id: string;
  merchantId: string;
  merchantName: string;
  items: { itemId: string; name: string; qty: number; unitMicro: number }[];
  totalMicro: number;
  txSig: string;
  explorerUrl: string;
  agentPubB58: string;
  intentHash: string;
  createdAt: number;
}

export interface LedgerEntry {
  orderId: string;
  merchantId: string;
  merchantName: string;
  grossMicro: number;
  feeMicro: number;
  netMicro: number;
  netKrw: number;
  settledAt: number; // 시뮬레이션 정산 예정 시각
}

export interface PendingOrder {
  nonce: string;
  payToB58: string;
  merchantId: string;
  items: { itemId: string; qty: number }[];
  totalMicro: number;
  intentHash: string;
  agentPubB58: string;
  createdAt: number;
  expiresAt: number;
}

export interface KeyRec {
  pubB58: string;
  secretB58: string;
}

export interface SandboxTx {
  sig: string;
  fromOwner: string;
  toOwner: string;
  amountMicro: number;
  memo: string;
  ts: number;
}

export interface DB {
  mode: "devnet" | "sandbox" | null;
  mintB58?: string;
  payer?: KeyRec;
  principal?: KeyRec;
  buyer?: KeyRec;
  merchants: Merchant[];
  orders: Order[];
  ledger: LedgerEntry[];
  mandateSpend: Record<string, number>; // intentHash → 누적 micro
  usedSigs: string[];
  pendingOrders: PendingOrder[];
  sandbox: { balances: Record<string, number>; txs: SandboxTx[] };
}

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const EMPTY: DB = {
  mode: null,
  merchants: [],
  orders: [],
  ledger: [],
  mandateSpend: {},
  usedSigs: [],
  pendingOrders: [],
  sandbox: { balances: {}, txs: [] },
};

export function loadDB(): DB {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    return { ...structuredClone(EMPTY), ...JSON.parse(raw) };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveDB(db: DB): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export function mutateDB<T>(fn: (db: DB) => T): T {
  const db = loadDB();
  const out = fn(db);
  saveDB(db);
  return out;
}

export function publicMerchant(m: Merchant) {
  const { walletSecretB58: _secret, ...pub } = m;
  return pub;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
