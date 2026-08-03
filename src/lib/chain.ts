import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getAccount,
  mintTo,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import { loadDB, saveDB, newId, type DB, type KeyRec } from "./store";
import { MICRO } from "./fx";

// 체인 어댑터 — devnet(기본, 운영진 권장 mock USDC 자체 발행) / sandbox(폴백, 동일 인터페이스)
// 개발·시연은 devnet, faucet 고갈 시 sandbox로 자동 전환하고 UI에 모드를 명시한다.

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_DECIMALS = 6;

let conn: Connection | null = null;
function connection(): Connection {
  if (!conn) conn = new Connection(RPC_URL, "confirmed");
  return conn;
}

function keypairFromRec(rec: KeyRec): Keypair {
  return Keypair.fromSecretKey(bs58.decode(rec.secretB58));
}

function newKeyRec(): KeyRec {
  const kp = Keypair.generate();
  return { pubB58: kp.publicKey.toBase58(), secretB58: bs58.encode(kp.secretKey) };
}

export interface SetupInfo {
  mode: "devnet" | "sandbox";
  mintB58: string;
  buyerPubB58: string;
  principalPubB58: string;
  buyerUsdcMicro: number;
  buyerSol?: number;
}

let setupLock: Promise<SetupInfo> | null = null;

export async function ensureSetup(): Promise<SetupInfo> {
  if (setupLock) return setupLock;
  setupLock = doSetup().finally(() => {
    setupLock = null;
  });
  return setupLock;
}

async function doSetup(): Promise<SetupInfo> {
  const db = loadDB();
  if (!db.payer) db.payer = newKeyRec();
  if (!db.principal) db.principal = newKeyRec();
  if (!db.buyer) db.buyer = newKeyRec();
  saveDB(db);

  // sandbox로 폴백된 상태라도 payer에 SOL이 채워지면(수동 faucet 등) devnet으로 자동 복귀
  if (db.mode === "sandbox") {
    try {
      const bal = await connection().getBalance(
        keypairFromRec(db.payer!).publicKey
      );
      if (bal < 0.01 * LAMPORTS_PER_SOL) return sandboxSetup(db);
    } catch {
      return sandboxSetup(db);
    }
  }
  try {
    return await devnetSetup(db);
  } catch (e) {
    console.warn("[chain] devnet 셋업 실패 → sandbox 폴백:", (e as Error).message);
    return sandboxSetup(db);
  }
}

async function devnetSetup(db: DB): Promise<SetupInfo> {
  const c = connection();
  const payer = keypairFromRec(db.payer!);
  const buyer = keypairFromRec(db.buyer!);

  let payerBal = await c.getBalance(payer.publicKey);
  if (payerBal < 0.05 * LAMPORTS_PER_SOL) {
    try {
      const sig = await c.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
      const bh = await c.getLatestBlockhash();
      await c.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    } catch (e) {
      console.warn("[chain] airdrop 실패:", (e as Error).message);
    }
    payerBal = await c.getBalance(payer.publicKey);
  }
  if (payerBal < 0.01 * LAMPORTS_PER_SOL)
    throw new Error(`payer SOL 부족 (${payerBal / LAMPORTS_PER_SOL} SOL) — faucet 한도`);

  // sandbox 폴백 시 저장된 placeholder는 실주소가 아니므로 devnet 복귀 시 재발행
  if (!db.mintB58 || db.mintB58.startsWith("SANDBOX")) {
    const mint = await createMint(c, payer, payer.publicKey, null, USDC_DECIMALS);
    db.mintB58 = mint.toBase58();
    saveDB(db);
  }
  const mint = new PublicKey(db.mintB58);

  const buyerAta = await getOrCreateAssociatedTokenAccount(c, payer, mint, buyer.publicKey);
  let buyerUsdc = Number(buyerAta.amount);
  if (buyerUsdc < 100 * MICRO) {
    await mintTo(c, payer, mint, buyerAta.address, payer, BigInt(1000 * MICRO));
    buyerUsdc += 1000 * MICRO;
  }

  let buyerSol = await c.getBalance(buyer.publicKey);
  if (buyerSol < 0.005 * LAMPORTS_PER_SOL) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: buyer.publicKey,
        lamports: 0.02 * LAMPORTS_PER_SOL,
      })
    );
    await sendAndConfirmTransaction(c, tx, [payer]);
    buyerSol = await c.getBalance(buyer.publicKey);
  }

  db.mode = "devnet";
  saveDB(db);
  return {
    mode: "devnet",
    mintB58: db.mintB58,
    buyerPubB58: db.buyer!.pubB58,
    principalPubB58: db.principal!.pubB58,
    buyerUsdcMicro: buyerUsdc,
    buyerSol: buyerSol / LAMPORTS_PER_SOL,
  };
}

function sandboxSetup(db: DB): SetupInfo {
  db.mode = "sandbox";
  if (!db.mintB58) db.mintB58 = "SANDBOXMockUSDC1111111111111111111111111111";
  const buyerPub = db.buyer!.pubB58;
  if (db.sandbox.balances[buyerPub] === undefined)
    db.sandbox.balances[buyerPub] = 1000 * MICRO;
  saveDB(db);
  return {
    mode: "sandbox",
    mintB58: db.mintB58,
    buyerPubB58: buyerPub,
    principalPubB58: db.principal!.pubB58,
    buyerUsdcMicro: db.sandbox.balances[buyerPub],
  };
}

/** 402 응답에 넣을 수취 주소(payTo). devnet은 머천트 ATA를 보장 생성. */
export async function ensurePayTo(merchantWalletB58: string): Promise<string> {
  const db = loadDB();
  if (db.mode === "sandbox") return merchantWalletB58;
  const c = connection();
  const payer = keypairFromRec(db.payer!);
  const mint = new PublicKey(db.mintB58!);
  const ata = await getOrCreateAssociatedTokenAccount(
    c,
    payer,
    mint,
    new PublicKey(merchantWalletB58)
  );
  return ata.address.toBase58();
}

export async function transferUsdc(params: {
  fromSecretB58: string;
  payToB58: string; // devnet: ATA 주소 / sandbox: owner 주소
  amountMicro: number;
  memo: string;
}): Promise<{ sig: string }> {
  const db = loadDB();
  if (db.mode === "sandbox") {
    const from = keypairFromRec({ pubB58: "", secretB58: params.fromSecretB58 });
    const fromPub = from.publicKey.toBase58();
    const bal = db.sandbox.balances[fromPub] ?? 0;
    if (bal < params.amountMicro) throw new Error("sandbox 잔액 부족");
    db.sandbox.balances[fromPub] = bal - params.amountMicro;
    db.sandbox.balances[params.payToB58] =
      (db.sandbox.balances[params.payToB58] ?? 0) + params.amountMicro;
    const sig = newId("SBXTX");
    db.sandbox.txs.push({
      sig,
      fromOwner: fromPub,
      toOwner: params.payToB58,
      amountMicro: params.amountMicro,
      memo: params.memo,
      ts: Date.now(),
    });
    saveDB(db);
    return { sig };
  }

  const c = connection();
  const from = Keypair.fromSecretKey(bs58.decode(params.fromSecretB58));
  const mint = new PublicKey(db.mintB58!);
  const fromAta = await getAssociatedTokenAddress(mint, from.publicKey);
  const tx = new Transaction().add(
    createTransferCheckedInstruction(
      fromAta,
      mint,
      new PublicKey(params.payToB58),
      from.publicKey,
      BigInt(params.amountMicro),
      USDC_DECIMALS
    ),
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(params.memo, "utf-8"),
    })
  );
  const sig = await sendAndConfirmTransaction(c, tx, [from], { commitment: "confirmed" });
  return { sig };
}

export type VerifyResult =
  | { ok: true; payerB58: string }
  | { ok: false; reason: string };

export async function verifyPayment(params: {
  sig: string;
  payToB58: string;
  amountMicro: number;
  memo: string;
}): Promise<VerifyResult> {
  const db = loadDB();
  if (db.mode === "sandbox") {
    const tx = db.sandbox.txs.find((t) => t.sig === params.sig);
    if (!tx) return { ok: false, reason: "트랜잭션 없음" };
    if (tx.toOwner !== params.payToB58) return { ok: false, reason: "수취인 불일치" };
    if (tx.amountMicro !== params.amountMicro)
      return { ok: false, reason: `금액 불일치 (지불 ${tx.amountMicro} ≠ 청구 ${params.amountMicro})` };
    if (tx.memo !== params.memo) return { ok: false, reason: "주문 nonce(memo) 불일치" };
    return { ok: true, payerB58: tx.fromOwner };
  }

  const c = connection();
  let parsed = null;
  for (let i = 0; i < 5 && !parsed; i++) {
    parsed = await c.getParsedTransaction(params.sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!parsed) await new Promise((r) => setTimeout(r, 1200));
  }
  if (!parsed) return { ok: false, reason: "트랜잭션 조회 실패" };
  if (parsed.meta?.err) return { ok: false, reason: "트랜잭션 실패 상태" };

  let payerB58: string | null = null;
  let amountOk = false;
  let memoOk = false;
  for (const ix of parsed.transaction.message.instructions) {
    if ("parsed" in ix) {
      if (ix.program === "spl-token" && ix.parsed?.type === "transferChecked") {
        const info = ix.parsed.info;
        if (
          info.destination === params.payToB58 &&
          info.mint === db.mintB58 &&
          info.tokenAmount?.amount === String(params.amountMicro)
        ) {
          amountOk = true;
          payerB58 = info.authority;
        } else if (info.destination === params.payToB58) {
          return {
            ok: false,
            reason: `금액 불일치 (지불 ${info.tokenAmount?.amount} ≠ 청구 ${params.amountMicro})`,
          };
        }
      }
      if (ix.program === "spl-memo" && ix.parsed === params.memo) memoOk = true;
    }
  }
  if (!amountOk) return { ok: false, reason: "수취인/금액이 일치하는 전송 없음" };
  if (!memoOk) return { ok: false, reason: "주문 nonce(memo) 불일치" };
  return { ok: true, payerB58: payerB58! };
}

export function explorerUrl(sig: string): string {
  const db = loadDB();
  if (db.mode === "sandbox") return `sandbox://${sig}`;
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export async function getUsdcBalance(ownerB58: string): Promise<number> {
  const db = loadDB();
  if (db.mode === "sandbox") return db.sandbox.balances[ownerB58] ?? 0;
  try {
    const c = connection();
    const mint = new PublicKey(db.mintB58!);
    const ata = await getAssociatedTokenAddress(mint, new PublicKey(ownerB58));
    const acc = await getAccount(c, ata);
    return Number(acc.amount);
  } catch {
    return 0;
  }
}
