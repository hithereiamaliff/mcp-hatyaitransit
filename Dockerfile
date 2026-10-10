# Hat Yai Transit MCP Server - Streamable HTTP
# For self-hosting on the VPS behind nginx (https://mcp.techmavie.digital/hatyaitransit/mcp)
#
# Two stages: the first compiles the TypeScript, the second keeps only the compiled
# JavaScript and the production dependencies, so the final image stays small.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# ── Stage 2: run ─────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    HYT_API_URL=https://hatyaitransit.techmavie.digital

# Production dependencies only (no TypeScript, no test tools)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Don't run as root inside the container
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/http-server.js"]
