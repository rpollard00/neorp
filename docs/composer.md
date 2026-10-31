# Composer design

Status: **built, not deployed**. See "Setup" for the steps that deploy it.

The composer is a private iPhone web app. It lets the owner write a short post,
see the real built page, and publish the post with a push to `main`.

## Problem

Thoughts come when the owner is away from the computer, and then the thoughts
go away. `bun post publish` cannot run on a phone. It needs a jj working copy, a
terminal, and answers to prompts.

The design has three requirements, in this order:

1. The composer must not lose text.
2. The composer must not break `main` or commit junk.
3. The composer must not add ceremony.

## Settled decisions

- A short post is a plain post. The site and `postSchema` do not change.
- The owner types text. The first line is the title.
- Tags are optional. A popover adds them.
- The composer skips the description and the plate.
- The editor shows Markdown formatting while the owner types.
- The target device is an iPhone.
- The composer is on the Unraid server.
- The app must work on the home LAN with Tailscale off.
- Away from home, the app works when Tailscale is on.
- Guests use the home wifi, so the app needs a one-time login.

## Usage

1. The owner taps the Home Screen icon. The app opens, also when the server is
   not reachable.
2. The owner types. Each keystroke goes to `localStorage`. If `localStorage` is
   full, the app first removes published and discarded pads that the server has.
   If that frees too little, the status says "Not saved on this phone", and the
   text stays in memory until the server has it.
3. If the server is reachable, the app saves the text to the server.
   The owner can tap **Tags** to add tags.
4. The owner taps **Preview**. After an estimated 5 to 10 seconds, the app shows
   the real built page.
5. The owner taps **Publish**. The status changes to "Pushed", then to "Live".
6. If the post has a typo, the owner taps **Fix**. The URL and the date stay.

## Interface

The app has one service with these routes:

```text
POST /api/pair      { token }  -> cookie      pair this app once
GET  /api/session              -> nothing     refresh the cookie at launch
PUT  /api/pads/:id  Pad        -> { rev, same } save a pad, safe to retry
GET  /api/pads                 -> Pad[]       restore pads after storage loss
GET  /api/tags                 -> string[]    tags in use on main
POST /api/prove     { pad }    -> Proved      build the exact commit that can ship
POST /api/ship      { sha }    -> ShipStatus  push that commit, call again to poll
GET  /*                                       app shell, cached by the service worker
```

A second port serves the files of the current proof. This port is a different
origin, so code in a built page cannot read pads or call the API.

## Terms

- **Pad**: one piece of text that the owner wrote. A pad is on the phone, and on
  the server after a save.
- **Proof**: a passed build of one commit. The composer holds one proof at a time.
- **Prove**: make a commit, build it, and keep the output as the proof.
- **Ship**: push the commit of the proof to `main`.

## Shape

`scripts/composer/protocol.ts` holds the types that the app and the server
share. `scripts/composer/text.ts` turns text into a post file.

A pad has a target and a stage. The target is a new post, or a fix of a post. The
stage is `writing`, `shipping`, `published`, or `discarded`. The server keeps
the pad with the highest `rev`. `same` in the `PUT` answer is false if the server
keeps other text or tags than the request sent.

`prove` does these steps in this order:

1. Save the pad. No later step can lose the text.
2. Fetch `main`. If the slot matches the parent and the intent, return the slot.
3. Refuse if the bun or node version differs from the image.
4. Make a commit of the parent plus one file with git plumbing.
5. As uid 1001, export the commit, link the dependencies, and run the build.
6. Copy `dist` out as uid 0, delete symlinks, and switch the slot.

`ship` fetches `main`. If the commit is on `main`, it reports `pushed` or `live`.
It pushes only the commit in the slot, and never forces. A non-fast-forward
returns `stale`.

### Decisions

- **Preview and gate are one operation.** The preview is an `astro build` of the
  exact commit that can ship. `ship` pushes this commit or refuses. A dev server
  cannot show a stale page here because there is no dev server.
- **GitHub is the only lock against the laptop.** The ref update decides who
  wins. No check before the push can race it.
- **No ledger.** If the process stops after a push, the ancestor check in `ship`
  gives the correct state. A double tap and a retry use the same path.
- **A pad leaves the phone list only after `pushed`.** A refusal keeps the pad.
- **The container has no jj.** It has a bare clone and uses `git archive`. Build
  trees have no `.git` directory.
- **Dependencies come from each commit.** The composer installs from the
  `bun.lock` of that commit into a cache volume. Only composer code or a bun or
  node change needs a new image.
- **`pubDate` is `siteToday` at prove time.** A real build leaves out drafts, so
  each proof has a date. The composer cannot schedule posts.
- **The composer writes only `.md` files.** MDX runs code in the Cloudflare build.
- **Two versions that disagree are both kept.** `rev` counts edits on one device,
  so it cannot show which text is newer. If the server or another tab has other
  text at the same or a higher `rev`, the app copies the local text to a new pad
  and puts the other version on the original id. The editor stays on the owner's
  text, on the new pad, and the other version shows in Earlier. Equal text is no
  conflict at any `rev`. A local `rev` above the server still replaces the server
  copy, because a `PUT` has no base version.
- **A fix of a post has no Discard.** A discarded pad shows in the Discarded
  section of Earlier, and **Restore** returns it to writing.
- **A revised post is live when its visible text matches the proof.** The check
  covers the meta line through the end of `.prose`. A new post is live on a 200.
- **Text that starts with code or a rule has no title line.** The title is
  `Note <day>`, and all the text is the body.

### Markdown

The site already renders this Markdown with no change. A `---` line is the
checker break, because `.prose hr` paints it. A fenced code block uses the Shiki
`tokyo-night` theme. Only the editor is new work.

The editor uses CodeMirror 6, bundled into the shell at image build. The server
process does not import it. The editor shows these items while the owner types:

- The first line in bold, as the title.
- A `---` line as the checker break. On the line of the cursor, the text shows.
- A fenced code block as a dark panel in a mono font, with dim fence lines.
- A `>` line with the checker bar.
- Bold, italic, inline code, and `##` headings.

The bottom bar has one control for a separator and one for a code block. Each
control inserts the Markdown, because backticks are slow to type on an iPhone
keyboard. The editor does not color code tokens. The preview shows the Shiki
colors.

`normalizeBody` corrects the text at prove time. The owner sees the result in
the preview. It applies these rules:

- A `---` line directly under text makes that text a heading. A build test on
  2026-10-31 showed this. The function puts a blank line before each `---` line.
- iOS Smart Punctuation changes `--` to an em dash. Outside a fence, the function
  changes a line of only dashes to `---`.
- Inside a fence, the function changes curly quotes to straight quotes and an em
  dash to `--`. Outside a fence, the function keeps curly quotes.

An unclosed fence runs to the end of the post, as in all Markdown. The preview
shows this.

### Tags

The **Tags** control opens a popover above the bar. The popover shows the tags
in use and a field for a new tag. The app keeps the tags with the pad, so the
tags stay on the phone when the server is not reachable.

`GET /api/tags` reads the tags from the frontmatter of the posts on `main`. The
server imports no YAML parser, so it reads the flow and block forms with a small
parser. This list is only a suggestion, so a missed tag does no harm. The app
keeps the last list for use when the server is not reachable.

### Trust

The server process holds the key and imports no `node_modules`. A test fails on
a bare import. Builds run as uid 1001 with a clean environment.

- The key is a deploy key for this repository only. The mount is root-owned, mode
  `0400`.
- A GitHub ruleset blocks force-push and deletion on `main`.
- The API and the proof port require a session cookie. `POST /api/pair` sets this cookie once, after
  the owner enters a long random token. The token mount is root-owned, mode `0400`.
- The cookie is `HttpOnly`, `Secure`, and `SameSite=Strict`.
- The deploy script makes the token from 256 random bits, so pairing has no
  limit on tries.
- A request to the app port that is not a GET and has a `Sec-Fetch-Site` header
  must be `same-origin`.
- The container uses `read_only`, `cap_drop ALL` plus `SETUID` and `SETGID`,
  `no-new-privileges`, and memory and pid limits.

A hostile dependency cannot read the key, push code, or rewrite history. It can
show a false preview. It can reach the LAN. It cannot pair, because uid 1001
cannot read the token. The dependency already runs on the laptop, with more
access than this. A later builder container with `--network none` closes the
LAN path.

### Network

The composer uses one address on all networks: `https://compose.reesep.com`. An
installed app is tied to its origin, so a second address needs a second app with
different storage.

The address works in this way:

- The container has the address `192.168.88.16` on `br0`, like the other apps.
- A Pi-hole local DNS record points `compose.reesep.com` to `192.168.88.16`.
- At home, the phone gets this record from Pi-hole and connects over wifi.
- Away from home, Tailscale sends DNS to Pi-hole. The approved subnet route
  carries the connection to the container.
- The name is not in public DNS, so the private address stays private.

If the phone cannot reach the server, the service worker opens the app and the
text stays on the phone. The app saves the text to the server at the next open.

The composer needs HTTPS for the service worker. A Let's Encrypt certificate
comes from a DNS-01 challenge, which writes one TXT record to the public
Cloudflare zone. This needs a Cloudflare API token with Zone.DNS edit and
Zone.Zone read access to the zone. The token gets the same protection as the
deploy key.

The composer serves the app on port 443 and the proofs on port 8444.

### Deployment

The deployment copies `scryer/scripts/deploy-unraid`: `docker save | ssh docker
load`, the same hardening flags, and a probe of a route that reads data. It adds
read-only file mounts for the deploy key, the pairing token, and the Cloudflare
token. The hotplate pipeline is too large and too
specific to copy.

If the new container does not answer in 300 seconds, an update goes back to the
previous image. A first deploy has no previous image. The container stays running
and tries the certificate again, and the script prints the log and exits with an
error. A failed lego try waits 5 minutes, and the wait doubles up to 6 hours. The
random wait of lego, of up to 8 minutes, applies only to a renewal. A run of the
pinned lego against a local ACME stub on 2026-10-31 showed this.

### Files

All composer code is in `scripts/composer/`:

- `protocol.ts`, `text.ts`: the shared contract and the post file rules.
- `server/`: the pipeline, the pads, the HTTP routes, the sandbox, and the
  certificate renewal. It imports only `bun`, `node:*`, and relative files.
- `shell/`: the phone app, with its reducer, journal, editor, and service worker.
- `Dockerfile`, `deploy-unraid`, `smoke-container.sh`: the image, the deployment,
  and the container test.

`src/lib/post-plain.ts` holds the post helpers with no bare imports.

## Laptop change

`preflight` reads the local `main` bookmark and does not fetch. After the
composer pushes, `preflight` passes, and the failure comes late. The commit,
the build, and the local `main` move come first, then the push fails.

`jj git fetch` in `preflight` moves the failure to the start, before the command
writes anything. The existing `jj rebase -d main` message then applies.

## Tradeoffs

- We accept 5 to 10 seconds per preview, in exchange for no stale preview. On a
  phone, a live side-by-side view is not possible.
- We accept a second tap when `main` moves after a preview. A silent rebase ships
  a commit that the owner did not see.
- We accept a lockout when `main` changes bun or node, until a redeploy.
- We accept that "proved" means built here. Cloudflare builds again, so a deploy
  can still fail.
- We accept one proof slot. A second device can replace the proof of the first.
- We accept that **Fix** works only for posts in the local list of the phone.
  There is no retraction from the phone.
- We accept no images and no scheduling in the first version.
- We accept a CodeMirror bundle in the shell, in exchange for live formatting. A
  plain `textarea` cannot draw a break or a code panel in the text.
- We accept a Cloudflare token on the server, because the certificate must renew
  with no manual step. This token can change DNS for `reesep.com`.
- We accept that the certificate log shows the name `compose.reesep.com`.
- We accept that the app has no server path when Pi-hole is down.
- We accept that `deps/cache` grows without a limit. The composer keeps two
  installs, but bun does not prune its download cache.
- We accept that, with two devices on one pad, a higher local `rev` can still
  replace different text on the server. A `PUT` has no base version.
- We accept that a reload after a `localStorage` quota failure can leave a stale
  copy of a pad in Earlier. The journal keeps the last version that it could
  write.

## Alternatives

- **Live studio on `astro dev`.** Preview is 1 to 1.5 seconds, but the design has
  about 1,300 lines and keeps 550 MB in memory all day. It also depends on dev
  behavior that Astro does not promise, and dev hid a real production CSS bug.
- **Capture first, with an event log per draft.** This design has the best text
  safety, but it has about 1,600 lines. It also separates publish from capture,
  so thoughts can stay unpublished. The pad `PUT` keeps the useful part.
- **Apple Shortcut to the GitHub API, with no server.** This has the least code,
  but it has no preview and it keeps a push token on the phone.
- **`tailscale serve` with no LAN port.** This needs no token or certificate
  renewal, but the owner must turn on Tailscale at home.
- **Plain HTTP on the LAN.** This needs no certificate, but the app cannot open
  when the server is not reachable, and the token goes over wifi unencrypted.
- **Cloudflare preview of a pushed branch.** This shows production bytes, but it
  takes minutes and puts unpublished text on GitHub.

## Open items

The design has these unverified items:

- Does the Home Screen app open with no server path, and after a phone reboot?
- Do CodeMirror, dictation, autocorrect, and text selection work together on the
  iPhone?
- Does the session cookie stay in a Home Screen app for months?
- Does `navigator.storage.persist()` return true for a Home Screen app?
- What is the real build time on the Unraid server?

If the app does not open with no server path, use an Apple Shortcut that saves
text to iCloud Drive and then calls the pad `PUT`.

If CodeMirror fails on the iPhone, use a plain `textarea`. The formatting then
shows only in the preview, and the bar controls stay.

## Setup

Do these steps once, in this order:

1. Merge the branch `t3/design-local-posting-interface` to `main`. The composer
   code is on this branch, and `main` has no `scripts/composer`. The laptop fetch
   fix in `bun post publish` must be on `main` before the first post from the
   phone.
2. In a checkout of `main`, run `bun install`. The deploy runs `bun run check`,
   `bun test`, and `docker build` from this checkout. The workstation also needs
   `jq` and `curl`, and `ssh root@media.media` must connect with no prompt.
3. Run `scripts/composer/deploy-unraid init`.
4. Add the printed public key to the GitHub repository as a deploy key with
   write access.
5. On GitHub, add a ruleset that blocks force-push and deletion on `main`.
6. Make a Cloudflare API token with Zone.DNS edit and Zone.Zone read access to
   the `reesep.com` zone. lego needs both.
7. Write the token to the `cloudflareTokenFile` path in
   `~/.config/composer-unraid/deploy.json`, and set mode `0600` on the file.
8. Examine that config file. `init` copies the author and ACME email from
   `git config`. Fill in these values if they are empty.
9. In Pi-hole, add the local DNS record `compose.reesep.com` to `192.168.88.16`.
10. Run `bun run deploy:composer`. If this first deploy stops with "The
    certificate is not issued yet", the container stays running and tries again.
    Run `scripts/composer/deploy-unraid status`. Do not continue until the log
    shows `cert-issued`.
11. On the iPhone, open `https://compose.reesep.com` in Safari.
12. Tap **Share**, then tap **Add to Home Screen**.
13. Open the Home Screen app, and paste the token from the pair token file.

Then test these items on the iPhone: force-quit, reboot, Tailscale off, dictation,
autocorrect, and text selection.

## Tests

- `bun test`: all unit and server tests.
- `COMPOSER_E2E=1 bun test scripts/composer/server/e2e.test.ts`: a real site build.
- `bash scripts/composer/smoke-container.sh`: the image with the deployment flags.
