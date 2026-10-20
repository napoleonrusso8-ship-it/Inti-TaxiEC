# syntax=docker/dockerfile:1.7
# Construcción reproducible + imagen final distroless sin shell, ejecutando como usuario sin privilegios.
FROM node:26.12.0-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/auth ./apps/auth
RUN pnpm install --frozen-lockfile --filter @intitaxi/auth... \
 && pnpm --filter @intitaxi/auth... build \
 && pnpm deploy --filter @intitaxi/auth --prod /out

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /out ./
USER nonroot
ENV NODE_ENV=production
EXPOSE 3001
CMD ["dist/main.js"]
