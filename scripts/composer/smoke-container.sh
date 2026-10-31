#!/usr/bin/env bash
# This script needs rootless Docker, where uid 0 in a container is the host user, so that it can read the
# temporary bare remote.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
tag=$$
image=composer-smoke-image:$tag
app=composer-smoke-app-$tag
site=composer-smoke-site-$tag
network=composer-smoke-net-$tag
helper=composer-smoke-helper-$tag
work=$(mktemp -d /tmp/composer-smoke.XXXXXX)
app_port=$((20000 + RANDOM % 20000))
proof_port=$((app_port + 1))
app_url=http://127.0.0.1:$app_port
built=0
in_flight=

pass() { printf 'ok    %s\n' "$*"; }
die() {
  printf 'FAIL  %s\n' "$*" >&2
  exit 1
}
equal() { [[ $2 == "$3" ]] || die "$1: expected '$3', got '$2'"; pass "$1"; }
refused() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then die "$name: the command must fail"; fi
  pass "$name"
}

cleanup() {
  local code=$?
  trap - EXIT
  set +e
  if ((code != 0)) && docker inspect "$app" >/dev/null 2>&1; then
    echo "The last log lines of the app:" >&2
    docker logs --tail 30 "$app" >&2
  fi
  [[ -z $in_flight ]] || kill "$in_flight" 2>/dev/null
  docker rm -f "$app" "$site" >/dev/null 2>&1
  # uid 1001 in a container owns some of these files, so a container must remove them.
  if ((built)); then
    docker run --rm --name "$helper" --entrypoint sh --mount "type=bind,source=$work,target=/work" "$image" \
      -c 'find /work -mindepth 1 -delete' >/dev/null 2>&1
    docker rmi "$image" >/dev/null 2>&1
  fi
  docker network rm "$network" >/dev/null 2>&1
  rm -rf "$work"
  printf 'The smoke test ran for %s seconds and exited with code %s.\n' "$SECONDS" "$code"
  exit "$code"
}
trap cleanup EXIT

[[ $(docker info --format '{{.SecurityOptions}}') == *rootless* ]] || die "This script needs rootless Docker."

docker build -q --platform linux/amd64 -f "$root/scripts/composer/Dockerfile" -t "$image" "$root" >/dev/null
built=1
image_bytes=$(docker image inspect "$image" --format '{{.Size}}')
pass "the image builds: $((image_bytes / 1000000)) MB"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Smoke GIT_AUTHOR_EMAIL=smoke@example.com GIT_COMMITTER_NAME=Smoke GIT_COMMITTER_EMAIL=smoke@example.com
remote=$work/remote.git
git init -q --bare -b main "$remote"
git -C "$root" push -q "$remote" HEAD:refs/heads/main
git clone -q -b main "$remote" "$work/seed"
find "$work/seed" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$root" ls-files -z --cached --others --exclude-standard | tar -c -C "$root" --null -T - | tar -x -C "$work/seed"
git -C "$work/seed" add -A
git -C "$work/seed" diff --cached --quiet || git -C "$work/seed" commit -q -m "smoke: the working tree"
git -C "$work/seed" push -q origin main

mkdir -p "$work/app/secrets"
token=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
printf '%s\n' "$token" >"$work/app/secrets/pair-token"
echo FAKE-DEPLOY-KEY >"$work/app/secrets/deploy-key"
echo FAKE-CLOUDFLARE-TOKEN >"$work/app/secrets/cloudflare-token"
chmod 400 "$work"/app/secrets/*

"$root/scripts/composer/deploy-unraid" print-layout /work/app |
  docker run -i --rm --name "$helper" --entrypoint sh --mount "type=bind,source=$work,target=/work" "$image" -s

docker network create "$network" >/dev/null
docker run -d --name "$site" --network "$network" --entrypoint node "$image" \
  -e 'require("node:http").createServer((_, res) => res.end("<html>public site</html>")).listen(8080)' >/dev/null

run_flags=$("$root/scripts/composer/deploy-unraid" print-flags)
mapfile -t run_flags <<<"$run_flags"
docker run -d --name "$app" --network "$network" "${run_flags[@]}" \
  -p "127.0.0.1:$app_port:443" -p "127.0.0.1:$proof_port:8444" \
  --mount "type=bind,source=$work/app/data,target=/data" \
  --mount "type=bind,source=$work/app/secrets,target=/run/secrets,readonly" \
  --mount "type=bind,source=$remote,target=/remote.git" \
  -e COMPOSER_REMOTE=/remote.git \
  -e "COMPOSER_APP_ORIGIN=$app_url" \
  -e "COMPOSER_PROOF_ORIGIN=http://127.0.0.1:$proof_port" \
  -e COMPOSER_AUTHOR_NAME=Composer -e COMPOSER_AUTHOR_EMAIL=composer@example.com \
  -e COMPOSER_TOKEN_FILE=/run/secrets/pair-token -e COMPOSER_SSH_KEY_FILE=/run/secrets/deploy-key \
  -e "COMPOSER_SITE_URL=http://$site:8080" \
  "$image" >/dev/null

wait_healthy() {
  local try
  for ((try = 0; try < 60; try++)); do
    [[ $(docker inspect "$app" --format '{{.State.Health.Status}}') == healthy ]] && return 0
    [[ $(docker inspect "$app" --format '{{.State.Running}}') == true ]] || die "the container stopped"
    sleep 1
  done
  die "the container did not become healthy"
}
wait_healthy
pass "HEALTHCHECK passes, so uid 0 with no CAP_NET_BIND_SERVICE listens on port 443"

in_app() { docker exec "$app" "$@"; }
as_build() { docker exec "$app" setpriv --reuid=1001 --regid=1001 --clear-groups "$@"; }

health_code=$(docker inspect "$image" --format '{{index .Config.Healthcheck.Test 4}}')
refused "HEALTHCHECK fails when no server answers" docker exec -e COMPOSER_APP_PORT=9 "$app" bun --no-install -e "$health_code"

caps=$(in_app sh -c "grep -E 'CapEff|CapBnd|NoNewPrivs' /proc/1/status | tr -s '\t ' ' ' | tr '\n' ' '")
equal "uid 0 keeps only SETUID and SETGID, with no-new-privileges" "$caps" "CapEff: 00000000000000c0 CapBnd: 00000000000000c0 NoNewPrivs: 1 "
equal "setpriv works under no-new-privileges" "$(as_build id -u)" 1001
equal "uid 1001 has no capabilities" "$(as_build sh -c "grep CapEff /proc/self/status | tr -s '\t ' ' '")" "CapEff: 0000000000000000"

refused "/app/node_modules does not exist" in_app test -e /app/node_modules
equal "the image holds no test file" "$(in_app find /app -name '*.test.ts' -o -name fixture.ts -o -name uid-check.ts)" ""
equal "/app holds only the server files" "$(in_app find /app -type f -not -path '*/shell/dist/*' -not -path '*/composer/server/*' | sort | tr '\n' ' ')" \
  "/app/scripts/composer/protocol.ts /app/scripts/composer/text.ts /app/src/lib/post-plain.ts /app/src/site.ts "
equal "bun matches packageManager" "bun@$(in_app bun --version)" "$(jq -r .packageManager "$root/package.json")"
equal "node matches .node-version" "$(in_app node --version)" "v$(cat "$root/.node-version")"
in_app sh -c 'lego --version | grep -q "version 5.5.2"' && pass "lego is the pinned version"
equal "known_hosts has three GitHub keys" "$(in_app grep -c '^github.com ' /etc/ssh/ssh_known_hosts)" 3

for path in /run/secrets/deploy-key /run/secrets/pair-token /run/secrets/cloudflare-token; do
  refused "uid 1001 cannot read $path" as_build cat "$path"
done
refused "uid 1001 cannot list /run/secrets" as_build ls /run/secrets
for path in /data/pads /data/repo.git /data/proof /data/lego; do
  refused "uid 1001 cannot list $path" as_build ls "$path"
done
refused "the rootfs is read-only for uid 0" in_app touch /app/file
refused "the rootfs is read-only for uid 1001" as_build touch /app/file
refused "the secrets mount is read-only for uid 0" in_app touch /run/secrets/file
refused "uid 1001 cannot write to /data" as_build touch /data/file
as_build touch /tmp/file /data/builds/file /data/deps/file
as_build rm /tmp/file /data/builds/file /data/deps/file
pass "uid 1001 can write to /tmp, /data/builds, and /data/deps"

json=(-H 'content-type: application/json')
equal "the API needs a session" "$(curl -sS -o /dev/null -w '%{http_code}' "$app_url/api/pads")" 401
cookie=$(jq -nc --arg token "$token" '{token: $token}' | curl -fsS "${json[@]}" --data-binary @- -o /dev/null -D - "$app_url/api/pair" |
  sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\).*/\1/p')
[[ -n $cookie ]] || die "pairing gave no cookie"
pass "pairing works"
session=(-H "Cookie: $cookie")

new_pad() {
  jq -nc --arg id "$1" --arg text "$2" \
    '{id: $id, rev: 1, text: $text, tags: [], target: {kind: "new"}, stage: {kind: "writing"}, updatedAt: "2026-10-31T00:00:00.000Z"}'
}
prove() { jq -c '{pad: .}' <<<"$1" | curl -sS --max-time 600 "${session[@]}" "${json[@]}" --data-binary @- "$app_url/api/prove"; }
ship() { jq -nc --arg sha "$1" '{sha: $sha}' | curl -fsS --max-time 60 "${session[@]}" "${json[@]}" --data-binary @- "$app_url/api/ship"; }

before=$(git -C "$remote" rev-parse main)
pad=$(new_pad smoke-pad-one "Smoke post $tag

The body of the smoke post.")
equal "PUT saves a pad" "$(curl -fsS -X PUT "${session[@]}" "${json[@]}" --data-binary "$pad" "$app_url/api/pads/smoke-pad-one" | jq -c .)" '{"rev":1}'
equal "GET reads the pad" "$(curl -fsS "${session[@]}" "$app_url/api/pads" | jq -r '.[0].id')" smoke-pad-one

started=$(date +%s%N)
proved=$(prove "$pad")
first_ms=$((($(date +%s%N) - started) / 1000000))
equal "a real Astro build proves the pad (install and build: $first_ms ms)" "$(jq -r .kind <<<"$proved")" proved
sha=$(jq -r .sha <<<"$proved")
page=$(jq -r .url <<<"$proved")
curl -fsS "${session[@]}" "$page" >"$work/page.html"
grep -q "The body of the smoke post" "$work/page.html" || die "the proof port does not serve the page"
grep -q 'name="generator" content="Astro' "$work/page.html" || die "Astro did not make the page"
pass "the proof port serves the page that Astro built"

equal "ship pushes" "$(ship "$sha" | jq -r .kind)" pushed
equal "main is the proved commit" "$(git -C "$remote" rev-parse main)" "$sha"
equal "main has exactly one new commit" "$(git -C "$remote" rev-list --count "$before..main")" 1
paths=$(git -C "$remote" diff-tree --no-commit-id --name-only -r main)
equal "the commit changes one path" "$(wc -l <<<"$paths")" 1
[[ $paths == src/content/posts/*.md ]] || die "the commit changed $paths"
pass "the one path is a post: $paths"
equal "the next ship call finds the post on the public site" "$(ship "$sha" | jq -r .kind)" live

git -C "$work/seed" pull -q origin main
jq '.scripts.build = "astro build && ln -s /run/secrets/pair-token dist/leak.txt && ln -s /run/secrets dist/leak-dir && ln -s /run/secrets/pair-token dist/proof.json && mkfifo dist/pipe && env > dist/env.txt && id -u > dist/uid.txt"' \
  "$work/seed/package.json" >"$work/package.json"
cp "$work/package.json" "$work/seed/package.json"
git -C "$work/seed" commit -q -am "smoke: a hostile build"
git -C "$work/seed" push -q origin main

started=$(date +%s%N)
proved=$(prove "$(new_pad smoke-pad-two "Hostile post $tag

The second body.")")
cached_ms=$((($(date +%s%N) - started) / 1000000))
equal "a hostile build is proved (cached dependencies: $cached_ms ms)" "$(jq -r .kind <<<"$proved")" proved
equal "no symlink reaches the slot" "$(in_app find /data/proof -mindepth 2 -type l)" ""
equal "no FIFO reaches the slot" "$(in_app find /data/proof -mindepth 2 -type p)" ""
proof=http://127.0.0.1:$proof_port
equal "a link to a secret does not answer" "$(curl -sS -o /dev/null -w '%{http_code}' "${session[@]}" "$proof/leak.txt")" 404
equal "a link to a directory does not answer" "$(curl -sS -o /dev/null -w '%{http_code}' "${session[@]}" "$proof/leak-dir/pair-token")" 404
in_app grep -q '"sha"' /data/proof/current/proof.json && pass "proof.json is the file of the server"
equal "the build ran as uid 1001" "$(curl -fsS "${session[@]}" "$proof/uid.txt")" 1001
build_env=$(curl -fsS "${session[@]}" "$proof/env.txt")
for word in COMPOSER CLOUDFLARE "$token" FAKE-; do
  [[ $build_env != *"$word"* ]] || die "the build environment holds $word"
done
pass "the build environment holds no secret and no composer setting"

prove "$(new_pad smoke-pad-three "Stopped post $tag")" >/dev/null 2>&1 &
in_flight=$!
for ((try = 0; try < 100; try++)); do
  [[ -n $(as_build find /data/builds -mindepth 1 -maxdepth 1) ]] && break
  sleep 0.1
done
[[ -n $(as_build find /data/builds -mindepth 1 -maxdepth 1) ]] || die "the third build did not start"
started=$(date +%s%N)
docker stop -t 20 "$app" >/dev/null
stop_ms=$((($(date +%s%N) - started) / 1000000))
equal "SIGTERM during a build exits with code 0 ($stop_ms ms)" "$(docker inspect "$app" --format '{{.State.ExitCode}}')" 0
((stop_ms < 15000)) || die "the stop was too slow: $stop_ms ms"
wait "$in_flight" || true
in_flight=

docker start "$app" >/dev/null
wait_healthy
equal "the pads stay after a restart" "$(curl -fsS "${session[@]}" "$app_url/api/pads" | jq 'length')" 3
equal "/app/node_modules still does not exist" "$(in_app sh -c 'test -e /app/node_modules && echo found || echo absent')" absent

printf 'image %s MB, first proof %s ms, cached proof %s ms\n' "$((image_bytes / 1000000))" "$first_ms" "$cached_ms"
