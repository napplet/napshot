FROM denoland/deno:bin-2.9.6 AS deno
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 napshot \
    && useradd --uid 1000 --gid napshot --create-home napshot
COPY --from=deno /deno /usr/local/bin/deno
ENV DENO_DIR=/opt/deno-cache \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NAPSHOT_HOST=0.0.0.0 \
    NAPSHOT_PORT=3080 \
    NAPSHOT_DATA_DIR=/app/data \
    NAPSHOT_CHROMIUM=/usr/bin/chromium
WORKDIR /app
COPY deno.json deno.lock ./
RUN deno install --frozen
COPY src ./src
COPY public ./public
COPY skills ./skills
COPY deploy/container-entrypoint.sh /usr/local/bin/napshot
RUN deno cache --frozen src/main.ts \
    && mkdir -p /app/data \
    && chown napshot:napshot /app/data \
    && chmod 755 /usr/local/bin/napshot
USER napshot
EXPOSE 3080
ENTRYPOINT ["/usr/local/bin/napshot"]
