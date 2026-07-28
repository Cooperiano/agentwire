# Isolated OpenClaw (龙虾) as a service.
# Single container — this is the ONLY thing that will be FRP-tunneled out later.
FROM node:24-bookworm

# System deps + jq + tini + Chromium (OpenClaw auto-detects any Chromium-based browser,
# so the seeded Zhihu login carries over). Chromium from Debian repos — reachable in CN
# builds, unlike dl.google.com. CJK fonts so Chinese (Zhihu) pages render correctly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates jq tini chromium \
        fonts-liberation fonts-noto-cjk fontconfig \
    && rm -rf /var/lib/apt/lists/*

# OpenClaw gateway — pinned to the same version as the working host install.
RUN npm install -g openclaw@2026.6.10

ENV HOME=/root
WORKDIR /root

# Dispatcher — the scoped HTTP API layer (the only port FRP should expose)
COPY dispatcher/ /app/dispatcher/

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 18789
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
