import {
  isRecord,
  parsePad,
  parseProved,
  parseShipStatus,
  type Pad,
  type PadId,
  type Proved,
  type Sha,
  type ShipStatus,
} from "../protocol";

const PAD_PREFIX = "pad:";
const CURRENT = "current";
const ACKED = "acked";
const TAGS = "tags";

const DEBOUNCE_MS = 800;
const RETRY_MS = 10_000;
const RESUME_MS = 10 * 60 * 1000;
const RETRY_WAITS = [0, 500, 1500];
const SYNC_TIMEOUT_MS = 20_000;
const PROVE_TIMEOUT_MS = 180_000;
const SHIP_TIMEOUT_MS = 60_000;
/** A larger `keepalive` body makes `fetch` reject. */
const KEEPALIVE_LIMIT = 60_000;

export type Journal = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

type StoreEvents = {
  changed: () => void;
  denied: () => void;
  serverBack: () => void;
  shipAnswered: (id: PadId, answer: ShipStatus) => void;
  shipFailed: (id: PadId, problem: "no-server" | "server-error") => void;
  currentReplaced: (pad: Pad) => void;
};

export type StoreDeps = {
  storage: Journal;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  online: () => boolean;
  now: () => number;
  newId: () => PadId;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  persist: () => void;
  events: StoreEvents;
};

export type Outcome<T> =
  | { kind: "answer"; answer: T }
  | { kind: "denied" }
  | { kind: "unreachable" }
  | { kind: "server-error" };

type PairResult =
  { kind: "paired" } | { kind: "wrong-token" } | { kind: "no-server" };

type SaveStatus = "nothing" | "on-this-phone" | "saved";

export const saveCopy: Record<SaveStatus, string> = {
  nothing: "",
  "on-this-phone": "On this phone",
  saved: "Saved",
};

export const isBlank = (pad: Pick<Pad, "text">) => pad.text.trim() === "";

export const titleOf = (pad: Pick<Pad, "text">) =>
  pad.text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";

export const pickCurrent = (args: {
  pad: Pad | undefined;
  now: number;
}): Pad | undefined => {
  const { pad, now } = args;
  if (!pad) return undefined;
  if (pad.stage.kind === "published" || pad.stage.kind === "discarded") {
    return undefined;
  }
  return now - Date.parse(pad.updatedAt) < RESUME_MS ? pad : undefined;
};

export const mergePads = (
  local: readonly Pad[],
  remote: readonly Pad[],
): Pad[] => {
  const merged = new Map(local.map((pad) => [pad.id, pad]));
  for (const pad of remote) {
    if (isBlank(pad)) continue;
    const mine = merged.get(pad.id);
    if (!mine || pad.rev > mine.rev) merged.set(pad.id, pad);
  }
  return [...merged.values()];
};

export const settleShip = (pad: Pad, answer: ShipStatus): Pad => {
  if (pad.stage.kind !== "shipping") return pad;
  const { sha } = pad.stage;
  switch (answer.kind) {
    case "pushed":
    case "live":
      return {
        ...pad,
        stage: { kind: "published", slug: answer.slug, sha, url: answer.url },
        target: { kind: "revise", slug: answer.slug, from: sha },
      };
    case "stale":
    case "not-proven":
      return { ...pad, stage: { kind: "writing" } };
    case "origin-unreachable":
      return pad;
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
};

export type EarlierRow =
  | { kind: "draft"; pad: Pad }
  | { kind: "sending"; pad: Pad }
  | { kind: "published"; pad: Pad; url: string };

const rowOf = (pad: Pad): EarlierRow | undefined => {
  switch (pad.stage.kind) {
    case "writing":
      return { kind: "draft", pad };
    case "shipping":
      return { kind: "sending", pad };
    case "published":
      return { kind: "published", pad, url: pad.stage.url };
    case "discarded":
      return undefined;
    default: {
      const _exhaustive: never = pad.stage;
      return _exhaustive;
    }
  }
};

export const earlierRows = (args: {
  pads: readonly Pad[];
  current: PadId;
}): EarlierRow[] =>
  args.pads
    .filter((pad) => pad.id !== args.current && !isBlank(pad))
    .flatMap((pad) => rowOf(pad) ?? [])
    .sort((a, b) => b.pad.updatedAt.localeCompare(a.pad.updatedAt));

export const earlierCount = (rows: readonly EarlierRow[]) =>
  rows.filter((row) => row.kind !== "published").length;

export const normalizeTag = (tag: string) => tag.trim().toLowerCase();

export const chipTags = (args: {
  known: readonly string[];
  selected: readonly string[];
}) => [...new Set([...args.known, ...args.selected])];

const parsePads = (value: unknown): Pad[] | undefined =>
  Array.isArray(value)
    ? value.flatMap((item) => parsePad(item) ?? [])
    : undefined;

const parseTags = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((tag): tag is string => typeof tag === "string")
    : undefined;

const parseRev = (value: unknown): number | undefined =>
  isRecord(value) && typeof value.rev === "number" ? value.rev : undefined;

const parseJson = (text: string | null): unknown => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const readPads = (storage: Journal) => {
  const pads = new Map<PadId, Pad>();
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(PAD_PREFIX)) continue;
    const pad = parsePad(parseJson(storage.getItem(key)));
    if (pad) pads.set(pad.id, pad);
  }
  return pads;
};

const readAcked = (storage: Journal) => {
  const value = parseJson(storage.getItem(ACKED));
  const acked = new Map<string, number>();
  if (!isRecord(value)) return acked;
  for (const [id, rev] of Object.entries(value)) {
    if (typeof rev === "number") acked.set(id, rev);
  }
  return acked;
};

type Call<T> = {
  method: "GET" | "PUT" | "POST";
  path: string;
  body?: string;
  keepalive?: boolean;
  waits?: readonly number[];
  timeout: number;
  parse: (value: unknown) => T | undefined;
};

export const createStore = (deps: StoreDeps) => {
  const { storage, now, events } = deps;

  const pads = readPads(storage);
  const acked = readAcked(storage);
  let tags = parseTags(parseJson(storage.getItem(TAGS))) ?? [];

  const stamp = () => new Date(now()).toISOString();
  const blankPad = (): Pad => ({
    id: deps.newId(),
    rev: 0,
    text: "",
    tags: [],
    target: { kind: "new" },
    stage: { kind: "writing" },
    updatedAt: stamp(),
  });

  const storedCurrent = storage.getItem(CURRENT);
  let open =
    pickCurrent({
      pad: [...pads.values()].find((pad) => pad.id === storedCurrent),
      now: now(),
    }) ?? blankPad();
  pads.set(open.id, open);

  let timer: unknown;
  let denied = false;
  let reachable: boolean | undefined;
  let pulled = false;
  let running = false;
  let pending = false;

  const ackedRev = (id: PadId) => acked.get(id) ?? 0;

  const isBehind = (pad: Pad) => !isBlank(pad) && pad.rev > ackedRev(pad.id);

  const write = (pad: Pad) => {
    storage.setItem(`${PAD_PREFIX}${pad.id}`, JSON.stringify(pad));
  };

  const arm = (ms: number) => {
    deps.clearTimer(timer);
    timer = deps.setTimer(() => void run(), ms);
  };

  const commit = (pad: Pad) => {
    pads.set(pad.id, pad);
    if (pad.id === open.id) open = pad;
    if (isBlank(pad)) {
      events.changed();
      return;
    }
    write(pad);
    if (pad.id === open.id) storage.setItem(CURRENT, pad.id);
    events.changed();
    arm(DEBOUNCE_MS);
  };

  const revise = (
    pad: Pad,
    change: Partial<Pick<Pad, "text" | "tags" | "stage" | "target">>,
  ) => commit({ ...pad, ...change, rev: pad.rev + 1, updatedAt: stamp() });

  const deny = () => {
    denied = true;
    deps.clearTimer(timer);
    events.denied();
  };

  const refreshSession = async () => {
    const response = await deps
      .fetch("/api/session", {
        method: "GET",
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      })
      .catch(() => undefined);
    if (response?.status === 401) deny();
  };

  const markReachable = (value: boolean) => {
    const back = reachable === false && value;
    reachable = value;
    if (back) events.serverBack();
  };

  const call = async <T>(request: Call<T>): Promise<Outcome<T>> => {
    for (const wait of request.waits ?? [0]) {
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          deps.setTimer(resolve, wait);
        });
      }
      let response: Response;
      try {
        response = await deps.fetch(request.path, {
          method: request.method,
          headers: { "content-type": "application/json" },
          body: request.body,
          keepalive: request.keepalive,
          signal: AbortSignal.timeout(request.timeout),
        });
      } catch {
        continue;
      }
      if (response.status === 401) {
        deny();
        return { kind: "denied" };
      }
      markReachable(true);
      if (!response.ok) return { kind: "server-error" };
      const answer = request.parse(
        await response.json().catch(() => undefined),
      );
      return answer === undefined
        ? { kind: "server-error" }
        : { kind: "answer", answer };
    }
    markReachable(false);
    return { kind: "unreachable" };
  };

  const moveRevPastServer = ({
    sent,
    serverRev,
  }: {
    sent: Pad;
    serverRev: number;
  }) => {
    const latest = pads.get(sent.id);
    if (latest && serverRev > sent.rev && serverRev >= latest.rev) {
      commit({ ...latest, rev: serverRev + 1 });
    }
  };

  const put = async (pad: Pad, options: { keepalive: boolean }) => {
    const body = JSON.stringify(pad);
    const outcome = await call({
      method: "PUT",
      path: `/api/pads/${pad.id}`,
      body,
      keepalive: options.keepalive && body.length < KEEPALIVE_LIMIT,
      timeout: SYNC_TIMEOUT_MS,
      parse: parseRev,
    });
    if (outcome.kind !== "answer") return outcome;
    const { answer } = outcome;
    acked.set(pad.id, Math.max(ackedRev(pad.id), answer));
    storage.setItem(ACKED, JSON.stringify(Object.fromEntries(acked)));
    moveRevPastServer({ sent: pad, serverRev: answer });
    events.changed();
    return outcome;
  };

  const syncBehind = async () => {
    for (const pad of pads.values()) {
      if (!isBehind(pad)) continue;
      const outcome = await put(pad, { keepalive: false });
      if (outcome.kind === "denied" || outcome.kind === "unreachable") return;
    }
  };

  const pullPads = async () => {
    const outcome = await call({
      method: "GET",
      path: "/api/pads",
      timeout: SYNC_TIMEOUT_MS,
      parse: parsePads,
    });
    if (outcome.kind !== "answer") return;
    pulled = true;
    for (const pad of outcome.answer) {
      acked.set(pad.id, Math.max(ackedRev(pad.id), pad.rev));
    }
    storage.setItem(ACKED, JSON.stringify(Object.fromEntries(acked)));
    for (const pad of mergePads([...pads.values()], outcome.answer)) {
      if (pads.get(pad.id) === pad) continue;
      pads.set(pad.id, pad);
      write(pad);
      if (pad.id !== open.id) continue;
      open = pad;
      events.currentReplaced(pad);
    }
    events.changed();
    void refreshTags();
  };

  const refreshTags = async () => {
    const outcome = await call({
      method: "GET",
      path: "/api/tags",
      timeout: SYNC_TIMEOUT_MS,
      parse: parseTags,
    });
    if (outcome.kind !== "answer") return;
    tags = outcome.answer;
    storage.setItem(TAGS, JSON.stringify(tags));
    events.changed();
  };

  const callShip = (sha: Sha, waits?: readonly number[]) =>
    call({
      method: "POST",
      path: "/api/ship",
      body: JSON.stringify({ sha }),
      waits,
      timeout: SHIP_TIMEOUT_MS,
      parse: parseShipStatus,
    });

  const shippingPads = () =>
    [...pads.values()].flatMap((pad) =>
      pad.stage.kind === "shipping" ? [{ pad, sha: pad.stage.sha }] : [],
    );

  const resolveShipping = async () => {
    for (const { pad, sha } of shippingPads()) {
      const outcome = await callShip(sha, RETRY_WAITS);
      if (outcome.kind === "denied") return;
      if (outcome.kind === "unreachable" || outcome.kind === "server-error") {
        events.shipFailed(
          pad.id,
          outcome.kind === "unreachable" ? "no-server" : "server-error",
        );
        continue;
      }
      const latest = pads.get(pad.id) ?? pad;
      const settled = settleShip(latest, outcome.answer);
      if (settled !== latest) {
        revise(latest, { stage: settled.stage, target: settled.target });
      }
      events.shipAnswered(pad.id, outcome.answer);
    }
  };

  const hasWork = () =>
    !pulled || shippingPads().length > 0 || [...pads.values()].some(isBehind);

  async function run(): Promise<void> {
    if (denied) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    deps.clearTimer(timer);
    timer = undefined;
    const canContinue = () => !denied && reachable !== false;
    const needsFirstPull = !pulled;
    const probesForServer = reachable === false;
    if (needsFirstPull || probesForServer) await pullPads();
    if (canContinue()) await syncBehind();
    if (canContinue()) await resolveShipping();
    running = false;
    if (denied) return;
    if (pending) {
      pending = false;
      void run();
      return;
    }
    if (timer === undefined && hasWork()) arm(RETRY_MS);
  }

  return {
    current: () => open,
    all: () => [...pads.values()],
    tags: () => tags,

    saveStatus: (): SaveStatus => {
      if (isBlank(open)) return "nothing";
      return isBehind(open) ? "on-this-phone" : "saved";
    },

    edit: (text: string) => {
      if (text === open.text) return;
      revise(open, {
        text,
        stage:
          open.stage.kind === "published" ? { kind: "writing" } : open.stage,
      });
    },

    setTags: (next: readonly string[]) => revise(open, { tags: [...next] }),

    newPad: () => {
      open = blankPad();
      pads.set(open.id, open);
      storage.removeItem(CURRENT);
      events.changed();
      return open;
    },

    openPad: (id: PadId) => {
      const pad = pads.get(id);
      if (!pad) return undefined;
      open = pad;
      storage.setItem(CURRENT, id);
      events.changed();
      return pad;
    },

    discard: (id: PadId) => {
      const pad = pads.get(id);
      if (pad?.stage.kind === "writing") {
        revise(pad, { stage: { kind: "discarded" } });
      }
    },

    prove: (): Promise<Outcome<Proved>> =>
      call({
        method: "POST",
        path: "/api/prove",
        body: JSON.stringify({ pad: open }),
        waits: RETRY_WAITS,
        timeout: PROVE_TIMEOUT_MS,
        parse: parseProved,
      }),

    beginShip: (sha: Sha) => {
      revise(open, { stage: { kind: "shipping", sha } });
      void run();
    },

    poll: (sha: Sha) => callShip(sha),

    pair: async (token: string): Promise<PairResult> => {
      let status: number;
      try {
        const response = await deps.fetch("/api/pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        status = response.status;
      } catch {
        return { kind: "no-server" };
      }
      if (status < 200 || status >= 300) return { kind: "wrong-token" };
      denied = false;
      pulled = false;
      markReachable(true);
      void run();
      return { kind: "paired" };
    },

    sync: () => {
      if (!denied) void run();
    },

    flush: () => {
      if (denied) return;
      for (const pad of pads.values()) {
        if (isBehind(pad)) void put(pad, { keepalive: true });
      }
    },

    start: () => {
      deps.persist();
      if (deps.online()) void refreshSession();
      void run();
    },
  };
};
