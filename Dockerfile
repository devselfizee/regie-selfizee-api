FROM node:22-alpine AS builder

WORKDIR /app

ENV NODE_ENV=development

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --include=dev

COPY tsconfig*.json ./
COPY src ./src

RUN npx prisma generate
RUN npm run build

# ─── Production image ──────────────────────────────────────

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist
# Schémas JSON d'ingestion (lus au démarrage)
COPY schemas ./schemas

EXPOSE 3003

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
