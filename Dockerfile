# syntax=docker/dockerfile:1.7

# --- Build stage ---------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Vite inlines VITE_* variables at build time, so they must be present here.
ARG VITE_KLIPY_API_KEY=""
ENV VITE_KLIPY_API_KEY=$VITE_KLIPY_API_KEY
ARG VITE_DEFAULT_HOMESERVER=""
ENV VITE_DEFAULT_HOMESERVER=$VITE_DEFAULT_HOMESERVER
ARG VITE_LOCK_HOMESERVER=""
ENV VITE_LOCK_HOMESERVER=$VITE_LOCK_HOMESERVER

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src

RUN npm run build

# --- Runtime stage -------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
