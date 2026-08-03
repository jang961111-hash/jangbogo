# 05. 배포 가이드

## A. 로컬 실행 (심사 재현 경로)

```bash
npm install
npm run dev        # http://localhost:3402
```

첫 접속 시 자동으로 `/api/setup`이 실행된다:
1. payer·principal·에이전트 지갑 키 생성 (`data/` — gitignore)
2. devnet airdrop 시도 → mock USDC mint 발행(운영진 공식 권장 방식) → 에이전트 지갑에 1,000 USDC 충전
3. faucet 한도(429) 시 **sandbox 모드로 자동 폴백** — 동일 코드 경로, UI에 모드 배지 명시

### devnet 전환 (faucet 한도에 걸린 경우)
- https://faucet.solana.com 에서 payer 주소로 devnet SOL 전송 (주소는 `data/db.json`의 `payer.pubB58`)
- 또는 해커톤 디스코드 `#솔라나-데브넷솔-요청` 채널에서 요청 (0.5~10 SOL)
- SOL 입금 후 페이지 새로고침 → setup이 잔액을 감지해 자동으로 devnet 전환

## B. 테스트

```bash
npm test                  # 단위 11 케이스
npm run test:integration  # 통합 20 케이스 (서버 기동 상태에서)
```

## C. Cloud Run 배포 (라이브 URL 가산점)

전제: gcloud CLI 로그인 + 프로젝트 설정.

```bash
gcloud run deploy jangbogo \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --port 3402 \
  --set-env-vars GEMINI_API_KEY=<선택>,SOLANA_RPC_URL=<선택>
```

- `Dockerfile` 포함 (standalone 빌드) — `--source .` 로 Cloud Build가 자동 사용
- Cloud Run 인스턴스 파일시스템은 휘발성: 데모 상태(`data/db.json`)는 인스턴스 생명주기 동안 유지된다.
  시연 전 `/api/setup` 한 번 호출로 워밍업할 것 (콜드스타트 시 재시딩됨)
- 프로덕션 전환 시: Firestore로 store.ts 교체 (인터페이스 분리되어 있음)

## D. 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GEMINI_API_KEY` | (없음) | 있으면 의사결정 사유를 Gemini가 생성, 없으면 결정론 폴백 |
| `GEMINI_MODEL` | gemini-2.5-flash | 사유 생성 모델 |
| `SOLANA_RPC_URL` | api.devnet.solana.com | RPC 교체(Helius 등) |
