FROM node:26-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

FROM node:26-alpine AS test
RUN apk add --no-cache git tar
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY eslint.config.js ./
COPY server ./server
COPY db ./db
COPY web ./web
COPY functions ./functions
CMD ["sh", "-c", "npm run lint && npm test && npm run test:integration"]

FROM node:26-alpine AS runtime
ARG BUILD_SHA=development
ENV NODE_ENV=production
ENV BUILD_SHA=${BUILD_SHA}
LABEL org.opencontainers.image.revision=${BUILD_SHA}
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node db ./db
COPY --chown=node:node web ./web
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/src/server.js"]
