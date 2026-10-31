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
  canDiscard,
  chipTags,
  createStore,
  earlierCount,
  earlierRows,
  meetRemote,
  normalizeTag,
  pickCurrent,
  saveCopy,
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
      if (kept && kept.rev >= pad.rev) {
        return json({
          rev: kept.rev,
          same:
            kept.text === pad.text &&
            JSON.stringify(kept.tags) === JSON.stringify(pad.tags),
        });
      }
      pads.set(pad.id, pad);
      return json({ rev: pad.rev, same: true });
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
  firstId?: number;
  changed?: () => void;
  shipAnswered?: () => void;
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
    forked: [] as Pad[],
  };
  let ids = args.firstId ?? 1;
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
      changed: () => args.changed?.(),
      denied: () => {
        seen.denied++;
      },
      serverBack: () => {
        seen.back++;
      },
      shipAnswered: (_id, answer) => {
        args.shipAnswered?.();
        seen.shipAnswers.push(answer);
      },
      shipFailed: (_id, problem) => seen.shipFailures.push(problem),
      currentReplaced: (pad) => seen.replaced.push(pad),
      currentForked: (pad) => seen.forked.push(pad),
    },
  };
  return { store: createStore(deps), clock, data, log, seen };
};

const never: Handler = () => new Promise(() => {});
const dead: Handler = () => Promise.reject(new TypeError("Load failed"));

const settled = async (clock: ReturnType<typeof makeClock>) => {
  for (let step = 0; step < 6; step++) await clock.advance(0);
};

const seedPad = (journal: ReturnType<typeof makeJournal>, pad: Pad) => {
  journal.data.set(`pad:${pad.id}`, JSON.stringify(pad));
};

const quotaError = () => new DOMException("full", "QuotaExceededError");

/** The journal refuses each write for which `full` is true. */
const limit = (
  { journal }: ReturnType<typeof makeJournal>,
  full: (key: string) => boolean,
) => {
  const write = journal.setItem;
  journal.setItem = (key, value) => {
    if (full(key)) throw quotaError();
    write(key, value);
  };
};

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

describe("a full journal", () => {
  const padsOf = (data: Map<string, string>) =>
    [...data.keys()].filter((key) => key.startsWith("pad:")).sort();

  test("an edit does not throw, keeps the text, and still saves to the server", async () => {
    const api = server();
    const journal = makeJournal();
    limit(journal, () => true);
    const { store, clock, data } = setup({ handler: api.handler, journal });
    store.edit("Typed with a full journal");
    expect(store.current().text).toBe("Typed with a full journal");
    expect(data.size).toBe(0);
    await clock.advance(800);
    await settled(clock);
    expect(api.pads.get(store.current().id)?.text).toBe(
      "Typed with a full journal",
    );
  });

  test("the status says Not saved on this phone, and never Saved", async () => {
    const api = server();
    const journal = makeJournal();
    limit(journal, () => true);
    const { store, clock } = setup({ handler: api.handler, journal });
    store.edit("Text");
    expect(store.saveStatus()).toBe("not-saved");
    expect(saveCopy[store.saveStatus()]).toBe("Not saved on this phone");
    await clock.advance(800);
    await settled(clock);
    expect(store.saveStatus()).toBe("not-saved");
  });

  test("a later write that fits ends the state", () => {
    let full = true;
    const journal = makeJournal();
    limit(journal, () => full);
    const { store, data } = setup({ handler: never, journal });
    store.edit("One");
    expect(store.saveStatus()).toBe("not-saved");
    full = false;
    store.edit("One and two");
    expect(store.saveStatus()).toBe("on-this-phone");
    expect(storedPad(data, store.current().id)?.text).toBe("One and two");
  });

  test("the journal gets the text after the ack when space came back", async () => {
    let full = true;
    const api = server();
    const journal = makeJournal();
    limit(journal, () => full);
    const { store, clock, data } = setup({ handler: api.handler, journal });
    store.edit("Text");
    full = false;
    await clock.advance(800);
    await settled(clock);
    expect(storedPad(data, store.current().id)?.text).toBe("Text");
    expect(store.saveStatus()).toBe("saved");
  });

  test("a second edit with no space still reaches the server", async () => {
    const api = server();
    const journal = makeJournal();
    limit(journal, () => true);
    const { store, clock } = setup({ handler: api.handler, journal });
    store.edit("One");
    await clock.advance(800);
    await settled(clock);
    store.edit("One and two");
    await clock.advance(800);
    await settled(clock);
    expect(api.pads.get(store.current().id)?.text).toBe("One and two");
  });

  const published = {
    kind: "published",
    slug: SLUG,
    sha: SHA,
    url: URL_LIVE,
  } as const;

  const seedDone = (journal: ReturnType<typeof makeJournal>) => {
    seedPad(journal, makePad({ id: padId(2), rev: 3, stage: published }));
    seedPad(
      journal,
      makePad({ id: padId(3), rev: 3, stage: { kind: "discarded" } }),
    );
    seedPad(journal, makePad({ id: padId(4), rev: 5, stage: published }));
    seedPad(
      journal,
      makePad({ id: padId(5), rev: 5, stage: { kind: "discarded" } }),
    );
    seedPad(journal, makePad({ id: padId(6), rev: 3 }));
    journal.data.set(
      "acked",
      JSON.stringify({
        [padId(2)]: 3,
        [padId(3)]: 3,
        [padId(4)]: 4,
        [padId(5)]: 4,
        [padId(6)]: 3,
      }),
    );
  };

  test("a quota failure frees acked published and discarded pads, then retries once", () => {
    const journal = makeJournal();
    seedDone(journal);
    limit(journal, () => journal.data.has(`pad:${padId(2)}`));
    const { store, data } = setup({ handler: never, journal, firstId: 7 });
    store.edit("Fits after the cleanup");
    expect(padsOf(data)).toEqual(
      [padId(4), padId(5), padId(6), padId(7)].map((id) => `pad:${id}`),
    );
    expect(store.saveStatus()).toBe("on-this-phone");
    expect(store.all().map((pad) => pad.id)).toContain(padId(2));
  });

  test("unacked text is never removed", () => {
    const journal = makeJournal();
    seedPad(journal, makePad({ id: padId(2), rev: 3 }));
    seedPad(
      journal,
      makePad({ id: padId(3), rev: 3, stage: { kind: "discarded" } }),
    );
    seedPad(journal, makePad({ id: padId(4), rev: 3, stage: published }));
    limit(journal, () => true);
    const { store, data } = setup({ handler: never, journal, firstId: 7 });
    store.edit("No room");
    expect(padsOf(data)).toEqual(
      [padId(2), padId(3), padId(4)].map((id) => `pad:${id}`),
    );
    expect(store.saveStatus()).toBe("not-saved");
  });

  test("a failed write tries the journal only twice", () => {
    let tries = 0;
    const journal = makeJournal();
    const write = journal.journal.setItem;
    journal.journal.setItem = (key, value) => {
      if (key.startsWith("pad:")) {
        tries++;
        throw quotaError();
      }
      write(key, value);
    };
    const { store } = setup({ handler: never, journal });
    store.edit("No room");
    expect(tries).toBe(2);
  });
});

describe("a throw during sync", () => {
  test("a failed ack write does not stop later saves", async () => {
    const api = server();
    const journal = makeJournal();
    let failing = false;
    limit(journal, (key) => failing && key === "acked");
    const { store, clock } = setup({ handler: api.handler, journal });
    store.start();
    await settled(clock);
    store.edit("Hello");
    await clock.advance(800);
    await settled(clock);
    failing = true;
    store.edit("Hello 2");
    await clock.advance(800);
    await settled(clock);
    expect(store.saveStatus()).toBe("saved");
    failing = false;
    store.edit("Hello 3");
    await clock.advance(800);
    await settled(clock);
    expect(api.pads.get(store.current().id)?.text).toBe("Hello 3");
  });

  test("one throw inside a run does not wedge later runs", async () => {
    const api = server();
    let bomb = false;
    const { store, clock } = setup({
      handler: api.handler,
      changed: () => {
        if (!bomb) return;
        bomb = false;
        throw new Error("a render failed");
      },
    });
    store.start();
    await settled(clock);
    store.edit("Before");
    bomb = true;
    await clock.advance(800);
    await settled(clock);
    expect(bomb).toBe(false);
    store.edit("After the throw");
    await clock.advance(800);
    await settled(clock);
    expect(api.pads.get(store.current().id)?.text).toBe("After the throw");
  });

  test("a failure in the ship step tries again on the next run", async () => {
    const answers: ShipStatus[] = [
      { kind: "origin-unreachable" },
      { kind: "live", url: URL_LIVE, slug: SLUG },
    ];
    const api = server([], () => answers.shift() ?? { kind: "stale" });
    const journal = makeJournal();
    seedPad(journal, makePad({ stage: { kind: "shipping", sha: SHA } }));
    journal.data.set("current", padId(1));
    journal.data.set("acked", JSON.stringify({ [padId(1)]: 1 }));
    let bomb = true;
    const { store, clock, data } = setup({
      handler: api.handler,
      journal,
      shipAnswered: () => {
        if (!bomb) return;
        bomb = false;
        throw new Error("a render failed");
      },
    });
    store.start();
    await settled(clock);
    expect(bomb).toBe(false);
    expect(storedPad(data, padId(1))?.stage.kind).toBe("shipping");
    await clock.advance(10_000);
    await settled(clock);
    expect(storedPad(data, padId(1))?.stage.kind).toBe("published");
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
        return url.startsWith("/api/pads/")
          ? json({ rev: 1, same: true })
          : json([]);
      },
    });
    store.edit("Going to the background");
    store.flush();
    expect(inits).toHaveLength(1);
    expect(inits[0]?.keepalive).toBe(true);
  });

  const flushed = () => {
    const sent: { id: string; keepalive: boolean | undefined }[] = [];
    const handler: Handler = (url, init) => {
      sent.push({ id: url.slice(-1), keepalive: init.keepalive });
      return new Promise(() => {});
    };
    return { sent, handler };
  };

  test("a body over the byte budget stays for the next sync, by bytes and not characters", async () => {
    const api = server();
    const { store, clock } = setup({ handler: api.handler });
    const text = "漢".repeat(25_000);
    store.edit(text);
    store.flush();
    expect(api.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
    expect(store.saveStatus()).toBe("on-this-phone");
    await clock.advance(800);
    await settled(clock);
    expect(api.pads.get(store.current().id)?.text).toBe(text);
  });

  test("a flush of a body over the budget makes no request", () => {
    const { sent, handler } = flushed();
    const { store } = setup({ handler });
    store.edit("漢".repeat(25_000));
    store.flush();
    expect(sent).toEqual([]);
  });

  test("one flush keeps the total of all pads under the budget", () => {
    const { sent, handler } = flushed();
    const journal = makeJournal();
    for (const n of [2, 3, 4]) {
      seedPad(journal, makePad({ id: padId(n), text: "é".repeat(12_000) }));
    }
    const { store } = setup({ handler, journal, firstId: 5 });
    store.flush();
    expect(sent).toHaveLength(2);
    expect(sent.every((call) => call.keepalive === true)).toBe(true);
  });

  test("the open pad goes first", () => {
    const { sent, handler } = flushed();
    const journal = makeJournal();
    seedPad(journal, makePad({ id: padId(2), text: "é".repeat(20_000) }));
    const { store } = setup({ handler, journal, firstId: 5 });
    store.edit("é".repeat(20_000));
    store.flush();
    expect(sent.map((call) => call.id)).toEqual(["5"]);
  });

  test("a small pad after a large pad still fits", () => {
    const { sent, handler } = flushed();
    const journal = makeJournal();
    seedPad(journal, makePad({ id: padId(2), text: "é".repeat(40_000) }));
    seedPad(journal, makePad({ id: padId(3), text: "small" }));
    const { store } = setup({ handler, journal, firstId: 5 });
    store.flush();
    expect(sent.map((call) => call.id)).toEqual(["3"]);
  });

  test("a second flush with the first in flight stays under the budget", () => {
    const { sent, handler } = flushed();
    const { store } = setup({ handler });
    store.edit("é".repeat(20_000));
    store.flush();
    store.flush();
    expect(sent).toHaveLength(1);
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
});

describe("two versions that disagree", () => {
  const ack = (
    journal: ReturnType<typeof makeJournal>,
    id: PadId,
    rev: number,
  ) => journal.data.set("acked", JSON.stringify({ [id]: rev }));

  /** A phone whose first pull is done, with the open pad at rev 2. */
  const online = async (args: {
    api: ReturnType<typeof server>;
    text?: string;
  }) => {
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 1, text: "Base" }));
    ack(journal, padId(1), 1);
    journal.data.set("current", padId(1));
    const phone = setup({
      handler: args.api.handler,
      journal,
      firstId: 2,
    });
    phone.store.start();
    await settled(phone.clock);
    return { ...phone, journal };
  };

  test("a PUT answer of same: false keeps both on the phone and the server", async () => {
    const api = server([makePad({ rev: 1, text: "Base" })]);
    const { store, clock, data, seen, journal } = await online({ api });
    api.pads.set(padId(1), makePad({ rev: 2, text: "From the other device" }));
    store.edit("From this phone");
    await clock.advance(800);
    await settled(clock);
    await clock.advance(800);
    await settled(clock);

    expect(store.current().text).toBe("From this phone");
    expect(store.current().id).toBe(padId(2));
    expect(store.current().target).toEqual({ kind: "new" });
    expect(store.current().stage).toEqual({ kind: "writing" });
    expect(journal.data.get("current")).toBe(padId(2));
    expect(storedPad(data, padId(1))?.text).toBe("From the other device");
    expect(storedPad(data, padId(2))?.text).toBe("From this phone");
    expect(api.pads.get(padId(1))?.text).toBe("From the other device");
    expect(api.pads.get(padId(2))?.text).toBe("From this phone");
    expect(store.saveStatus()).toBe("saved");
    expect(seen.replaced).toEqual([]);
    expect(seen.forked.map((pad) => pad.text)).toEqual(["From this phone"]);
  });

  test("the other version shows in Earlier", async () => {
    const api = server([makePad({ rev: 1, text: "Base" })]);
    const { store, clock } = await online({ api });
    api.pads.set(padId(1), makePad({ rev: 2, text: "From the other device" }));
    store.edit("From this phone");
    await clock.advance(800);
    await settled(clock);
    const rows = earlierRows({
      pads: store.all(),
      current: store.current().id,
    });
    expect(rows.map((row) => row.pad.text)).toEqual(["From the other device"]);
  });

  test("the copy of a half-done Fix is a new post, and the original keeps the target", async () => {
    const target = { kind: "revise", slug: SLUG, from: SHA } as const;
    const api = server([makePad({ rev: 1, text: "Base", target })]);
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 1, text: "Base", target }));
    ack(journal, padId(1), 1);
    journal.data.set("current", padId(1));
    const { store, clock } = setup({
      handler: api.handler,
      journal,
      firstId: 2,
    });
    store.start();
    await settled(clock);
    api.pads.set(padId(1), makePad({ rev: 2, text: "Other", target }));
    store.edit("Mine");
    await clock.advance(800);
    await settled(clock);
    expect(store.current().target).toEqual({ kind: "new" });
    expect(storedPad(journal.data, padId(1))?.target).toEqual(target);
  });

  test("a fork of a pad that is not open leaves the editor alone", async () => {
    const api = server([makePad({ rev: 3, text: "Other" })]);
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 2, text: "Mine, unsent" }));
    const { store, clock, seen } = setup({
      handler: api.handler,
      journal,
      firstId: 2,
    });
    store.edit("The open pad");
    store.start();
    await settled(clock);
    expect(store.current().text).toBe("The open pad");
    expect(store.current().id).toBe(padId(2));
    expect(seen.forked).toEqual([]);
    const rows = earlierRows({
      pads: store.all(),
      current: store.current().id,
    });
    expect(rows.map((row) => row.pad.text).sort()).toEqual([
      "Mine, unsent",
      "Other",
    ]);
  });

  test("a merge with a higher server rev keeps unacked text", async () => {
    const api = server([makePad({ rev: 5, text: "Newer on the server" })]);
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 2, text: "Written offline" }));
    ack(journal, padId(1), 1);
    journal.data.set("current", padId(1));
    const { store, clock, data, seen } = setup({
      handler: api.handler,
      journal,
      firstId: 2,
    });
    store.start();
    await settled(clock);
    await clock.advance(800);
    await settled(clock);
    expect(store.current().text).toBe("Written offline");
    expect(storedPad(data, padId(1))?.text).toBe("Newer on the server");
    expect(api.pads.get(padId(2))?.text).toBe("Written offline");
    expect(seen.replaced).toEqual([]);
  });

  test("a merge at an equal rev with other text keeps both", async () => {
    const api = server([makePad({ rev: 2, text: "B text" })]);
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 2, text: "A text" }));
    ack(journal, padId(1), 1);
    journal.data.set("current", padId(1));
    const { store, clock, data } = setup({
      handler: api.handler,
      journal,
      firstId: 2,
    });
    store.start();
    await settled(clock);
    await clock.advance(800);
    await settled(clock);
    expect(store.current().text).toBe("A text");
    expect(storedPad(data, padId(1))?.text).toBe("B text");
    expect(api.pads.get(padId(2))?.text).toBe("A text");
    expect(store.saveStatus()).toBe("saved");
  });

  test("a merge with no unacked text takes the higher rev and makes no copy", async () => {
    const api = server([makePad({ rev: 4, text: "Newer" })]);
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 2 }));
    ack(journal, padId(1), 2);
    journal.data.set("current", padId(1));
    const { store, clock, seen } = setup({
      handler: api.handler,
      journal,
      firstId: 2,
    });
    store.start();
    await settled(clock);
    expect(store.current().text).toBe("Newer");
    expect(store.all()).toHaveLength(1);
    expect(seen.replaced.map((pad) => pad.text)).toEqual(["Newer"]);
  });

  test("a failed read of the other version keeps the text in place and tries again", async () => {
    const api = server([makePad({ rev: 1, text: "Base" })]);
    let listFails = false;
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 1, text: "Base" }));
    ack(journal, padId(1), 1);
    journal.data.set("current", padId(1));
    const { store, clock, data } = setup({
      handler: (url, init) =>
        url === "/api/pads" && listFails
          ? json(null, 500)
          : api.handler(url, init),
      journal,
      firstId: 2,
    });
    store.start();
    await settled(clock);
    api.pads.set(padId(1), makePad({ rev: 5, text: "Other" }));
    listFails = true;
    store.edit("Mine");
    await clock.advance(800);
    await settled(clock);
    expect(store.current().id).toBe(padId(1));
    expect(storedPad(data, padId(1))?.text).toBe("Mine");
    expect(store.saveStatus()).toBe("on-this-phone");
    listFails = false;
    await clock.advance(10_000);
    await settled(clock);
    expect(store.current().id).toBe(padId(2));
    expect(storedPad(data, padId(1))?.text).toBe("Other");
    expect(storedPad(data, padId(2))?.text).toBe("Mine");
  });

  test("equal text at a higher server rev is no conflict, and later edits still go out", async () => {
    const api = server([makePad({ rev: 1, text: "Base" })]);
    const { store, clock, seen } = await online({ api });
    api.pads.set(padId(1), makePad({ rev: 9, text: "Same words" }));
    store.edit("Same words");
    await clock.advance(800);
    await settled(clock);
    expect(store.all()).toHaveLength(1);
    expect(store.saveStatus()).toBe("saved");
    expect(seen.forked).toEqual([]);
    store.edit("Same words, and more");
    expect(store.saveStatus()).toBe("on-this-phone");
    await clock.advance(800);
    await settled(clock);
    expect(api.pads.get(padId(1))?.text).toBe("Same words, and more");
    expect(store.all()).toHaveLength(1);
  });

  test("an edit during the PUT of equal text survives the rev move", async () => {
    const api = server([makePad({ rev: 1, text: "Base" })]);
    let release = () => {};
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 1, text: "Base" }));
    ack(journal, padId(1), 1);
    journal.data.set("current", padId(1));
    let hold = true;
    const { store, clock } = setup({
      handler: async (url, init) => {
        if (hold && url.startsWith("/api/pads/")) {
          hold = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return api.handler(url, init);
      },
      journal,
      firstId: 2,
    });
    store.start();
    await settled(clock);
    api.pads.set(padId(1), makePad({ rev: 9, text: "Same words" }));
    store.edit("Same words");
    await clock.advance(800);
    await settled(clock);
    store.edit("Same words, and more");
    release();
    await settled(clock);
    await clock.advance(800);
    await settled(clock);
    expect(store.all()).toHaveLength(1);
    expect(api.pads.get(padId(1))?.text).toBe("Same words, and more");
  });

  test("equal text at an equal rev acks in a merge", async () => {
    const api = server([makePad({ rev: 2, text: "Same" })]);
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 2, text: "Same" }));
    journal.data.set("current", padId(1));
    const { store, clock } = setup({
      handler: api.handler,
      journal,
      firstId: 2,
    });
    store.start();
    await settled(clock);
    expect(store.saveStatus()).toBe("saved");
    expect(store.all()).toHaveLength(1);
    expect(api.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
  });

  test("the rev of the phone does not pass the server to win", async () => {
    const api = server([makePad({ rev: 1, text: "Base" })]);
    const { store, clock } = await online({ api });
    api.pads.set(padId(1), makePad({ rev: 9, text: "Old copy" }));
    store.edit("The phone owns this");
    await clock.advance(800);
    await settled(clock);
    await clock.advance(20_000);
    await settled(clock);
    expect(api.pads.get(padId(1))).toMatchObject({ rev: 9, text: "Old copy" });
  });

  test("a fork of a fork ends, and each conflict makes one copy", async () => {
    const api = server([makePad({ rev: 1, text: "Base" })]);
    const { store, clock } = await online({ api });
    api.pads.set(padId(1), makePad({ rev: 2, text: "Other" }));
    store.edit("Mine");
    await clock.advance(800);
    await settled(clock);
    await clock.advance(800);
    await settled(clock);
    const copy = store.current().id;
    expect(copy).toBe(padId(2));

    api.pads.set(copy, { ...api.pads.get(copy)!, rev: 7, text: "Other 2" });
    store.edit("Mine 2");
    await clock.advance(800);
    await settled(clock);
    await clock.advance(800);
    await settled(clock);
    expect(store.current().id).toBe(padId(3));
    expect(store.current().text).toBe("Mine 2");
    expect(store.saveStatus()).toBe("saved");

    const count = store.all().length;
    const puts = api.calls.length;
    await clock.advance(60_000);
    await settled(clock);
    expect(store.all()).toHaveLength(count);
    expect(count).toBe(3);
    expect(api.calls.length).toBe(puts);
  });

  test("identical text is not copied twice", async () => {
    const api = server([makePad({ rev: 1, text: "Base" })]);
    const { store, clock } = await online({ api });
    api.pads.set(padId(1), makePad({ rev: 2, text: "Other" }));
    store.edit("Mine");
    await clock.advance(800);
    await settled(clock);
    await clock.advance(800);
    await settled(clock);
    expect(store.current().id).toBe(padId(2));

    expect(store.openPad(padId(1))?.text).toBe("Other");
    api.pads.set(padId(1), makePad({ rev: 9, text: "Other again" }));
    store.edit("Mine");
    await clock.advance(800);
    await settled(clock);
    expect(store.current().id).toBe(padId(2));
    expect(store.current().text).toBe("Mine");
    expect(store.all().filter((pad) => pad.text === "Mine")).toHaveLength(1);
    expect(
      store
        .all()
        .map((pad) => pad.text)
        .sort(),
    ).toEqual(["Mine", "Other again"]);
  });

  test("a stale tab keeps the busier tab's text and its own", async () => {
    const api = server();
    const journal = makeJournal();
    const a = setup({ handler: api.handler, journal });
    a.store.start();
    await settled(a.clock);
    a.store.edit("Shared draft");
    await a.clock.advance(800);
    await settled(a.clock);
    const b = setup({ handler: api.handler, journal, firstId: 50 });
    b.store.start();
    await settled(b.clock);
    const id = a.store.current().id;
    expect(b.store.current().id).toBe(id);

    for (const n of [1, 2, 3, 4]) a.store.edit(`Long paragraph ${n}`);
    await a.clock.advance(800);
    await settled(a.clock);
    b.store.edit("B one word");

    expect(storedPad(journal.data, id)?.text).toBe("Long paragraph 4");
    expect(b.store.current().id).toBe(padId(50));
    expect(b.store.current().text).toBe("B one word");
    expect(storedPad(journal.data, padId(50))?.text).toBe("B one word");
    expect(b.seen.replaced).toEqual([]);
    expect(b.seen.forked.map((pad) => pad.text)).toEqual(["B one word"]);

    await b.clock.advance(800);
    await settled(b.clock);
    expect(api.pads.get(id)?.text).toBe("Long paragraph 4");
    expect(api.pads.get(padId(50))?.text).toBe("B one word");
  });

  test("two tabs at one rev with other text keep both", () => {
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 1, text: "Base" }));
    journal.data.set("current", padId(1));
    const a = setup({ handler: never, journal, firstId: 10 });
    const b = setup({ handler: never, journal, firstId: 20 });
    a.store.edit("A");
    b.store.edit("B");
    expect(storedPad(journal.data, padId(1))?.text).toBe("A");
    expect(storedPad(journal.data, padId(20))?.text).toBe("B");
  });

  test("a tab with equal text and an older rev makes no copy and keeps the rev rising", () => {
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 1, text: "Base" }));
    journal.data.set("current", padId(1));
    const a = setup({ handler: never, journal, firstId: 10 });
    const b = setup({ handler: never, journal, firstId: 20 });
    a.store.edit("x");
    a.store.edit("Same");
    b.store.edit("Same");
    expect(b.store.current().id).toBe(padId(1));
    expect(b.store.current().rev).toBe(4);
    expect(storedPad(journal.data, padId(1))?.rev).toBe(4);
    expect(b.seen.forked).toEqual([]);
  });

  test("a pull does not lower a rev that another tab wrote", async () => {
    const api = server([makePad({ rev: 3, text: "Server" })]);
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 1, text: "Base" }));
    ack(journal, padId(1), 1);
    const b = setup({ handler: api.handler, journal, firstId: 20 });
    seedPad(journal, makePad({ rev: 8, text: "Another tab, unsent" }));
    b.store.start();
    await settled(b.clock);
    expect(storedPad(journal.data, padId(1))?.text).toBe("Another tab, unsent");
  });

  test("the copy reaches the journal before the other version replaces the local text", async () => {
    const api = server([makePad({ rev: 3, text: "Other" })]);
    const journal = makeJournal();
    seedPad(journal, makePad({ rev: 2, text: "Mine" }));
    journal.data.set("current", padId(1));
    limit(journal, (key) => key === `pad:${padId(2)}`);
    const { store, clock } = setup({
      handler: api.handler,
      journal,
      firstId: 2,
    });
    store.start();
    await settled(clock);
    expect(store.current().text).toBe("Mine");
    expect(storedPad(journal.data, padId(1))?.text).toBe("Mine");
  });

  test("a pad in shipping that forks does not ship", async () => {
    const api = server([makePad({ rev: 1, text: "Base" })], () => ({
      kind: "live",
      url: URL_LIVE,
      slug: SLUG,
    }));
    const { store, clock } = await online({ api });
    api.pads.set(padId(1), makePad({ rev: 5, text: "Other" }));
    store.edit("Mine");
    store.beginShip(SHA);
    await settled(clock);
    expect(store.current().text).toBe("Mine");
    expect(store.current().stage).toEqual({ kind: "writing" });
    expect(api.calls).not.toContain("POST /api/ship");
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

  test("New thought on the pushed screen leaves the pad published", async () => {
    const api = server([], () => ({
      kind: "pushed",
      url: URL_LIVE,
      slug: SLUG,
    }));
    const journal = makeJournal();
    seedPad(journal, makePad({ stage: { kind: "shipping", sha: SHA } }));
    journal.data.set("current", padId(1));
    const { store, clock, seen } = setup({
      handler: api.handler,
      journal,
      firstId: 2,
    });
    store.start();
    await settled(clock);
    expect(seen.shipAnswers.map((a) => a.kind)).toEqual(["pushed"]);
    store.newPad();
    await clock.advance(60_000);
    await settled(clock);
    expect(storedPad(journal.data, padId(1))?.stage).toEqual({
      kind: "published",
      slug: SLUG,
      sha: SHA,
      url: URL_LIVE,
    });
    expect(api.calls.filter((call) => call === "POST /api/ship")).toHaveLength(
      1,
    );
    const next = setup({ handler: api.handler, journal, firstId: 3 });
    next.store.start();
    await settled(next.clock);
    expect(
      next.store.all().find((pad) => pad.id === padId(1))?.stage.kind,
    ).toBe("published");
    expect(api.calls.filter((call) => call === "POST /api/ship")).toHaveLength(
      1,
    );
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

describe("meetRemote", () => {
  const meet = (args: {
    mine?: Pad;
    remote: Pad;
    unacked?: boolean;
    disputed?: boolean;
  }) =>
    meetRemote({
      mine: args.mine,
      remote: args.remote,
      unacked: args.unacked ?? false,
      disputed: args.disputed ?? false,
    });

  test("the higher rev of acked text wins", () => {
    const local = makePad({ rev: 3, text: "local" });
    const remote = makePad({ rev: 5, text: "remote" });
    expect(meet({ mine: local, remote })).toBe("take-remote");
    expect(meet({ mine: remote, remote: local })).toBe("keep-mine");
  });

  test("an equal rev of acked text keeps the phone's copy", () => {
    const local = makePad({ rev: 3, text: "local" });
    const remote = makePad({ rev: 3, text: "remote" });
    expect(meet({ mine: local, remote })).toBe("keep-mine");
  });

  test("a higher or equal server rev of other text keeps both", () => {
    const local = makePad({ rev: 3, text: "local" });
    for (const rev of [3, 5]) {
      const remote = makePad({ rev, text: "remote" });
      expect(meet({ mine: local, remote, unacked: true })).toBe("keep-both");
    }
  });

  test("a lower server rev leaves unacked text to its PUT", () => {
    const local = makePad({ rev: 3, text: "local" });
    const remote = makePad({ rev: 2, text: "remote" });
    expect(meet({ mine: local, remote, unacked: true })).toBe("keep-mine");
  });

  test("a PUT answer of same: false keeps both at any rev", () => {
    const local = makePad({ rev: 3, text: "local" });
    const remote = makePad({ rev: 2, text: "remote" });
    expect(meet({ mine: local, remote, disputed: true })).toBe("keep-both");
  });

  test("equal text and tags never disagree", () => {
    const local = makePad({ rev: 3, tags: ["a"] });
    const remote = makePad({ rev: 9, tags: ["a"] });
    expect(meet({ mine: local, remote, unacked: true })).toBe("take-remote");
    expect(meet({ mine: remote, remote: local, disputed: true })).toBe(
      "keep-mine",
    );
  });

  test("other tags with equal text disagree", () => {
    const local = makePad({ rev: 3, tags: ["a"] });
    const remote = makePad({ rev: 5, tags: ["b"] });
    expect(meet({ mine: local, remote, unacked: true })).toBe("keep-both");
  });

  test("a missing pad comes in", () => {
    expect(meet({ remote: makePad({ id: padId(2) }) })).toBe("take-remote");
  });

  test("a blank pad from the server stays out", () => {
    expect(meet({ remote: makePad({ text: "  " }) })).toBe("keep-mine");
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
    journal.data.set("acked", JSON.stringify({ [local.id]: 2 }));
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
      "discarded",
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

  test("a discarded pad has a row, and Restore sets the stage to writing", () => {
    const journal = makeJournal();
    const old = makePad({ id: padId(7), stage: { kind: "discarded" } });
    journal.data.set(`pad:${old.id}`, JSON.stringify(old));
    const { store } = setup({ handler: never, journal, firstId: 8 });
    const rows = () =>
      earlierRows({ pads: store.all(), current: store.current().id });
    expect(rows().map((row) => row.kind)).toEqual(["discarded"]);
    expect(earlierCount(rows())).toBe(0);
    store.restore(old.id);
    expect(storedPad(journal.data, old.id)?.stage).toEqual({ kind: "writing" });
    expect(storedPad(journal.data, old.id)?.text).toBe("A thought");
    expect(rows().map((row) => row.kind)).toEqual(["draft"]);
    expect(earlierCount(rows())).toBe(1);
  });

  test("Restore does nothing to a pad that is not discarded", () => {
    const journal = makeJournal();
    const old = makePad({ id: padId(7), rev: 4 });
    journal.data.set(`pad:${old.id}`, JSON.stringify(old));
    const { store } = setup({ handler: never, journal, firstId: 8 });
    store.restore(old.id);
    expect(storedPad(journal.data, old.id)?.rev).toBe(4);
  });

  test("a half-done Fix cannot be discarded, and its target stays", () => {
    const journal = makeJournal();
    const old = makePad({
      id: padId(7),
      target: { kind: "revise", slug: SLUG, from: SHA },
    });
    journal.data.set(`pad:${old.id}`, JSON.stringify(old));
    const { store } = setup({ handler: never, journal, firstId: 8 });
    expect(canDiscard(old)).toBe(false);
    store.discard(old.id);
    expect(storedPad(journal.data, old.id)?.stage).toEqual({ kind: "writing" });
    expect(canDiscard(makePad())).toBe(true);
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
