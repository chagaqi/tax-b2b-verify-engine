# The gateway is a single self-contained file; no node_modules needed at runtime.
FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY packages/gateway/dist/server.mjs ./server.mjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "server.mjs"]
