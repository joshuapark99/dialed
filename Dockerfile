# syntax=docker/dockerfile:1.7
FROM node:22.23.2-alpine3.24 AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /app

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM dependencies AS web-build
ARG API_INTERNAL_URL=http://api:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL
COPY . .
RUN pnpm turbo run build --filter=@dialed/web

FROM dependencies AS api-build
COPY . .
RUN pnpm turbo run build --filter=@dialed/api

FROM api-build AS api-pruned
RUN pnpm --filter @dialed/api --prod --no-optional deploy /prod/api

FROM node:22.23.2-alpine3.24 AS web
ARG VCS_REF=development
ENV NODE_ENV=production
ENV APP_REVISION=$VCS_REF
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/joshuapark99/dialed" \
  org.opencontainers.image.revision=$VCS_REF
COPY --chown=node:node --from=web-build /app/apps/web/.next/standalone ./
COPY --chown=node:node --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node --from=web-build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

FROM node:22.23.2-alpine3.24 AS api
ARG VCS_REF=development
ENV NODE_ENV=production
ENV APP_REVISION=$VCS_REF
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/joshuapark99/dialed" \
  org.opencontainers.image.revision=$VCS_REF
COPY --chown=node:node --from=api-pruned /prod/api ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
