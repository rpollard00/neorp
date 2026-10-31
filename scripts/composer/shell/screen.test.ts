import { describe, expect, test } from "bun:test";
import {
  parseProved,
  type Pad,
  type PadId,
  type Proved,
  type Refusal,
  type Sha,
  type Slug,
} from "../protocol";
import {
  barOf,
  isWatching,
  liveLine,
  MAX_POLLS,
  pairFailureCopy,
  reduce,
  refusalNotice,
  screenForPad,
  shippingCopy,
  surfaceOf,
  writeNotice,
  type Event,
  type Screen,
  type ShipProblem,
  type WriteProblem,
} from "./screen";

const SHA = "a".repeat(40) as Sha;
const SLUG = "cache-drive" as Slug;
const PROOF_URL = "https://compose.example:8444/posts/cache-drive/";
const POST_URL = "https://reesep.com/posts/cache-drive/";

const write: Screen = { kind: "write", popover: "closed", problem: null };
const building: Screen = { kind: "building" };
const preview: Screen = { kind: "preview", sha: SHA, url: PROOF_URL };
const shipping: Screen = {
  kind: "shipping",
  sha: SHA,
  page: PROOF_URL,
  problem: null,
};
const pushed: Screen = {
  kind: "pushed",
  sha: SHA,
  url: POST_URL,
  page: PROOF_URL,
  polls: 0,
};
const live: Screen = { kind: "live", url: POST_URL, page: PROOF_URL };
const earlier: Screen = { kind: "earlier" };
const pair: Screen = { kind: "pair", failure: null };

const ALL_SCREENS = [
  write,
  building,
  preview,
  shipping,
  pushed,
  live,
  earlier,
  pair,
];

const pad = (stage: Pad["stage"]): Pad => ({
  id: "pad-00000001" as PadId,
  rev: 3,
  text: "A thought",
  tags: [],
  target: { kind: "new" },
  stage,
  updatedAt: "2026-10-31T10:00:00.000Z",
});

const run = (screen: Screen, ...events: Event[]) =>
  events.reduce(reduce, screen);

describe("the publish path", () => {
  test("a pad goes from writing to live", () => {
    const end = run(
      write,
      { kind: "prove-started" },
      {
        kind: "prove-answered",
        answer: { kind: "proved", sha: SHA, url: PROOF_URL },
      },
      { kind: "ship-started" },
      {
        kind: "ship-answered",
        answer: { kind: "pushed", url: POST_URL, slug: SLUG },
      },
      {
        kind: "ship-answered",
        answer: { kind: "live", url: POST_URL, slug: SLUG },
      },
    );
    expect(end).toEqual(live);
  });

  test("the built page stays behind the bar from preview to live", () => {
    expect(reduce(preview, { kind: "ship-started" })).toEqual(shipping);
    expect(
      reduce(shipping, {
        kind: "ship-answered",
        answer: { kind: "pushed", url: POST_URL, slug: SLUG },
      }),
    ).toEqual(pushed);
  });

  test("a first answer of live skips pushed", () => {
    expect(
      reduce(shipping, {
        kind: "ship-answered",
        answer: { kind: "live", url: POST_URL, slug: SLUG },
      }),
    ).toEqual(live);
  });
});

describe("problems", () => {
  test("a refusal returns to write with the reason", () => {
    const why: Refusal = { kind: "build-failed", tail: "log\nno memory\n" };
    expect(
      reduce(building, {
        kind: "prove-answered",
        answer: { kind: "refused", why },
      }),
    ).toEqual({
      kind: "write",
      popover: "closed",
      problem: { kind: "refused", why },
    });
  });

  test("no server during a build returns to write", () => {
    expect(
      reduce(building, { kind: "prove-failed", problem: "no-server" }),
    ).toEqual({
      kind: "write",
      popover: "closed",
      problem: { kind: "no-server" },
    });
  });

  test.each(["stale", "not-proven"] as const)(
    "%s returns to write with a preview-again action",
    (kind) => {
      const screen = reduce(shipping, {
        kind: "ship-answered",
        answer: { kind },
      });
      expect(screen).toEqual({
        kind: "write",
        popover: "closed",
        problem: { kind },
      });
      if (screen.kind !== "write" || !screen.problem) throw new Error("write");
      expect(writeNotice(screen.problem).action).toBe("Preview again");
    },
  );

  test("origin-unreachable keeps the shipping screen and the sha", () => {
    expect(
      reduce(shipping, {
        kind: "ship-answered",
        answer: { kind: "origin-unreachable" },
      }),
    ).toEqual({ ...shipping, problem: { kind: "origin-unreachable" } });
  });

  test("a failed ship call keeps the shipping screen", () => {
    expect(
      reduce(shipping, { kind: "ship-failed", problem: "no-server" }),
    ).toEqual({ ...shipping, problem: { kind: "no-server" } });
  });

  test("the server coming back clears only the no-server notice", () => {
    const noServer: Screen = {
      kind: "write",
      popover: "closed",
      problem: { kind: "no-server" },
    };
    const refused: Screen = {
      kind: "write",
      popover: "closed",
      problem: { kind: "stale" },
    };
    expect(reduce(noServer, { kind: "server-back" })).toEqual(write);
    expect(reduce(refused, { kind: "server-back" })).toEqual(refused);
  });

  test("an edit clears the notice", () => {
    const screen: Screen = {
      kind: "write",
      popover: "closed",
      problem: { kind: "stale" },
    };
    expect(reduce(screen, { kind: "edited" })).toEqual(write);
  });
});

describe("the session", () => {
  test.each(ALL_SCREENS.map((screen) => [screen.kind, screen] as const))(
    "a denial on %s goes to pair",
    (_kind, screen) => {
      expect(reduce(screen, { kind: "denied" })).toEqual(pair);
    },
  );

  test("a pad in shipping opens the shipping screen after pairing", () => {
    const screen = reduce(pair, {
      kind: "pad-opened",
      pad: pad({ kind: "shipping", sha: SHA }),
    });
    expect(screen.kind).toBe("shipping");
  });

  test("a failure stays on pair", () => {
    expect(
      reduce(pair, {
        kind: "pair-failed",
        failure: { kind: "wrong-token" },
      }),
    ).toEqual({ kind: "pair", failure: { kind: "wrong-token" } });
  });
});

describe("the popover", () => {
  test("it opens and closes on write only", () => {
    const open = reduce(write, { kind: "tags-toggled" });
    expect(open).toEqual({ ...write, popover: "open" });
    expect(reduce(open, { kind: "tags-closed" })).toEqual(write);
    expect(reduce(open, { kind: "tags-toggled" })).toEqual(write);
    expect(reduce(building, { kind: "tags-toggled" })).toEqual(building);
  });
});

describe("the live poll", () => {
  const notLive: Event = {
    kind: "ship-answered",
    answer: { kind: "pushed", url: POST_URL, slug: SLUG },
  };

  test("it stops at 40 answers, which is 10 minutes at 15 seconds", () => {
    let screen: Screen = pushed;
    for (let poll = 0; poll < MAX_POLLS - 1; poll++) {
      screen = reduce(screen, notLive);
      expect(isWatching(screen)).toBe(true);
    }
    expect(barOf(screen)).toBe("pushed");
    screen = reduce(screen, notLive);
    expect(isWatching(screen)).toBe(false);
    expect(barOf(screen)).toBe("settled");
  });

  test("a failed poll counts", () => {
    const screen = reduce(pushed, {
      kind: "ship-failed",
      problem: "no-server",
    });
    expect(screen).toEqual({ ...pushed, polls: 1 });
  });

  test("a late answer can still show live", () => {
    expect(
      reduce(
        { ...pushed, polls: MAX_POLLS },
        {
          kind: "ship-answered",
          answer: { kind: "live", url: POST_URL, slug: SLUG },
        },
      ),
    ).toEqual(live);
  });
});

describe("a late event", () => {
  const proved: Event = {
    kind: "prove-answered",
    answer: { kind: "proved", sha: SHA, url: PROOF_URL },
  };

  test("a prove answer after the screen moved does nothing", () => {
    for (const screen of ALL_SCREENS.filter((s) => s.kind !== "building")) {
      expect(reduce(screen, proved)).toEqual(screen);
    }
  });

  test("a ship answer after New thought does nothing", () => {
    expect(
      reduce(write, {
        kind: "ship-answered",
        answer: { kind: "stale" },
      }),
    ).toEqual(write);
  });

  test("publish needs a preview", () => {
    expect(reduce(write, { kind: "ship-started" })).toEqual(write);
  });

  test("earlier cannot open during a build", () => {
    expect(reduce(building, { kind: "earlier-opened" })).toEqual(building);
  });
});

describe("screenForPad", () => {
  test("a pad in shipping has no page after a relaunch", () => {
    const screen = screenForPad(pad({ kind: "shipping", sha: SHA }));
    expect(screen).toEqual({
      kind: "shipping",
      sha: SHA,
      page: null,
      problem: null,
    });
    expect(surfaceOf(screen)).toBe("editor");
  });

  test.each([
    { kind: "writing" },
    { kind: "published", slug: SLUG, sha: SHA, url: POST_URL },
  ] satisfies Pad["stage"][])("stage $kind opens write", (stage) => {
    expect(screenForPad(pad(stage))).toEqual(write);
  });
});

describe("the surface", () => {
  test("write and building keep the text visible", () => {
    expect(surfaceOf(write)).toBe("editor");
    expect(surfaceOf(building)).toBe("editor");
  });

  test("a screen with a page shows the page", () => {
    expect(surfaceOf(preview)).toBe("page");
    expect(surfaceOf(shipping)).toBe("page");
    expect(surfaceOf(pushed)).toBe("page");
    expect(surfaceOf(live)).toBe("page");
  });
});

describe("copy", () => {
  const REFUSALS: { [K in Refusal["kind"]]: Extract<Refusal, { kind: K }> } = {
    blank: { kind: "blank" },
    "origin-unreachable": { kind: "origin-unreachable" },
    toolchain: { kind: "toolchain", need: "bun 1.4.3" },
    "revise-conflict": { kind: "revise-conflict" },
    "not-revisable": { kind: "not-revisable" },
    unchanged: { kind: "unchanged" },
    "build-failed": { kind: "build-failed", tail: "The disk is full.\n" },
    "no-page": { kind: "no-page" },
  };

  test.each(Object.values(REFUSALS))("refusal $kind has copy", (why) => {
    const notice = refusalNotice(why);
    expect(notice.text).not.toBe("");
    expect(notice.action).not.toBe("");
  });

  test.each(Object.values(REFUSALS))("refusal $kind parses", (why) => {
    const answer = { kind: "refused", why } satisfies Proved;
    expect(parseProved(answer)).toEqual(answer);
  });

  test("a Fix with no change says that it matches the live post", () => {
    expect(refusalNotice({ kind: "unchanged" }).text).toBe(
      "This matches the live post.",
    );
  });

  test.each<WriteProblem>([
    { kind: "no-server" },
    { kind: "server-error" },
    { kind: "refused", why: { kind: "blank" } },
    { kind: "stale" },
    { kind: "not-proven" },
  ])("write problem $kind has copy", (problem) => {
    expect(writeNotice(problem).text).not.toBe("");
  });

  test.each<ShipProblem | null>([
    null,
    { kind: "no-server" },
    { kind: "server-error" },
    { kind: "origin-unreachable" },
  ])("ship problem %j has copy", (problem) => {
    expect(shippingCopy(problem).line).not.toBe("");
  });

  test("pair failures have copy", () => {
    for (const kind of ["wrong-token", "no-server"] as const) {
      expect(pairFailureCopy[kind]).not.toBe("");
    }
  });

  test("the strings of the approved mockup stay exact", () => {
    expect(writeNotice({ kind: "no-server" }).text).toBe(
      "Preview needs the server. Turn on Tailscale.",
    );
    expect(
      refusalNotice({
        kind: "build-failed",
        tail: "error: killed\nThe server ran out of memory.\n",
      }),
    ).toEqual({
      label: "Build failed",
      text: "The server ran out of memory.",
      action: "Try again",
      outlined: false,
    });
    expect(liveLine(POST_URL)).toBe("On reesep.com");
  });

  test("a build failure shows the error line of the log, not the stack", () => {
    const tail = [
      "11:20:05 [content] Syncing content",
      "[InvalidContentEntryDataError] posts → a-post data does not match collection schema.",
      "",
      "  pubDate: Expected type `date`, received `string`",
      "  Stack trace:",
      "    at getEntryData (/data/deps/abc/node_modules/astro/dist/content/utils.js:126:9)",
      "    at async eval (/data/deps/abc/node_modules/astro/dist/content/loaders/glob.js:225:13)",
    ].join("\n");
    expect(refusalNotice({ kind: "build-failed", tail }).text).toBe(
      "posts → a-post data does not match collection schema.",
    );
  });
});
