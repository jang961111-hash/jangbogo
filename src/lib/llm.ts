// Gemini 래퍼 — 선택 사유·머천트 응대 문구 생성 전용.
// 결제 승인/한도 검증에는 절대 사용하지 않는다(결정론 정책 엔진이 담당).

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

// Cloud Run에서는 Vertex AI(서비스 계정 인증)를 우선 사용 — AI Studio 키의 무료 티어는
// 데이터센터 IP 호출에 적용되지 않아 429가 나기 때문 (QA에서 실측 확인)
const VERTEX_PROJECT = process.env.VERTEX_PROJECT;
const VERTEX_MODEL = process.env.VERTEX_MODEL || "gemini-3-flash-preview";

async function vertexText(prompt: string): Promise<string | null> {
  try {
    const tokRes = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) }
    );
    if (!tokRes.ok) return null;
    const { access_token } = await tokRes.json();
    const res = await fetch(
      `https://aiplatform.googleapis.com/v1beta1/projects/${VERTEX_PROJECT}/locations/global/publishers/google/models/${VERTEX_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) {
      console.warn("[llm] Vertex 응답 오류:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch (e) {
    console.warn("[llm] Vertex 호출 실패:", (e as Error).message);
    return null;
  }
}

export async function geminiText(prompt: string): Promise<string | null> {
  if (VERTEX_PROJECT) {
    const v = await vertexText(prompt);
    if (v) return v;
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) {
      console.warn("[llm] Gemini 응답 오류:", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch (e) {
    console.warn("[llm] Gemini 호출 실패:", (e as Error).message);
    return null;
  }
}

export async function decisionReason(context: {
  goal: string;
  chosen: { merchantName: string; itemName: string; unitUsdc: string; qty: number };
  rejected: { merchantName: string; itemName: string; unitUsdc: string }[];
}): Promise<{ text: string; source: "gemini" | "deterministic" }> {
  const prompt = `당신은 소상공인의 조달 에이전트입니다. 아래 견적 비교 결과에 대해 2문장 이내의 간결한 한국어 선택 사유를 쓰세요.
목표: ${context.goal}
선택: ${context.chosen.merchantName} — ${context.chosen.itemName} (개당 ${context.chosen.unitUsdc} USDC × ${context.chosen.qty})
탈락: ${context.rejected.map((r) => `${r.merchantName} ${r.itemName} ${r.unitUsdc} USDC`).join(" / ") || "없음"}`;
  const llm = await geminiText(prompt);
  if (llm) return { text: llm.trim(), source: "gemini" };
  const saved =
    context.rejected.length > 0
      ? ` 차순위 대비 개당 단가가 가장 낮아 총액 기준 최적입니다.`
      : "";
  return {
    text: `${context.chosen.merchantName}의 '${context.chosen.itemName}'이 단가 ${context.chosen.unitUsdc} USDC로 최저가입니다.${saved}`,
    source: "deterministic",
  };
}
