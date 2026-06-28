# syntax=docker/dockerfile:1.6
# InkForge 墨铸 —— 一体化镜像（前端构建 + 后端运行）
# 镜像同时承载 HTTP 服务与守护进程（INKFORGE_EMBED_WORKER=true）

# ============== 阶段 1：构建前端 ==============
FROM node:20-alpine AS builder

# better-sqlite3 等原生模块需要构建工具
RUN apk add --no-cache python3 make g++ libc6-compat

# 启用 pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# 拷贝源码
COPY tsconfig.json tailwind.config.js postcss.config.js vite.config.ts index.html ./
COPY src ./src
COPY api ./api
COPY shared ./shared
COPY public ./public

# 构建前端 → /app/dist
RUN pnpm build

# ============== 阶段 2：生产运行时 ==============
FROM node:20-alpine AS runtime

RUN apk add --no-cache libc6-compat tini
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# 仅装生产依赖
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile \
 && pnpm rebuild better-sqlite3

# 拷贝源代码（运行时通过 tsx 直接执行 TS）
COPY api ./api
COPY shared ./shared
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production \
    PORT=3001 \
    INKFORGE_EMBED_WORKER=true \
    INKFORGE_DATA_DIR=/data

# 数据卷挂载点
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3001

# tini 负责 PID 1 / 信号转发，让 SIGTERM 优雅关闭
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "api/server.ts"]
