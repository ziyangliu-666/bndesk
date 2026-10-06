# web build
FROM node:24-slim AS web
WORKDIR /web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# server build
FROM rust:1-slim-bookworm AS server
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && echo '' > src/lib.rs && cargo build --release && rm -rf src
COPY server/ ./
COPY DESIGN.md /DESIGN.md
RUN touch src/main.rs src/lib.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 && rm -rf /var/lib/apt/lists/*
COPY --from=server /src/target/release/desk /usr/local/bin/desk
COPY --from=web /web/dist /app/web/dist
ENV DESK_WEB_DIST=/app/web/dist
# The config holds account emails and markets: it comes from the DESK_CONFIG secret, never the image.
CMD ["sh", "-c", "printf '%s' \"$DESK_CONFIG\" > /tmp/desk.toml && exec /usr/local/bin/desk --config /tmp/desk.toml --listen 0.0.0.0:8080"]
