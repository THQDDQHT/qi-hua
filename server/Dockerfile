FROM oven/bun:1.3.13 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.13
WORKDIR /app
ENV NODE_ENV=production PORT=3001
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY src ./src
COPY migrations ./migrations
USER bun
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:3001/health/ready');if(!r.ok)process.exit(1)"]
CMD ["bun", "src/index.ts"]
