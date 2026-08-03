"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ── 타입 (API 응답 축약형) ── */
interface Item {
  id: string; name: string; priceKrw: number; priceMicro: number;
  stock: number; unit: string; category: string;
}
interface Merchant {
  id: string; name: string; category: string; walletPubB58: string; items: Item[];
}
interface Order {
  id: string; merchantName: string; totalMicro: number; txSig: string;
  explorerUrl: string; createdAt: number;
  items: { name: string; qty: number }[];
}
interface Ledger {
  orderId: string; merchantName: string; grossMicro: number; feeMicro: number;
  netMicro: number; netKrw: number; settledAt: number;
}
interface AppState {
  mode: "devnet" | "sandbox" | null;
  mintB58: string | null;
  agentWallet: { pubB58: string; usdcMicro: number } | null;
  merchants: Merchant[]; orders: Order[]; ledger: Ledger[];
}
interface VerifyStep { label: string; detail?: string }
interface LogEvent {
  step: string; level: "info" | "success" | "error" | "warn"; message: string;
  data?: {
    explorerUrl?: string;
    verification?: VerifyStep[];
    error?: { code?: string; message?: string; detail?: string };
  };
}

const usdc = (micro: number) =>
  (micro / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const krw = (n: number) => n.toLocaleString("ko-KR");

const LEVEL_STYLE: Record<LogEvent["level"], string> = {
  info: "text-slate-300",
  success: "text-[#14f195] font-medium",
  error: "text-rose-400 font-medium",
  warn: "text-amber-300",
};
const STEP_ICON: Record<string, string> = {
  setup: "⚙️", mandate_issued: "📜", discover: "🔍", quote: "💬", decide: "🧠",
  pay: "💸", x402: "🔁", blocked: "🛡️", receipt: "🧾", done: "🏁",
};

/* 검증 6단계 — 실패 코드 → 단계 인덱스 매핑 */
const VERIFY_LABELS = [
  "위임장·카트 서명 검증 (ed25519)",
  "위임 유효기간",
  "위임 범위(카테고리)",
  "카트 정합성 (단가·재고)",
  "예산 한도 집행",
  "온체인 지불 검증",
];
function failIdxOf(code?: string): number {
  if (!code) return -1;
  if (code.startsWith("MANDATE_INTENT_SIG") || code.startsWith("MANDATE_CART_SIG") || code === "MANDATE_HASH_MISMATCH") return 0;
  if (code === "MANDATE_EXPIRED") return 1;
  if (code === "MANDATE_SCOPE_VIOLATION") return 2;
  if (code.startsWith("CART_")) return 3;
  if (code === "MANDATE_BUDGET_EXCEEDED") return 4;
  if (code.startsWith("PAYMENT_")) return 5;
  return -1;
}

function VerifyCard(props: { steps?: VerifyStep[]; failIdx?: number; failDetail?: string }) {
  const { steps, failIdx = -1, failDetail } = props;
  const rows: VerifyStep[] = steps ?? VERIFY_LABELS.map((label) => ({ label }));
  return (
    <div className="my-2 ml-7 rounded-xl border border-white/10 bg-[#0a0f1e] p-3">
      <p className="mb-2 text-[11px] font-bold tracking-wide text-slate-400">
        🛡️ 판매자측 결정론 검증 — {failIdx < 0 ? "6단계 전체 통과" : `${failIdx + 1}단계에서 차단`}
      </p>
      {rows.map((s, i) => {
        const state = failIdx < 0 ? "ok" : i < failIdx ? "ok" : i === failIdx ? "fail" : "skip";
        return (
          <div key={i} className="step-row flex items-start gap-2 py-0.5" style={{ animationDelay: `${i * 0.12}s` }}>
            <span className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
              state === "ok" ? "bg-[#14f195]/20 text-[#14f195]" :
              state === "fail" ? "bg-rose-500/25 text-rose-400" : "bg-white/5 text-slate-600"}`}>
              {state === "ok" ? "✓" : state === "fail" ? "✕" : "·"}
            </span>
            <div className="min-w-0">
              <span className={`text-[12px] ${state === "fail" ? "text-rose-400 font-semibold" : state === "skip" ? "text-slate-600" : "text-slate-300"}`}>
                {s.label}
              </span>
              {state === "ok" && s.detail && (
                <span className="ml-2 text-[11px] text-slate-500">{s.detail}</span>
              )}
              {state === "fail" && failDetail && (
                <span className="ml-2 text-[11px] text-rose-400/80">{failDetail}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Home() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<"merchants" | "agent" | "ledger">("agent");
  const [booting, setBooting] = useState(true);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const logBox = useRef<HTMLDivElement>(null);

  const [goal, setGoal] = useState("카페 블렌드 원두 5kg 조달");
  const [category, setCategory] = useState("식자재");
  const [qty, setQty] = useState(5);
  const [budget, setBudget] = useState(100);

  const [mName, setMName] = useState("");
  const [mCategory, setMCategory] = useState("식자재");
  const [mItems, setMItems] = useState("과테말라 안티구아 원두 1kg, 27000, 50, kg");
  const [onboardMsg, setOnboardMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/state");
    setState(await res.json());
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await fetch("/api/setup", { method: "POST" });
      } finally {
        await refresh();
        setBooting(false);
      }
    })();
  }, [refresh]);

  useEffect(() => {
    const el = logBox.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  async function run(scenario: string) {
    if (running) return;
    setRunning(true);
    setLogs([]);
    setTab("agent");
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, category, qty, budgetUsdc: budget, scenario }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const c of chunks) {
          const line = c.split("\n").find((l) => l.startsWith("data: "));
          if (line) setLogs((prev) => [...prev, JSON.parse(line.slice(6))]);
        }
      }
    } catch (e) {
      setLogs((p) => [...p, { step: "done", level: "error", message: `스트림 오류: ${e}` }]);
    } finally {
      setRunning(false);
      refresh();
    }
  }

  async function onboard() {
    setOnboardMsg(null);
    const items = mItems
      .split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => {
        const [name, priceKrw, stock, unit] = l.split(",").map((s) => s.trim());
        return { name, priceKrw: Number(priceKrw), stock: Number(stock), unit: unit || "ea" };
      });
    const res = await fetch("/api/merchants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: mName, category: mCategory, items }),
    });
    if (res.status === 201) {
      const { merchant } = await res.json();
      setOnboardMsg(`✅ '${merchant.name}' 온보딩 완료 — 에이전트 상점 엔드포인트가 발급되었습니다.`);
      setMName("");
      refresh();
    } else {
      const err = await res.json();
      setOnboardMsg(`❌ ${err?.error?.message ?? "실패"}`);
    }
  }

  const totalGross = state?.ledger.reduce((s, l) => s + l.grossMicro, 0) ?? 0;
  const totalNet = state?.ledger.reduce((s, l) => s + l.netMicro, 0) ?? 0;
  const totalNetKrw = state?.ledger.reduce((s, l) => s + l.netKrw, 0) ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      {/* 헤더 */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#9945ff] to-[#6d28d9] text-xl shadow-[0_4px_20px_rgba(153,69,255,.4)]">⛵</div>
          <div>
            <h1 className="text-xl font-bold">
              <span className="grad-text">장보고</span>{" "}
              <span className="text-sm font-medium text-slate-400">Agent Commerce Gateway</span>
            </h1>
            <p className="text-xs text-slate-500">가맹점을 5분 만에, AI 에이전트가 결제하는 헤드리스 상점으로</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {booting ? (
            <span className="card px-3 py-1.5 text-slate-400">체인 부트스트랩 중…</span>
          ) : (
            <>
              <span className={`rounded-full px-3 py-1.5 font-semibold ${state?.mode === "devnet"
                ? "bg-[#14f195]/10 text-[#14f195] shadow-[0_0_16px_rgba(20,241,149,.25)]"
                : "bg-amber-400/10 text-amber-300"}`}>
                {state?.mode === "devnet" ? "● Solana Devnet" : "● Sandbox (폴백)"}
              </span>
              {state?.agentWallet && (
                <span className="card px-3 py-1.5 text-slate-300">
                  🤖 에이전트 지갑 <b className="text-white">{usdc(state.agentWallet.usdcMicro)} USDC</b>
                </span>
              )}
            </>
          )}
        </div>
      </header>

      {/* 탭 */}
      <nav className="card mb-5 flex gap-1 p-1">
        {([
          ["agent", "🤖 에이전트 콘솔"],
          ["merchants", "🏪 가맹점"],
          ["ledger", "🧾 주문·정산"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
              tab === key
                ? "bg-gradient-to-r from-[#9945ff] to-[#6d28d9] text-white shadow-[0_2px_16px_rgba(153,69,255,.35)]"
                : "text-slate-400 hover:bg-white/5"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* ── 에이전트 콘솔 ── */}
      {tab === "agent" && (
        <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
          <section className="card h-fit p-5">
            <h2 className="mb-4 text-base font-bold text-white">자율 조달 실행</h2>
            <label className="mb-1 block text-xs font-semibold text-slate-400">조달 목표</label>
            <input value={goal} onChange={(e) => setGoal(e.target.value)}
              className="input-dark mb-3 w-full rounded-xl px-3 py-2.5 text-sm" />
            <div className="mb-3 grid grid-cols-3 gap-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-400">카테고리</label>
                <input value={category} onChange={(e) => setCategory(e.target.value)}
                  className="input-dark w-full rounded-xl px-3 py-2.5 text-sm" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-400">수량</label>
                <input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))}
                  className="input-dark w-full rounded-xl px-3 py-2.5 text-sm" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-400">예산(USDC)</label>
                <input type="number" value={budget} onChange={(e) => setBudget(Number(e.target.value))}
                  className="input-dark w-full rounded-xl px-3 py-2.5 text-sm" />
              </div>
            </div>
            <button onClick={() => run("normal")} disabled={running || booting}
              className="btn-primary mb-4 w-full rounded-xl py-3 text-sm font-bold text-white disabled:opacity-40">
              {running ? "에이전트 실행 중…" : "▶ 에이전트 실행 (사람 승인 0회)"}
            </button>
            <div className="rounded-xl border border-white/5 bg-black/20 p-3">
              <p className="mb-2 text-xs font-bold text-slate-400">🛡️ 네거티브 데모 — 판매자측 정책 엔진이 차단</p>
              <div className="grid gap-1.5">
                {([
                  ["over_budget", "예산 초과 — 위임 예산 50 USDC로 65 USDC 주문 시도"],
                  ["expired", "만료 위임장 — 어제 만료된 mandate로 주문 시도"],
                  ["out_of_scope", "범위 밖 — '포장재' 한정 위임으로 식자재 구매 시도"],
                ] as const).map(([sc, label]) => (
                  <button key={sc} onClick={() => run(sc)} disabled={running || booting}
                    className="rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-left text-xs text-rose-300 transition hover:bg-rose-500/15 disabled:opacity-40">
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-bold text-white">
                실행 로그 <span className="text-xs font-normal text-slate-500">AP2 mandate → A2A 견적 → x402 결제</span>
              </h2>
              {running && <span className="animate-pulse text-xs text-[#14f195]">● LIVE</span>}
            </div>
            <div ref={logBox} className="h-[460px] overflow-y-auto rounded-xl border border-white/5 bg-black/40 p-4 text-[13px] leading-6">
              {logs.length === 0 && (
                <p className="text-slate-500">에이전트를 실행하면 mandate 발급부터 온체인 결제·영수증·검증 6단계까지 전 과정이 여기 스트리밍됩니다.</p>
              )}
              {logs.map((l, i) => (
                <div key={i}>
                  <div className="mb-1 flex gap-2">
                    <span>{STEP_ICON[l.step] ?? "·"}</span>
                    <div className={LEVEL_STYLE[l.level]}>
                      {l.message}
                      {l.data?.explorerUrl && l.data.explorerUrl.startsWith("http") && (
                        <>
                          {" "}
                          <a href={l.data.explorerUrl} target="_blank" rel="noreferrer"
                            className="text-[#9945ff] underline decoration-dotted hover:text-[#b06bff]">
                            Explorer에서 확인 ↗
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  {l.step === "receipt" && l.data?.verification && (
                    <VerifyCard steps={l.data.verification} />
                  )}
                  {l.step === "blocked" && l.data?.error?.code && (
                    <VerifyCard failIdx={failIdxOf(l.data.error.code)} failDetail={l.data.error.detail ?? l.data.error.message} />
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* ── 가맹점 ── */}
      {tab === "merchants" && (
        <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
          <section className="card h-fit p-5">
            <h2 className="mb-1 text-base font-bold text-white">가맹점 온보딩</h2>
            <p className="mb-4 text-xs text-slate-500">상품을 등록하면 즉시 에이전트용 카탈로그·견적·x402 결제 엔드포인트가 발급됩니다.</p>
            <label className="mb-1 block text-xs font-semibold text-slate-400">상호명</label>
            <input value={mName} onChange={(e) => setMName(e.target.value)} placeholder="예) 을지로 베이커리"
              className="input-dark mb-3 w-full rounded-xl px-3 py-2.5 text-sm" />
            <label className="mb-1 block text-xs font-semibold text-slate-400">카테고리</label>
            <input value={mCategory} onChange={(e) => setMCategory(e.target.value)}
              className="input-dark mb-3 w-full rounded-xl px-3 py-2.5 text-sm" />
            <label className="mb-1 block text-xs font-semibold text-slate-400">
              상품 목록 <span className="font-normal">(줄당: 이름, 가격KRW, 재고, 단위)</span>
            </label>
            <textarea value={mItems} onChange={(e) => setMItems(e.target.value)} rows={4}
              className="input-dark mono mb-3 w-full rounded-xl px-3 py-2.5 text-xs" />
            <button onClick={onboard} disabled={!mName.trim()}
              className="w-full rounded-xl bg-gradient-to-r from-[#14f195] to-[#0dc47a] py-3 text-sm font-bold text-[#05231a] transition hover:brightness-110 disabled:opacity-40">
              + 헤드리스 상점 만들기
            </button>
            {onboardMsg && <p className="mt-3 text-xs text-slate-300">{onboardMsg}</p>}
          </section>

          <section className="grid h-fit gap-4">
            {state?.merchants.map((m) => (
              <div key={m.id} className="card p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-white">
                      {m.name}{" "}
                      <span className="ml-1 rounded-md bg-white/5 px-2 py-0.5 text-xs font-medium text-slate-400">{m.category}</span>
                    </h3>
                    <p className="mono mt-0.5 text-[11px] text-slate-500">지갑 {m.walletPubB58.slice(0, 12)}…</p>
                  </div>
                  <div className="text-right text-[11px] text-slate-500">
                    <a className="mono block text-[#9945ff] hover:underline" href={`/api/m/${m.id}/catalog`} target="_blank">
                      GET /api/m/{m.id.slice(0, 10)}…/catalog ↗
                    </a>
                    <span className="mono">POST …/quote · POST …/buy (x402)</span>
                  </div>
                </div>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/5 text-xs text-slate-500">
                      <th className="py-1.5 font-medium">상품</th>
                      <th className="py-1.5 font-medium">가격</th>
                      <th className="py-1.5 font-medium">USDC</th>
                      <th className="py-1.5 text-right font-medium">재고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.items.map((i) => (
                      <tr key={i.id} className="border-b border-white/[.03]">
                        <td className="py-2 text-slate-200">{i.name}</td>
                        <td className="py-2 text-slate-400">₩{krw(i.priceKrw)}</td>
                        <td className="mono py-2 text-slate-400">{usdc(i.priceMicro)}</td>
                        <td className="py-2 text-right text-slate-400">{i.stock}{i.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        </div>
      )}

      {/* ── 주문·정산 ── */}
      {tab === "ledger" && (
        <div className="grid gap-5">
          <div className="grid grid-cols-3 gap-4">
            {([
              ["총 거래액", `${usdc(totalGross)} USDC`, false],
              ["플랫폼 수수료 (0.5%)", `${usdc(totalGross - totalNet)} USDC`, false],
              ["가맹점 정산액", `${usdc(totalNet)} USDC ≈ ₩${krw(totalNetKrw)}`, true],
            ] as [string, string, boolean][]).map(([t, v, hl]) => (
              <div key={t} className="card p-5">
                <p className="text-xs font-semibold text-slate-400">{t}</p>
                <p className={`mt-1 text-lg font-bold ${hl ? "text-[#14f195]" : "text-white"}`}>{v}</p>
              </div>
            ))}
          </div>
          <section className="card p-5">
            <h2 className="mb-3 text-base font-bold text-white">
              주문 내역 <span className="text-xs font-normal text-slate-500">모든 주문은 온체인 트랜잭션과 1:1</span>
            </h2>
            {(!state || state.orders.length === 0) && (
              <p className="text-sm text-slate-500">아직 주문이 없습니다 — 에이전트를 실행해 보세요.</p>
            )}
            {state?.orders.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 py-3 text-sm">
                <div>
                  <p className="font-semibold text-slate-200">
                    {o.merchantName} — {o.items.map((i) => `${i.name} ×${i.qty}`).join(", ")}
                  </p>
                  <p className="text-xs text-slate-500">
                    {new Date(o.createdAt).toLocaleString("ko-KR")} · <span className="mono">{o.id}</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-white">{usdc(o.totalMicro)} USDC</p>
                  {o.explorerUrl.startsWith("http") ? (
                    <a href={o.explorerUrl} target="_blank" rel="noreferrer"
                      className="mono text-xs text-[#9945ff] hover:underline">
                      tx {o.txSig.slice(0, 16)}… ↗
                    </a>
                  ) : (
                    <span className="mono text-xs text-amber-400/80">sandbox tx {o.txSig.slice(0, 16)}…</span>
                  )}
                </div>
              </div>
            ))}
          </section>
          <section className="card p-5">
            <h2 className="mb-1 text-base font-bold text-white">정산 원장</h2>
            <p className="mb-3 text-xs text-slate-500">원화 환산은 데모 고정 환율(1 USDC = 1,450 KRW) 기준 오프램프 시뮬레이션입니다.</p>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-white/5 text-xs text-slate-500">
                  <th className="py-1.5 font-medium">가맹점</th>
                  <th className="py-1.5 font-medium">거래액</th>
                  <th className="py-1.5 font-medium">수수료</th>
                  <th className="py-1.5 font-medium">정산 USDC</th>
                  <th className="py-1.5 text-right font-medium">정산 원화(시뮬)</th>
                </tr>
              </thead>
              <tbody>
                {state?.ledger.map((l) => (
                  <tr key={l.orderId} className="border-b border-white/[.03]">
                    <td className="py-2 text-slate-200">{l.merchantName}</td>
                    <td className="mono py-2 text-slate-300">{usdc(l.grossMicro)}</td>
                    <td className="mono py-2 text-slate-500">-{usdc(l.feeMicro)}</td>
                    <td className="mono py-2 font-semibold text-slate-200">{usdc(l.netMicro)}</td>
                    <td className="py-2 text-right font-semibold text-[#14f195]">₩{krw(l.netKrw)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      <footer className="mt-8 text-center text-[11px] text-slate-600">
        장보고 — AP2 mandate(판매자측 검증) · A2A 견적 · x402 · Solana Devnet mock USDC · 데모 빌드
      </footer>
    </div>
  );
}
