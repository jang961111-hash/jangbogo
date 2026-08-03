# Cloud Run 배포용 — next build --output standalone
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3402
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# 데모 상태(devnet 키·mint) 포함 — Cloud Run 인메모리 FS, 인스턴스 생명주기 동안 유지
COPY --from=builder /app/data ./data
EXPOSE 3402
CMD ["node", "server.js"]
