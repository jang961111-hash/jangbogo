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
interface LogEvent {
  step: string; level: "info" | "success" | "error" | "warn"; message: string;
  data?: { explorerUrl?: string };
}

const usdc = (micro: number) =>
  (micro / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const krw = (n: number) => n.toLocaleString("ko-KR");

const LEVEL_STYLE: Record<LogEvent["level"], string> = {
  info: "text-slate-600",
  success: "text-emerald-700 font-medium",
  error: "text-rose-600 font-medium",
  warn: "text-amber-600",
};
const STEP_ICON: Record<string, string> = {
  setup: "⚙️", mandate_issued: "📜", discover: "🔍", quote: "💬", decide: "🧠",
  pay: "💸", x402: "🔁", blocked: "🛡️", receipt: "🧾", done: "🏁",
};

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
    // 컨테이너 내부만 스크롤 — scrollIntoView는 페이지 전체를 끌어내려 헤더가 밀림
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
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#3182f6] text-xl text-white shadow-sm">⛵</div>
          <div>
            <h1 className="text-xl font-bold">장보고 <span className="text-sm font-medium text-slate-500">Agent Commerce Gateway</span></h1>
            <p className="text-xs text-slate-500">가맹점을 5분 만에, AI 에이전트가 결제하는 헤드리스 상점으로</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {booting ? (
            <span className="rounded-full bg-slate-200 px-3 py-1.5 text-slate-600">체인 부트스트랩 중…</span>
          ) : (
            <>
              <span className={`rounded-full px-3 py-1.5 font-semibold ${state?.mode === "devnet" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                {state?.mode === "devnet" ? "● Solana Devnet" : "● Sandbox (폴백)"}
              </span>
              {state?.agentWallet && (
                <span className="rounded-full bg-white px-3 py-1.5 text-slate-700 shadow-sm">
                  🤖 에이전트 지갑 <b>{usdc(state.agentWallet.usdcMicro)} USDC</b>
                </span>
              )}
            </>
          )}
        </div>
      </header>

      {/* 탭 */}
      <nav className="mb-5 flex gap-1 rounded-2xl bg-white p-1 shadow-sm">
        {([
          ["agent", "🤖 에이전트 콘솔"],
          ["merchants", "🏪 가맹점"],
          ["ledger", "🧾 주문·정산"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${tab === key ? "bg-[#3182f6] text-white" : "text-slate-500 hover:bg-slate-50"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* ── 에이전트 콘솔 ── */}
      {tab === "agent" && (
        <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="mb-4 text-base font-bold">자율 조달 실행</h2>
            <label className="mb-1 block text-xs font-semibold text-slate-500">조달 목표</label>
            <input value={goal} onChange={(e) => setGoal(e.target.value)}
              className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-[#3182f6]" />
            <div className="mb-3 grid grid-cols-3 gap-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">카테고리</label>
                <input value={category} onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-[#3182f6]" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">수량</label>
                <input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-[#3182f6]" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-500">예산(USDC)</label>
                <input type="number" value={budget} onChange={(e) => setBudget(Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-[#3182f6]" />
              </div>
            </div>
            <button onClick={() => run("normal")} disabled={running || booting}
              className="mb-4 w-full rounded-xl bg-[#3182f6] py-3 text-sm font-bold text-white transition hover:bg-blue-600 disabled:opacity-40">
              {running ? "에이전트 실행 중…" : "▶ 에이전트 실행 (사람 승인 0회)"}
            </button>
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="mb-2 text-xs font-bold text-slate-600">🛡️ 네거티브 데모 — 판매자측 정책 엔진이 차단</p>
              <div className="grid gap-1.5">
                <button onClick={() => run("over_budget")} disabled={running || booting}
                  className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                  예산 초과 — 위임 예산 50 USDC로 65 USDC 주문 시도
                </button>
                <button onClick={() => run("expired")} disabled={running || booting}
                  className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                  만료 위임장 — 어제 만료된 mandate로 주문 시도
                </button>
                <button onClick={() => run("out_of_scope")} disabled={running || booting}
                  className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                  범위 밖 — &apos;포장재&apos; 한정 위임으로 식자재 구매 시도
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-2xl bg-[#0f1523] p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-bold text-white">실행 로그 <span className="text-xs font-normal text-slate-400">AP2 mandate → A2A 견적 → x402 결제</span></h2>
              {running && <span className="animate-pulse text-xs text-emerald-400">● LIVE</span>}
            </div>
            <div ref={logBox} className="h-[460px] overflow-y-auto rounded-xl bg-black/30 p-4 text-[13px] leading-6">
              {logs.length === 0 && (
                <p className="text-slate-500">에이전트를 실행하면 mandate 발급부터 온체인 결제·영수증까지 전 과정이 여기 스트리밍됩니다.</p>
              )}
              {logs.map((l, i) => (
                <div key={i} className="mb-1 flex gap-2">
                  <span>{STEP_ICON[l.step] ?? "·"}</span>
                  <div className={LEVEL_STYLE[l.level].replace("text-slate-600", "text-slate-300").replace("text-emerald-700", "text-emerald-400").replace("text-rose-600", "text-rose-400").replace("text-amber-600", "text-amber-300")}>
                    {l.message}
                    {l.data?.explorerUrl && l.data.explorerUrl.startsWith("http") && (
                      <>
                        {" "}
                        <a href={l.data.explorerUrl} target="_blank" rel="noreferrer"
                          className="underline decoration-dotted text-sky-400">Explorer에서 확인 ↗</a>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* ── 가맹점 ── */}
      {tab === "merchants" && (
        <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
          <section className="h-fit rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="mb-1 text-base font-bold">가맹점 온보딩</h2>
            <p className="mb-4 text-xs text-slate-500">상품을 등록하면 즉시 에이전트용 카탈로그·견적·x402 결제 엔드포인트가 발급됩니다.</p>
            <label className="mb-1 block text-xs font-semibold text-slate-500">상호명</label>
            <input value={mName} onChange={(e) => setMName(e.target.value)} placeholder="예) 을지로 베이커리"
              className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-[#3182f6]" />
            <label className="mb-1 block text-xs font-semibold text-slate-500">카테고리</label>
            <input value={mCategory} onChange={(e) => setMCategory(e.target.value)}
              className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-[#3182f6]" />
            <label className="mb-1 block text-xs font-semibold text-slate-500">상품 목록 <span className="font-normal">(줄당: 이름, 가격KRW, 재고, 단위)</span></label>
            <textarea value={mItems} onChange={(e) => setMItems(e.target.value)} rows={4}
              className="mono mb-3 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-xs outline-none focus:border-[#3182f6]" />
            <button onClick={onboard} disabled={!mName.trim()}
              className="w-full rounded-xl bg-[#191f28] py-3 text-sm font-bold text-white transition hover:bg-black disabled:opacity-40">
              + 헤드리스 상점 만들기
            </button>
            {onboardMsg && <p className="mt-3 text-xs">{onboardMsg}</p>}
          </section>

          <section className="grid h-fit gap-4">
            {state?.merchants.map((m) => (
              <div key={m.id} className="rounded-2xl bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h3 className="font-bold">{m.name} <span className="ml-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{m.category}</span></h3>
                    <p className="mono mt-0.5 text-[11px] text-slate-400">지갑 {m.walletPubB58.slice(0, 12)}…</p>
                  </div>
                  <div className="text-right text-[11px] text-slate-500">
                    <a className="mono block text-sky-600 hover:underline" href={`/api/m/${m.id}/catalog`} target="_blank">GET /api/m/{m.id.slice(0, 10)}…/catalog ↗</a>
                    <span className="mono">POST …/quote · POST …/buy (x402)</span>
                  </div>
                </div>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-xs text-slate-400">
                      <th className="py-1.5 font-medium">상품</th>
                      <th className="py-1.5 font-medium">가격</th>
                      <th className="py-1.5 font-medium">USDC</th>
                      <th className="py-1.5 text-right font-medium">재고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.items.map((i) => (
                      <tr key={i.id} className="border-b border-slate-50">
                        <td className="py-2">{i.name}</td>
                        <td className="py-2 text-slate-500">₩{krw(i.priceKrw)}</td>
                        <td className="mono py-2 text-slate-500">{usdc(i.priceMicro)}</td>
                        <td className="py-2 text-right text-slate-500">{i.stock}{i.unit}</td>
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
            {[
              ["총 거래액", `${usdc(totalGross)} USDC`],
              ["플랫폼 수수료 (0.5%)", `${usdc(totalGross - totalNet)} USDC`],
              ["가맹점 정산액", `${usdc(totalNet)} USDC ≈ ₩${krw(totalNetKrw)}`],
            ].map(([t, v]) => (
              <div key={t} className="rounded-2xl bg-white p-5 shadow-sm">
                <p className="text-xs font-semibold text-slate-500">{t}</p>
                <p className="mt-1 text-lg font-bold">{v}</p>
              </div>
            ))}
          </div>
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-base font-bold">주문 내역 <span className="text-xs font-normal text-slate-400">모든 주문은 온체인 트랜잭션과 1:1</span></h2>
            {(!state || state.orders.length === 0) && <p className="text-sm text-slate-400">아직 주문이 없습니다 — 에이전트를 실행해 보세요.</p>}
            {state?.orders.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-50 py-3 text-sm">
                <div>
                  <p className="font-semibold">{o.merchantName} — {o.items.map((i) => `${i.name} ×${i.qty}`).join(", ")}</p>
                  <p className="text-xs text-slate-400">{new Date(o.createdAt).toLocaleString("ko-KR")} · <span className="mono">{o.id}</span></p>
                </div>
                <div className="text-right">
                  <p className="font-bold">{usdc(o.totalMicro)} USDC</p>
                  {o.explorerUrl.startsWith("http") ? (
                    <a href={o.explorerUrl} target="_blank" rel="noreferrer" className="mono text-xs text-sky-600 hover:underline">
                      tx {o.txSig.slice(0, 16)}… ↗
                    </a>
                  ) : (
                    <span className="mono text-xs text-amber-600">sandbox tx {o.txSig.slice(0, 16)}…</span>
                  )}
                </div>
              </div>
            ))}
          </section>
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="mb-1 text-base font-bold">정산 원장</h2>
            <p className="mb-3 text-xs text-slate-400">원화 환산은 데모 고정 환율(1 USDC = 1,450 KRW) 기준 오프램프 시뮬레이션입니다.</p>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400">
                  <th className="py-1.5 font-medium">가맹점</th>
                  <th className="py-1.5 font-medium">거래액</th>
                  <th className="py-1.5 font-medium">수수료</th>
                  <th className="py-1.5 font-medium">정산 USDC</th>
                  <th className="py-1.5 text-right font-medium">정산 원화(시뮬)</th>
                </tr>
              </thead>
              <tbody>
                {state?.ledger.map((l) => (
                  <tr key={l.orderId} className="border-b border-slate-50">
                    <td className="py-2">{l.merchantName}</td>
                    <td className="mono py-2">{usdc(l.grossMicro)}</td>
                    <td className="mono py-2 text-slate-500">-{usdc(l.feeMicro)}</td>
                    <td className="mono py-2 font-semibold">{usdc(l.netMicro)}</td>
                    <td className="py-2 text-right font-semibold">₩{krw(l.netKrw)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      <footer className="mt-8 text-center text-[11px] text-slate-400">
        장보고 — AP2 mandate(판매자측 검증) · A2A 견적 · x402 · Solana Devnet mock USDC · 데모 빌드
      </footer>
    </div>
  );
}
