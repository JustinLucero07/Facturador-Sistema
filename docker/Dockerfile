# Imagen única multi-etapa para Vektra POS.
#   --target node  → api / worker / hub-api / migraciones (APP=api|worker|hub-api)
#   --target web   → frontend de la instancia (nginx)
#   --target hub-web → panel del Vektra Hub (nginx)

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NX_DAEMON=false NX_NO_CLOUD=true
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY tools/prisma-generate.mjs tools/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN node tools/prisma-generate.mjs
RUN pnpm nx run-many -t build -p api worker hub-api web hub-web --configuration=production

# ─── Apps Node ───
FROM node:22-alpine AS node
ENV NODE_ENV=production TZ=America/Guayaquil
RUN apk add --no-cache tzdata
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/apps ./dist/apps
# Migraciones y seeds (servicio `migrate`)
COPY --from=build /app/libs ./libs
COPY --from=build /app/tsconfig.base.json ./
USER node
ARG APP=api
ENV APP=${APP}
CMD ["sh", "-c", "node dist/apps/${APP}/main.js"]

# ─── Frontends ───
FROM nginx:1.27-alpine AS web
COPY docker/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/apps/web/browser /usr/share/nginx/html

FROM nginx:1.27-alpine AS hub-web
COPY docker/nginx/hub-web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/apps/hub-web/browser /usr/share/nginx/html
