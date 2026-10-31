import { describe, expect, test } from "bun:test";
import {
  parseProved,
  parseShipStatus,
  type Pad,
  type PadId,
  type Sha,
  type ShipStatus,
  type Slug,
} from "../protocol";
import {
  chipTags,
  createStore,
  earlierCount,
  earlierRows,
  mergePads,
  normalizeTag,
  pickCurrent,
  settleShip,
  type Journal,
  type StoreDeps,
} from "./store";

const SHA = "b".repeat(40) as Sha;
const SLUG = "cache-drive" as Slug;
const URL_LIVE = "https://reesep.com/posts/cache-drive/";
const START = Date.parse("2026-10-31T10:00:00.000Z");
const MINUTE = 60_000;

const padId = (n: number) => `pad-0000000${n}` as PadId;

const makePad = (change: Partial<Pad> = {}): Pad => ({
  id: padId(1),
  rev: 1,
  text: "A thought",
  tags: [],
  target: { kind: "new" },
  stage: { kind: "writing" },
  updatedAt: new Date(START).toISOString(),
  ...change,
});

const makeJournal = (log: string[] = []) => {
  const data = new Map<string, string>();
  const journal: Journal = {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      log.push(`store ${key}`);
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return { journal, data };
};

const makeClock = () => {
  let now = START;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (timer: unknown) => {
      if (typeof timer === "number") timers.delete(timer);
    },
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
      await Bun.sleep(0);
    },
  };
};

type Handler = (url: string, init: RequestInit) => Promise<Response>;

const json = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }));

const server = (seed: Pad[] = [], ship?: () => ShipStatus) => {
  const pads = new Map(seed.map((pad) => [pad.id, pad]));
  const calls: string[] = [];
  const handler: Handler = (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url === "/api/session") return json(null);
    if (url === "/api/pads") return json([...pads.values()]);
    if (url === "/api/tags") return json(["code", "notes"]);
    if (url === "/api/ship") return json(ship?.() ?? { kind: "stale" });
    if (url.startsWith("/api/pads/")) {
      const pad = JSON.parse(String(init.body)) as Pad;
      const kept = pads.get(pad.id);
      if (!kept || pad.rev > kept.rev) pads.set(pad.id, pad);
      return json({ rev: pads.get(pad.id)?.rev });
    }
    return json(null, 404);
  };
  return { pads, calls, handler };
};

const setup = (args: {
  handler?: Handler;
  journal?: ReturnType<typeof makeJournal>;
  log?: string[];
  online?: boolean;
}) => {
  const log = args.log ?? [];
  const { journal, data } = args.journal ?? makeJournal(log);
  const clock = makeClock();
  const seen = {
    denied: 0,
    back: 0,
    persist: 0,
    shipAnswers: [] as ShipStatus[],
    shipFailures: [] as string[],
    replaced: [] as Pad[],
  };
  let ids = 1;
  const deps: StoreDeps = {
    storage: journal,
    fetch: (url, init) => {
      log.push(`fetch ${init.method} ${url}`);
      return (args.handler ?? server().handler)(url, init);
    },
    online: () => args.online ?? true,
    now: clock.now,
    newId: () => padId(ids++),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    persist: () => {
      seen.persist++;
    },
    events: {
      changed: () => {},
      denied: () => {
        seen.denied++;
      },
      serverBack: () => {
        seen.back++;
      },
      shipAnswered: (_id, answer) => seen.shipAnswers.push(answer),
      shipFailed: (_id, problem) => seen.shipFailures.push(problem),
      currentReplaced: (pad) => seen.replaced.push(pad),
    },
  };
  return { store: createStore(deps), clock, data, log, seen };
};

const never: Handler = () => new Promise(() => {});
const dead: Handler = () => Promise.reject(new TypeError("Load failed"));

const storedPad = (data: Map<string, string>, id: PadId) => {
  const text = data.get(`pad:${id}`);
  return text === undefined ? undefined : (JSON.parse(text) as Pad);
};

describe("the journal", () => {
  test("each edit is in storage when edit returns, with no await", () => {
    const { store, data } = setup({ handler: never });
    store.edit("O");
    expect(storedPad(data, store.current().id)?.text).toBe("O");
    store.edit("On");
    expect(storedPad(data, store.current().id)?.text).toBe("On");
    expect(data.get("current")).toBe(store.current().id);
  });

  test("a fetch that never resolves cannot hold the text back", async () => {
    const { store, data, clock } = setup({ handler: never });
    store.start();
    store.edit("Thoughts go away");
    await clock.advance(5000);
    store.edit("Thoughts go away fast");
    expect(storedPad(data, store.current().id)?.text).toBe(
      "Thoughts go away fast",
    );
    expect(store.saveStatus()).toBe("on-this-phone");
  });

  test("the write comes before the first fetch", async () => {
    const log: string[] = [];
    const { store, clock } = setup({ handler: never, log });
    store.edit("First");
    await clock.advance(800);
    const write = log.findIndex((line) => line.startsWith("store pad:"));
    const call = log.findIndex((line) => line.startsWith("fetch"));
    expect(write).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(write);
  });

  test("a fetch that throws at once does not lose text", async () => {
    const { store, data, clock } = setup({ handler: dead });
    store.start();
    store.edit("Still here");
    await clock.advance(800);
    expect(storedPad(data, store.current().id)?.text).toBe("Still here");
  });

  test("each edit bumps rev", () => {
    const { store } = setup({ handler: never });
    store.edit("a");
    store.edit("ab");
    expect(store.current().rev).toBe(2);
    store.edit("ab");
    expect(store.current().rev).toBe(2);
  });

  test("a new launch reads the text back from storage", () => {
    const journal = makeJournal();
    const first = setup({ handler: never, journal });
    first.store.edit("Kept");
    const second = setup({ handler: never, journal });
    expect(second.store.current().text).toBe("Kept");
    expect(second.store.current().id).toBe(first.store.current().id);
  });

  test("persist runs once", () => {
    const { store, seen } = setup({ handler: never });
    store.start();
    expect(seen.persist).toBe(1);
  });
});

describe("a blank pad", () => {
  test("it is not stored and not sent", async () => {
    const api = server();
    const { store, data, clock } = setup({ handler: api.handler });
    store.start();
    await clock.advance(1000);
    store.setTags(["code"]);
    await clock.advance(1000);
    expect(data.has(`pad:${store.current().id}`)).toBe(false);
    expect(api.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
  });

  test("a pad with only spaces is blank", () => {
    const { store, data } = setup({ handler: never });
    store.edit("   \n ");
    expect(data.has(`pad:${store.current().id}`)).toBe(false);
    expect(store.saveStatus()).toBe("nothing");
  });

  test("clearing a pad keeps the last text in storage", () => {
    const { store, data } = setup({ handler: never });
    store.edit("Do not lose this");
    store.edit("");
    expect(storedPad(data, store.current().id)?.text).toBe("Do not lose this");
  });

  test("tags on a blank pad go with it when text comes", () => {
    const { store, data } = setup({ handler: never });
    store.setTags(["code"]);
    store.edit("Text");
    expect(storedPad(data, store.current().id)?.tags).toEqual(["code"]);
  });
});

describe("sync", () => {
  test("a PUT comes 800ms after the last edit", async () => {
    const api = server();
    const { store, clock } = setup({ handler: api.handler });
    store.edit("a");
    await clock.advance(500);
    store.edit("ab");
    await clock.advance(500);
    expect(api.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
    await clock.advance(300);
    expect(api.calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    expect(store.saveStatus()).toBe("saved");
  });

  test("the status is On this phone until the ack", async () => {
    const api = server();
    const { store, clock } = setup({ handler: api.handler });
    store.edit("a");
    expect(store.saveStatus()).toBe("on-this-phone");
    await clock.advance(800);
    expect(store.saveStatus()).toBe("saved");
    store.edit("ab");
    expect(store.saveStatus()).toBe("on-this-phone");
  });

  test("flush sends with keepalive", async () => {
    const inits: RequestInit[] = [];
    const { store } = setup({
      handler: (url, init) => {
        inits.push(init);
        return url.startsWith("/api/pads/") ? json({ rev: 1 }) : json([]);
      },
    });
    store.edit("Going to the background");
    store.flush();
    expect(inits).toHaveLength(1);
    expect(inits[0]?.keepalive).toBe(true);
  });

  test("a body too large for keepalive goes without it", () => {
    const inits: RequestInit[] = [];
    const { store } = setup({
      handler: (_url, init) => {
        inits.push(init);
        return json({ rev: 1 });
      },
    });
    store.edit("x".repeat(70_000));
    store.flush();
    expect(inits[0]?.keepalive).toBe(false);
  });

  test("a sync retries while the server is down, then says Saved", async () => {
    let up = false;
    const api = server();
    const { store, clock, seen } = setup({
      handler: (url, init) => (up ? api.handler(url, init) : dead(url, init)),
    });
    store.start();
    store.edit("Written with no server");
    await clock.advance(800);
    expect(store.saveStatus()).toBe("on-this-phone");
    up = true;
    await clock.advance(10_000);
    expect(store.saveStatus()).toBe("saved");
    expect(seen.back).toBe(1);
  });

  test("a server that dies after the restore gets the text when it returns", async () => {
    let up = true;
    const api = server();
    const { store, clock, seen } = setup({
      handler: (url, init) => (up ? api.handler(url, init) : dead(url, init)),
    });
    store.start();
    await clock.advance(0);
    up = false;
    store.edit("Written while the server is gone");
    await clock.advance(800);
    expect(store.saveStatus()).toBe("on-this-phone");
    up = true;
    await clock.advance(10_000);
    await clock.advance(0);
    expect(store.saveStatus()).toBe("saved");
    expect(seen.back).toBe(1);
  });

  test("a reconnect syncs at once", async () => {
    let up = false;
    const api = server();
    const { store, clock } = setup({
      handler: (url, init) => (up ? api.handler(url, init) : dead(url, init)),
    });
    store.edit("Text");
    await clock.advance(800);
    up = true;
    store.sync();
    await clock.advance(0);
    expect(store.saveStatus()).toBe("saved");
  });

  test("an edit during a save still syncs after the debounce", async () => {
    const api = server();
    let release = () => {};
    const { store, clock } = setup({
      handler: async (url, init) => {
        if (url.startsWith("/api/pads/") && api.pads.size === 0) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return api.handler(url, init);
      },
    });
    store.edit("First");
    await clock.advance(800);
    await clock.advance(0);
    store.edit("First and second");
    release();
    await clock.advance(0);
    await clock.advance(0);
    await clock.advance(800);
    await clock.advance(0);
    expect(api.pads.get(store.current().id)?.text).toBe("First and second");
    expect(store.saveStatus()).toBe("saved");
  });

  test("the ack survives a relaunch", async () => {
    const api = server();
    const journal = makeJournal();
    const first = setup({ handler: api.handler, journal });
    first.store.edit("Text");
    await first.clock.advance(800);
    const second = setup({ handler: never, journal });
    expect(second.store.saveStatus()).toBe("saved");
  });

  test("a higher rev on the server moves the phone above it", async () => {
    const api = server([makePad({ rev: 9, text: "Old copy" })]);
    const journal = makeJournal();
    journal.data.set("pad:pad-00000001", JSON.stringify(makePad({ rev: 2 })));
    journal.data.set("current", padId(1));
    const { store, clock } = setup({
      handler: (url, init) =>
        url === "/api/pads" ? json([]) : api.handler(url, init),
      journal,
    });
    store.edit("The phone owns this");
    store.start();
    await clock.advance(0);
    await clock.advance(800);
    await clock.advance(0);
    expect(api.pads.get(padId(1))?.text).toBe("The phone owns this");
    expect(store.saveStatus()).toBe("saved");
  });
});

describe("a 401", () => {
  const denied: Handler = () => json(null, 401);

  test("it goes to pair and keeps the text", async () => {
    const { store, clock, data, seen } = setup({ handler: denied });
    store.edit("Keep me");
    await clock.advance(800);
    expect(seen.denied).toBe(1);
    expect(storedPad(data, store.current().id)?.text).toBe("Keep me");
    expect(store.saveStatus()).toBe("on-this-phone");
  });

  test("sync stops until the app pairs again", async () => {
    let paired = false;
    const api = server();
    const { store, clock, seen } = setup({
      handler: (url, init) => {
        if (url === "/api/pair") {
          paired = true;
          return json(null);
        }
        return paired ? api.handler(url, init) : denied(url, init);
      },
    });
    store.edit("Keep me");
    await clock.advance(800);
    await clock.advance(60_000);
    expect(seen.denied).toBe(1);
    expect((await store.pair("token")).kind).toBe("paired");
    await clock.advance(0);
    await clock.advance(0);
    expect(store.saveStatus()).toBe("saved");
  });

  test("a wrong token is not a denial of the session", async () => {
    const { store, seen } = setup({ handler: denied });
    expect((await store.pair("bad")).kind).toBe("wrong-token");
    expect(seen.denied).toBe(0);
  });

  test("no server is a pair failure", async () => {
    const down = setup({ handler: dead });
    expect((await down.store.pair("x")).kind).toBe("no-server");
  });
});

describe("the session refresh", () => {
  const onlySession = (answer: Handler) => {
    const api = server();
    const handler: Handler = (url, init) =>
      url === "/api/session" ? answer(url, init) : api.handler(url, init);
    return { api, handler };
  };

  test("a launch calls it once, and a later sync does not", async () => {
    const api = server();
    const { store, clock } = setup({ handler: api.handler });
    store.start();
    await clock.advance(0);
    store.sync();
    await clock.advance(0);
    expect(
      api.calls.filter((call) => call === "GET /api/session"),
    ).toHaveLength(1);
  });

  test("a launch with no network does not call it", async () => {
    const api = server();
    const { store, clock } = setup({ handler: api.handler, online: false });
    store.start();
    await clock.advance(0);
    expect(api.calls).not.toContain("GET /api/session");
    expect(api.calls).toContain("GET /api/pads");
  });

  test("a 401 goes to pair and keeps the text", async () => {
    const journal = makeJournal();
    const first = setup({ handler: never, journal });
    first.store.edit("Keep me");
    const { api, handler } = onlySession(() => json(null, 401));
    const { store, clock, seen } = setup({ handler, journal });
    store.start();
    await clock.advance(0);
    await clock.advance(800);
    expect(seen.denied).toBe(1);
    expect(storedPad(journal.data, store.current().id)?.text).toBe("Keep me");
    expect(api.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
  });

  test("a call that never answers holds back no typing and no save", async () => {
    const { api, handler } = onlySession(never);
    const { store, clock, data } = setup({ handler });
    store.start();
    expect(api.calls).toContain("GET /api/pads");
    store.edit("Typed at once");
    expect(storedPad(data, store.current().id)?.text).toBe("Typed at once");
    await clock.advance(800);
    await clock.advance(0);
    expect(api.pads.get(store.current().id)?.text).toBe("Typed at once");
    expect(store.saveStatus()).toBe("saved");
  });

  test.each<[string, Handler]>([
    ["a dead network", dead],
    ["a 500", () => json(null, 500)],
  ])("%s does nothing", async (_name, answer) => {
    const { handler } = onlySession(answer);
    const { store, clock, seen } = setup({ handler });
    store.start();
    await clock.advance(0);
    await clock.advance(0);
    store.edit("Text");
    await clock.advance(800);
    await clock.advance(0);
    expect(seen.denied).toBe(0);
    expect(seen.back).toBe(0);
    expect(store.saveStatus()).toBe("saved");
  });
});

describe("no server answer deletes a pad", () => {
  test("an empty list keeps every local pad", async () => {
    const journal = makeJournal();
    const first = setup({ handler: never, journal });
    first.store.edit("Only on the phone");
    const id = first.store.current().id;
    const second = setup({ handler: () => json([]), journal });
    second.store.start();
    await second.clock.advance(0);
    expect(storedPad(journal.data, id)?.text).toBe("Only on the phone");
  });

  test.each([401, 404, 500])("status %i keeps the pad", async (status) => {
    const { store, clock, data } = setup({
      handler: () => json(null, status),
    });
    store.edit("Text");
    await clock.advance(800);
    expect(storedPad(data, store.current().id)?.text).toBe("Text");
  });
});

describe("retry", () => {
  test("prove tries a killed fetch again", async () => {
    let calls = 0;
    const { store, clock } = setup({
      handler: () => {
        calls++;
        return calls === 1
          ? Promise.reject(new TypeError("Load failed"))
          : json({ kind: "proved", sha: SHA, url: "https://p/" });
      },
    });
    store.edit("Text");
    const outcome = store.prove();
    await clock.advance(0);
    await clock.advance(500);
    expect((await outcome).kind).toBe("answer");
    expect(calls).toBe(2);
  });

  test("prove gives up as unreachable after three tries", async () => {
    let calls = 0;
    const { store, clock } = setup({
      handler: (url) => {
        if (url === "/api/prove") calls++;
        return Promise.reject(new TypeError("Load failed"));
      },
    });
    store.edit("Text");
    const outcome = store.prove();
    await clock.advance(0);
    await clock.advance(500);
    await clock.advance(1500);
    expect((await outcome).kind).toBe("unreachable");
    expect(calls).toBe(3);
  });

  test("a bad answer is a server error, not a guess", async () => {
    const { store } = setup({ handler: () => json({ kind: "nonsense" }) });
    expect((await store.prove()).kind).toBe("server-error");
  });
});

describe("ship", () => {
  const openShipping = (args: { handler: Handler }) => {
    const journal = makeJournal();
    journal.data.set(
      `pad:${padId(1)}`,
      JSON.stringify(makePad({ stage: { kind: "shipping", sha: SHA } })),
    );
    journal.data.set("current", padId(1));
    return setup({ handler: args.handler, journal });
  };

  test("the stage is saved before the ship call", async () => {
    const log: string[] = [];
    let stageAtCall: unknown;
    const api = server([], () => ({
      kind: "pushed",
      url: URL_LIVE,
      slug: SLUG,
    }));
    const journal = makeJournal(log);
    const { store, clock } = setup({
      handler: (url, init) => {
        if (url === "/api/ship") {
          stageAtCall = storedPad(journal.data, store.current().id)?.stage;
        }
        return api.handler(url, init);
      },
      journal,
      log,
    });
    store.edit("Publish me");
    store.beginShip(SHA);
    expect(storedPad(journal.data, store.current().id)?.stage).toEqual({
      kind: "shipping",
      sha: SHA,
    });
    await clock.advance(0);
    await clock.advance(0);
    expect(stageAtCall).toEqual({ kind: "shipping", sha: SHA });
  });

  test("the stage survives a fetch that never resolves", () => {
    const journal = makeJournal();
    const { store } = setup({ handler: never, journal });
    store.edit("Publish me");
    store.beginShip(SHA);
    const second = setup({ handler: never, journal });
    expect(second.store.current().stage).toEqual({
      kind: "shipping",
      sha: SHA,
    });
  });

  test("a save that the server rejects does not stop a publish", async () => {
    const api = server([], () => ({ kind: "live", url: URL_LIVE, slug: SLUG }));
    const journal = makeJournal();
    const rejected = makePad({ id: padId(2), text: "The server hates this" });
    journal.data.set(`pad:${rejected.id}`, JSON.stringify(rejected));
    journal.data.set(
      `pad:${padId(1)}`,
      JSON.stringify(makePad({ stage: { kind: "shipping", sha: SHA } })),
    );
    journal.data.set("current", padId(1));
    const { store, clock, seen } = setup({
      handler: (url, init) =>
        url === `/api/pads/${rejected.id}`
          ? json(null, 500)
          : api.handler(url, init),
      journal,
    });
    store.start();
    await clock.advance(0);
    await clock.advance(0);
    await clock.advance(0);
    expect(seen.shipAnswers.map((a) => a.kind)).toEqual(["live"]);
  });

  test("a rejected save tries again later", async () => {
    let up = false;
    const api = server();
    const { store, clock } = setup({
      handler: (url, init) =>
        url.startsWith("/api/pads/") && !up
          ? json(null, 500)
          : api.handler(url, init),
    });
    store.start();
    await clock.advance(0);
    store.edit("Text");
    await clock.advance(800);
    expect(store.saveStatus()).toBe("on-this-phone");
    up = true;
    await clock.advance(10_000);
    expect(store.saveStatus()).toBe("saved");
  });

  test("a launch finishes a pad in shipping", async () => {
    const api = server([], () => ({
      kind: "pushed",
      url: URL_LIVE,
      slug: SLUG,
    }));
    const { store, clock, data, seen } = openShipping({ handler: api.handler });
    store.start();
    await clock.advance(0);
    await clock.advance(0);
    expect(api.calls).toContain("POST /api/ship");
    expect(seen.shipAnswers.map((a) => a.kind)).toEqual(["pushed"]);
    const pad = storedPad(data, padId(1));
    expect(pad?.stage).toEqual({
      kind: "published",
      slug: SLUG,
      sha: SHA,
      url: URL_LIVE,
    });
    expect(pad?.target).toEqual({ kind: "revise", slug: SLUG, from: SHA });
  });

  test("a dead network keeps the stage, and a later try finishes", async () => {
    let up = false;
    const api = server([], () => ({ kind: "live", url: URL_LIVE, slug: SLUG }));
    const { store, clock, seen, data } = openShipping({
      handler: (url, init) => (up ? api.handler(url, init) : dead(url, init)),
    });
    store.start();
    await clock.advance(0);
    expect(storedPad(data, padId(1))?.stage.kind).toBe("shipping");
    up = true;
    await clock.advance(10_000);
    await clock.advance(0);
    await clock.advance(0);
    expect(seen.shipAnswers.map((a) => a.kind)).toEqual(["live"]);
    expect(storedPad(data, padId(1))?.stage.kind).toBe("published");
  });

  test("origin-unreachable keeps the stage for the next try", async () => {
    const api = server([], () => ({ kind: "origin-unreachable" }));
    const { store, clock, data } = openShipping({ handler: api.handler });
    store.start();
    await clock.advance(0);
    await clock.advance(0);
    expect(storedPad(data, padId(1))?.stage.kind).toBe("shipping");
  });

  test.each(["stale", "not-proven"] as const)(
    "%s returns the pad to writing with its text",
    async (kind) => {
      const api = server([], () => ({ kind }));
      const { store, clock, data } = openShipping({ handler: api.handler });
      store.start();
      await clock.advance(0);
      await clock.advance(0);
      const pad = storedPad(data, padId(1));
      expect(pad?.stage).toEqual({ kind: "writing" });
      expect(pad?.text).toBe("A thought");
    },
  );

  test("settleShip leaves a pad that is not in shipping", () => {
    const pad = makePad();
    expect(settleShip(pad, { kind: "live", url: URL_LIVE, slug: SLUG })).toBe(
      pad,
    );
  });

  test("an edit after publish is a fix of the same post", async () => {
    const api = server([], () => ({ kind: "live", url: URL_LIVE, slug: SLUG }));
    const { store, clock, data } = openShipping({ handler: api.handler });
    store.start();
    await clock.advance(0);
    await clock.advance(0);
    store.edit("A thought, fixed");
    const pad = storedPad(data, padId(1));
    expect(pad?.stage).toEqual({ kind: "writing" });
    expect(pad?.target).toEqual({ kind: "revise", slug: SLUG, from: SHA });
  });
});

describe("launch", () => {
  const padAt = (minutesAgo: number, change: Partial<Pad> = {}) =>
    makePad({
      updatedAt: new Date(START - minutesAgo * MINUTE).toISOString(),
      ...change,
    });

  test("a pad edited 9 minutes ago resumes", () => {
    const pad = padAt(9);
    expect(pickCurrent({ pad, now: START })).toBe(pad);
  });

  test("a pad edited 11 minutes ago does not resume", () => {
    expect(pickCurrent({ pad: padAt(11), now: START })).toBeUndefined();
  });

  test("a published or discarded pad does not resume", () => {
    expect(
      pickCurrent({
        pad: padAt(1, {
          stage: { kind: "published", slug: SLUG, sha: SHA, url: URL_LIVE },
        }),
        now: START,
      }),
    ).toBeUndefined();
    expect(
      pickCurrent({
        pad: padAt(1, { stage: { kind: "discarded" } }),
        now: START,
      }),
    ).toBeUndefined();
  });

  test("an old pad stays in the list while a blank pad opens", () => {
    const journal = makeJournal();
    const pad = padAt(30, { id: padId(8) });
    journal.data.set(`pad:${pad.id}`, JSON.stringify(pad));
    journal.data.set("current", pad.id);
    const { store } = setup({ handler: never, journal });
    expect(store.current().text).toBe("");
    expect(store.current().id).not.toBe(pad.id);
    expect(store.all().map((p) => p.id)).toContain(pad.id);
  });

  test("bad JSON in storage does not stop the launch", () => {
    const journal = makeJournal();
    journal.data.set("pad:broken", "{not json");
    const { store } = setup({ handler: never, journal });
    expect(store.current().text).toBe("");
    expect(journal.data.has("pad:broken")).toBe(true);
  });
});

describe("mergePads", () => {
  test("the highest rev wins", () => {
    const local = makePad({ rev: 3, text: "local" });
    const remote = makePad({ rev: 5, text: "remote" });
    expect(mergePads([local], [remote])).toEqual([remote]);
    expect(mergePads([remote], [local])).toEqual([remote]);
  });

  test("an equal rev keeps the phone's copy", () => {
    const local = makePad({ rev: 3, text: "local" });
    expect(mergePads([local], [makePad({ rev: 3, text: "remote" })])).toEqual([
      local,
    ]);
  });

  test("a missing pad comes in", () => {
    const remote = makePad({ id: padId(2) });
    expect(mergePads([], [remote])).toEqual([remote]);
  });

  test("a pad that only the phone has stays", () => {
    const local = makePad();
    expect(mergePads([local], [])).toEqual([local]);
  });

  test("a blank pad from the server stays out", () => {
    expect(mergePads([], [makePad({ text: "  " })])).toEqual([]);
  });

  test("a restore after storage loss brings the pads back", async () => {
    const lost = makePad({ id: padId(5), rev: 7, text: "From the server" });
    const api = server([lost]);
    const { store, clock, data } = setup({ handler: api.handler });
    store.start();
    await clock.advance(0);
    expect(storedPad(data, lost.id)?.text).toBe("From the server");
    expect(store.all().map((p) => p.id)).toContain(lost.id);
  });

  test("a higher rev of the open pad replaces the text", async () => {
    const journal = makeJournal();
    const local = makePad({ rev: 2 });
    journal.data.set(`pad:${local.id}`, JSON.stringify(local));
    journal.data.set("current", local.id);
    const api = server([makePad({ rev: 4, text: "Newer" })]);
    const { store, clock, seen } = setup({ handler: api.handler, journal });
    store.start();
    await clock.advance(0);
    expect(store.current().text).toBe("Newer");
    expect(seen.replaced.map((p) => p.text)).toEqual(["Newer"]);
  });
});

describe("the earlier list", () => {
  const published = (id: number, updatedAt: string) =>
    makePad({
      id: padId(id),
      updatedAt,
      stage: { kind: "published", slug: SLUG, sha: SHA, url: URL_LIVE },
    });

  test("it counts unpublished non-blank pads other than the open one", () => {
    const pads = [
      makePad({ id: padId(1) }),
      makePad({ id: padId(2) }),
      makePad({ id: padId(3), text: "  " }),
      makePad({ id: padId(4), stage: { kind: "discarded" } }),
      makePad({ id: padId(5), stage: { kind: "shipping", sha: SHA } }),
      published(6, new Date(START).toISOString()),
    ];
    const rows = earlierRows({ pads, current: padId(1) });
    expect(earlierCount(rows)).toBe(2);
    expect(rows.map((row) => row.kind).sort()).toEqual([
      "draft",
      "published",
      "sending",
    ]);
  });

  test("the newest comes first", () => {
    const rows = earlierRows({
      pads: [
        published(1, "2026-10-01T00:00:00.000Z"),
        makePad({ id: padId(2), updatedAt: "2026-10-03T00:00:00.000Z" }),
        published(3, "2026-10-02T00:00:00.000Z"),
      ],
      current: padId(9),
    });
    expect(rows.map((row) => row.pad.id)).toEqual([
      padId(2),
      padId(3),
      padId(1),
    ]);
  });

  test("Discard sets the stage and does not delete", () => {
    const journal = makeJournal();
    const old = makePad({ id: padId(7) });
    journal.data.set(`pad:${old.id}`, JSON.stringify(old));
    const { store } = setup({ handler: never, journal });
    store.discard(old.id);
    expect(storedPad(journal.data, old.id)?.stage).toEqual({
      kind: "discarded",
    });
    expect(storedPad(journal.data, old.id)?.text).toBe("A thought");
  });

  test("a pad in shipping cannot be discarded", () => {
    const journal = makeJournal();
    const old = makePad({
      id: padId(7),
      stage: { kind: "shipping", sha: SHA },
    });
    journal.data.set(`pad:${old.id}`, JSON.stringify(old));
    const { store } = setup({ handler: never, journal });
    store.discard(old.id);
    expect(storedPad(journal.data, old.id)?.stage.kind).toBe("shipping");
  });
});

describe("tags", () => {
  test("a new tag is lowercased and trimmed", () => {
    expect(normalizeTag("  Unraid ")).toBe("unraid");
  });

  test("the chips are the known tags, then the pad's own", () => {
    expect(chipTags({ known: ["a", "b"], selected: ["b", "c"] })).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("the last list stays for a launch with no server", async () => {
    const journal = makeJournal();
    const api = server();
    const first = setup({ handler: api.handler, journal });
    first.store.start();
    await first.clock.advance(0);
    await first.clock.advance(0);
    const second = setup({ handler: dead, journal });
    expect(second.store.tags()).toEqual(["code", "notes"]);
  });
});

describe("parsers", () => {
  test("parseProved reads each shape", () => {
    expect(parseProved({ kind: "proved", sha: SHA, url: "u" })?.kind).toBe(
      "proved",
    );
    expect(
      parseProved({
        kind: "refused",
        why: { kind: "toolchain", need: "bun" },
      }),
    ).toEqual({ kind: "refused", why: { kind: "toolchain", need: "bun" } });
    expect(parseProved({ kind: "proved", sha: "short", url: "u" })).toBe(
      undefined,
    );
    expect(parseProved({ kind: "refused", why: { kind: "nope" } })).toBe(
      undefined,
    );
  });

  test("parseShipStatus reads each shape", () => {
    expect(parseShipStatus({ kind: "stale" })).toEqual({ kind: "stale" });
    expect(parseShipStatus({ kind: "live", url: "u", slug: "a-post" })).toEqual(
      { kind: "live", url: "u", slug: "a-post" as Slug },
    );
    expect(parseShipStatus({ kind: "live", url: "u" })).toBeUndefined();
  });
});
