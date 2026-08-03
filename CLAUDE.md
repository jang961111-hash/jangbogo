# 장보고 (JangBogo)

Google x Solana AI Agentic Hackathon 제출작 — 가맹점을 에이전트가 결제 가능한 헤드리스 상점으로 바꾸는 게이트웨이.

- 실행: `npm run dev` → http://localhost:3402 (첫 접속 시 자동 체인 셋업·시딩)
- 테스트: `npm test`(단위) / `npm run test:integration`(통합, 서버 필요)
- 체인: devnet + mock USDC 기본, faucet 고갈 시 sandbox 자동 폴백 (`src/lib/chain.ts`)
- 핵심 신뢰 경계: `src/lib/policy.ts` — 결정론 검증만, LLM 불개입 (설계 원칙, 변경 금지)
- 금액은 내부적으로 전부 정수 micro-USDC (`src/lib/fx.ts`)
- 문서: `docs/00`~`06` (기획 근거 → QA 리포트)
