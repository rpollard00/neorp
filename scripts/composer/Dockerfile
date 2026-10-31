FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS build
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY scripts/composer/ scripts/composer/
COPY src/site.ts src/site.ts
COPY src/lib/post-plain.ts src/lib/post-plain.ts
RUN bun scripts/composer/shell/build.ts

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates coreutils git openssh-client tar util-linux \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=goacme/lego:v5.5.2@sha256:1944e8c36055beec47c7de6f15202b41128be75eea0ffa257f0c14d93c5155fd /lego /usr/local/bin/lego
RUN printf '%s\n' \
    '7ce7d6b654eddeec20afddf2396317fba6dc19ab52788a27e894e1806bf8f24b  /usr/local/bin/bun' \
    'c7ccc528bb254bec3e8ca998a8994dab9653c3e1aa083fd3bfaaa0b75b527b62  /usr/local/bin/lego' \
    | sha256sum --check --strict -
# A passwd entry for uid 1001 lets tools in a build read their user name.
RUN useradd --uid 1001 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin composer-build

# The keys that GitHub publishes in "GitHub's SSH key fingerprints":
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
# SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU (Ed25519)
# SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM (ECDSA)
# SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s (RSA)
COPY <<KEYS /etc/ssh/ssh_known_hosts
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
KEYS

WORKDIR /app
COPY --from=build /build/scripts/composer/server/ scripts/composer/server/
COPY --from=build /build/scripts/composer/protocol.ts /build/scripts/composer/text.ts scripts/composer/
COPY --from=build /build/scripts/composer/shell/dist/ scripts/composer/shell/dist/
COPY --from=build /build/src/site.ts src/site.ts
COPY --from=build /build/src/lib/post-plain.ts src/lib/post-plain.ts

# With no writable home, bun must not try to keep a transpiler cache.
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    COMPOSER_DATA=/data \
    COMPOSER_SHELL_DIR=/app/scripts/composer/shell/dist \
    COMPOSER_APP_PORT=443 \
    COMPOSER_PROOF_PORT=8444 \
    COMPOSER_SANDBOX_UID=1001 \
    COMPOSER_KNOWN_HOSTS_FILE=/etc/ssh/ssh_known_hosts

# The process stays uid 0: it holds the secrets, and setpriv needs SETUID and SETGID to start a build as uid 1001.
EXPOSE 443 8444
STOPSIGNAL SIGTERM
# The check skips the name check, because it connects to 127.0.0.1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --start-interval=5s --retries=3 CMD ["bun", "--no-install", "-e", "const app = new URL(process.env.COMPOSER_APP_ORIGIN); const answer = await fetch(`${app.protocol}//127.0.0.1:${process.env.COMPOSER_APP_PORT}/`, { headers: { host: app.host }, tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(4000) }); process.exit(answer.status === 200 ? 0 : 1);"]
ENTRYPOINT ["bun", "--no-install", "scripts/composer/server/main.ts"]
