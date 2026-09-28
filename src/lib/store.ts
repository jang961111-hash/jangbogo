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
  nonce?: string; // x402 결제 요청 nonce — 멱등 재시도 판별용 (이 필드 이전 주문엔 없음)
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

// 지불은 온체인에서 확인됐지만 주문을 확정하지 못한 건 (재고 소진·402 만료 등).
// 조용히 거절하면 돈만 이동한 흔적이 사라지므로 따로 기록한다. 환불은 수동 처리(자동화 범위 밖).
export interface UnconfirmedPayment {
  id: string;
  txSig: string;
  nonce: string;
  merchantId: string;
  intentHash: string;
  amountMicro: number;
  reason: string; // 확정 불가 사유 코드 (예: CART_STOCK_INSUFFICIENT, PAYMENT_EXPIRED)
  status: "paid_unconfirmed";
  recordedAt: number;
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
  unconfirmedPayments: UnconfirmedPayment[];
  sandbox: { balances: Record<string, number>; txs: SandboxTx[] };
}

// 테스트는 JANGBOGO_DATA_DIR로 임시 디렉터리를 가리켜 실제 data/db.json을 건드리지 않는다
function dataDir(): string {
  return process.env.JANGBOGO_DATA_DIR || path.join(process.cwd(), "data");
}

const EMPTY: DB = {
  mode: null,
  merchants: [],
  orders: [],
  ledger: [],
  mandateSpend: {},
  usedSigs: [],
  pendingOrders: [],
  unconfirmedPayments: [],
  sandbox: { balances: {}, txs: [] },
};

export function loadDB(): DB {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir(), "db.json"), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY); // 첫 기동
    throw e;
  }
  // 파싱 실패는 빈 DB로 대체하지 않는다(fail-closed) — 대체하면 usedSigs가 비어 리플레이 방어가 사라진다
  return { ...structuredClone(EMPTY), ...JSON.parse(raw) };
}

export function saveDB(db: DB): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  // 임시 파일에 다 쓴 뒤 rename으로 교체 — 쓰는 도중 죽어도 db.json은 이전 내용 그대로 남는다
  const target = path.join(dataDir(), "db.json");
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, target);
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
