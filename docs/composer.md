# Composer design

Status: **proposed**. Nothing in this document is built.

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
2. The owner types. Each keystroke goes to `localStorage`.
3. If the server is reachable, the app saves the text to the server.
   The owner can tap **Tags** to add tags.
4. The owner taps **Preview**. After an estimated 5 to 10 seconds, the app shows
   the real built page.
5. The owner taps **Publish**. The status changes to "Pushed", then to "Live".
6. If the post has a typo, the owner taps **Fix**. The URL and the date stay.

## Interface

The app has one service with these routes:

```text
POST /_/pair      { token }      -> cookie      pair this app once
PUT  /_/pads/:id  { text, tags } -> { rev }     save a pad, safe to retry
GET  /_/pads                     -> Pad[]       restore pads after storage loss
GET  /_/tags                     -> string[]    tags in use on main
POST /_/prove     Intent         -> Proved      build the exact commit that can ship
POST /_/ship      { sha }        -> ShipStatus  push that commit, call again to poll
GET  /_/*                                       app shell, cached by the service worker
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

```ts
// scripts/composer/text.ts: pure, no bare imports
export type Slug = string & { readonly __brand: "Slug" };

/**
 * The first line is the title, capped at 70 characters at a word boundary.
 * A longer first line stays in the body. The slug is capped at 60 characters.
 * An empty slug or "index" becomes note-<day>. A taken slug gets -2, -3.
 * `taken` comes from slugFromPath, so foo/index.md counts as foo.
 */
export const newPostFile = (args: {
  text: string;
  tags: readonly string[];
  day: string;
  taken: readonly string[];
}): { slug: Slug; path: string; title: string; source: string } | undefined => {
  throw new Error("not implemented");
};

/** Keeps the slug, pubDate, and other frontmatter. Replaces the title, tags, and body. */
export const revisedPostFile = (args: {
  text: string;
  tags: readonly string[];
  current: string;
}): { title: string; source: string } | undefined => {
  throw new Error("not implemented");
};

/** The Markdown that ships. See "Markdown" for the rules. */
export const normalizeBody = (body: string): string => {
  throw new Error("not implemented");
};
```

```ts
// scripts/composer/server.ts
type Sha = string & { readonly __brand: "Sha" };
type PadId = string & { readonly __brand: "PadId" };

type Intent =
  | { kind: "new"; pad: PadId; text: string; tags: readonly string[] }
  | {
      kind: "revise";
      pad: PadId;
      text: string;
      tags: readonly string[];
      slug: Slug;
      from: Sha;
    };

/** On disk only after a passed build. `ship` can push nothing else. */
type Proof = { sha: Sha; parent: Sha; intent: Intent; slug: Slug };

type Refusal =
  | { kind: "blank" }
  | { kind: "origin-unreachable" }
  | { kind: "toolchain"; need: string }
  | { kind: "revise-conflict" }
  | { kind: "not-revisable" }
  | { kind: "build-failed"; tail: string }
  | { kind: "no-page" };

type Proved =
  | { kind: "proved"; sha: Sha; page: `/posts/${string}/` }
  | { kind: "refused"; why: Refusal };

type ShipStatus =
  | { kind: "pushed"; url: string }
  | { kind: "live"; url: string }
  | { kind: "stale" } // main moved, and nothing was pushed
  | { kind: "not-proven" }
  | { kind: "origin-unreachable" };

/** One promise queue runs prove and ship. */
const prove = async (intent: Intent): Promise<Proved> => {
  // TODO Save the pad first. No later step can lose the text.
  // TODO git fetch origin main. If the slot matches parent and intent, return it.
  // TODO Refuse if bun or node differs from the image.
  // TODO Commit with plumbing: parent plus one file, so a commit cannot carry junk.
  // TODO As uid 1001: git archive | tar -x, link deps/<sha256(bun.lock)>,
  //      bun install --frozen-lockfile on a cache miss, timeout 120 bun run build.
  // TODO dist/posts/<slug>/index.html must exist.
  // TODO uid 1001 tars dist. uid 0 extracts it, deletes symlinks, renames to the slot.
  throw new Error("not implemented");
};

/** Never forces. A second call is the poll. */
const ship = async ({ sha }: { sha: Sha }): Promise<ShipStatus> => {
  // TODO git fetch. If sha is an ancestor of origin/main, compare the .prose HTML of
  //      the public page with the proof: equal is live, else pushed.
  // TODO If sha is not the slot sha, return not-proven.
  // TODO git push origin <sha>:refs/heads/main. A non-fast-forward returns stale.
  throw new Error("not implemented");
};
```

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

`GET /_/tags` reads the tags from the frontmatter of the posts on `main`. The
server imports no YAML parser, so it reads the flow and block forms with a small
parser. This list is only a suggestion, so a missed tag does no harm. The app
keeps the last list for use when the server is not reachable.

### Trust

The server process holds the key and imports no `node_modules`. A test fails on
a bare import. Builds run as uid 1001 with a clean environment.

- The key is a deploy key for this repository only. The mount is root-owned, mode
  `0400`.
- A GitHub ruleset blocks force-push and deletion on `main`.
- The API requires a session cookie. `POST /_/pair` sets this cookie once, after
  the owner enters a long random token. The token mount is root-owned, mode `0400`.
- The cookie is `HttpOnly`, `Secure`, and `SameSite=Strict`.
- `POST /_/pair` accepts a small number of tries per hour.
- The API requires `Sec-Fetch-Site: same-origin`.
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
Cloudflare zone. This needs a Cloudflare API token with DNS edit access to the
zone. The token gets the same protection as the deploy key.

The composer serves the app on port 443 and the proofs on port 8444.

### Deployment

The deployment copies `scryer/scripts/deploy-unraid`: `docker save | ssh docker
load`, the same hardening flags, and a probe of a route that reads data. It adds
read-only file mounts for the deploy key, the pairing token, and the Cloudflare
token. The hotplate pipeline is too large and too
specific to copy.

### Files

Add these files in `scripts/composer/`:

| File                                    | Lines |
| --------------------------------------- | ----- |
| `server.ts`                             | 230   |
| `text.ts`                               | 120   |
| `shell/index.html`                      | 240   |
| `shell/editor.ts`                       | 150   |
| `shell/sw.js`, `manifest.webmanifest`   | 25    |
| `Dockerfile`, `deploy-unraid`           | 60    |
| `composer.test.ts`                      | 190   |

Change these files:

- `src/lib/post-plain.ts`: new file. Move `slugify`, `slugFromPath`, `siteToday`,
  `formatDay`, and `POSTS_DIR` here, with no bare imports.
- `src/lib/post.ts`, `scripts/post/post-file.ts`: import from that file.
- `scripts/post/publish.ts`: add `jj git fetch` to `preflight`.
- `README.md`: add the composer.

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

## Build order

Each step is usable on its own:

1. Serve the shell and editor at `compose.reesep.com` with a real certificate.
   Test force-quit, reboot, home wifi, no server path, and dictation on the iPhone.
2. Add `PUT /_/pads/:id`, then the tags popover. The owner can then capture text,
   with no publish.
3. Add `jj git fetch` to `preflight`.
4. Build `prove` and `ship` against local bare repositories. Test a stale push,
   a failed build, and a double ship.
5. Deploy to Unraid with the key and the ruleset.
6. Add **Fix** and the "Live" poll.
