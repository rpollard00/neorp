export type Slug = string & { readonly __brand: "Slug" };
export type Sha = string & { readonly __brand: "Sha" };
export type PadId = string & { readonly __brand: "PadId" };

/** What a pad becomes in the repo. A fix keeps the slug and the date. */
export type Target =
  { kind: "new" } | { kind: "revise"; slug: Slug; from: Sha };

type Stage =
  | { kind: "writing" }
  /** `ship` was called, and the answer is not known yet. */
  | { kind: "shipping"; sha: Sha }
  | { kind: "published"; slug: Slug; sha: Sha; url: string }
  | { kind: "discarded" };

/** One piece of text. The app owns it. The server keeps a copy. */
export type Pad = {
  id: PadId;
  /** Counts the edits on one device, so it cannot show which text is newer. */
  rev: number;
  text: string;
  tags: string[];
  target: Target;
  stage: Stage;
  updatedAt: string;
};

/** `same` is false when the server keeps other text or tags than the request sent. */
export type PutAnswer = { rev: number; same: boolean };

export type Refusal =
  | { kind: "blank" }
  | { kind: "origin-unreachable" }
  | { kind: "toolchain"; need: string }
  | { kind: "revise-conflict" }
  | { kind: "not-revisable" }
  /** The revised file is the file on `main`, so there is nothing to commit. */
  | { kind: "unchanged" }
  | { kind: "build-failed"; tail: string }
  | { kind: "no-page" };

export type Proved =
  { kind: "proved"; sha: Sha; url: string } | { kind: "refused"; why: Refusal };

export type ShipStatus =
  | { kind: "pushed"; url: string; slug: Slug }
  | { kind: "live"; url: string; slug: Slug }
  /** `main` moved after the preview, and nothing was pushed. */
  | { kind: "stale" }
  | { kind: "not-proven" }
  | { kind: "origin-unreachable" };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SLUG = /^[a-z0-9][a-z0-9/-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const PAD_ID = /^[a-z0-9-]{8,64}$/;

export const parseSlug = (value: unknown): Slug | undefined =>
  typeof value === "string" && SLUG.test(value) ? (value as Slug) : undefined;

export const parseSha = (value: unknown): Sha | undefined =>
  typeof value === "string" && SHA.test(value) ? (value as Sha) : undefined;

export const parsePadId = (value: unknown): PadId | undefined =>
  typeof value === "string" && PAD_ID.test(value)
    ? (value as PadId)
    : undefined;

const parseTarget = (value: unknown): Target | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.kind === "new") return { kind: "new" };
  if (value.kind !== "revise") return undefined;
  const slug = parseSlug(value.slug);
  const from = parseSha(value.from);
  return slug && from ? { kind: "revise", slug, from } : undefined;
};

const parseStage = (value: unknown): Stage | undefined => {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case "writing":
    case "discarded":
      return { kind: value.kind };
    case "shipping": {
      const sha = parseSha(value.sha);
      return sha && { kind: "shipping", sha };
    }
    case "published": {
      const slug = parseSlug(value.slug);
      const sha = parseSha(value.sha);
      return slug && sha && typeof value.url === "string"
        ? { kind: "published", slug, sha, url: value.url }
        : undefined;
    }
    default:
      return undefined;
  }
};

export const parsePad = (value: unknown): Pad | undefined => {
  if (!isRecord(value)) return undefined;
  const id = parsePadId(value.id);
  const target = parseTarget(value.target);
  const stage = parseStage(value.stage);
  const { rev, text, tags, updatedAt } = value;
  if (!id || !target || !stage) return undefined;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) {
    return undefined;
  }
  if (typeof text !== "string" || typeof updatedAt !== "string") {
    return undefined;
  }
  if (!Array.isArray(tags)) return undefined;
  if (!tags.every((tag): tag is string => typeof tag === "string")) {
    return undefined;
  }
  return { id, rev, text, tags, target, stage, updatedAt };
};

export const parsePutAnswer = (value: unknown): PutAnswer | undefined =>
  isRecord(value) &&
  typeof value.rev === "number" &&
  typeof value.same === "boolean"
    ? { rev: value.rev, same: value.same }
    : undefined;

/** Two versions with equal text and tags do not disagree, at any rev. */
export const sameContent = (
  a: Pick<Pad, "text" | "tags">,
  b: Pick<Pad, "text" | "tags">,
) =>
  a.text === b.text &&
  a.tags.length === b.tags.length &&
  a.tags.every((tag, index) => tag === b.tags[index]);

const parseRefusal = (value: unknown): Refusal | undefined => {
  if (!isRecord(value)) return undefined;
  const kind = value.kind as Refusal["kind"];
  switch (kind) {
    case "blank":
    case "origin-unreachable":
    case "revise-conflict":
    case "not-revisable":
    case "unchanged":
    case "no-page":
      return { kind };
    case "toolchain":
      return typeof value.need === "string"
        ? { kind, need: value.need }
        : undefined;
    case "build-failed":
      return typeof value.tail === "string"
        ? { kind, tail: value.tail }
        : undefined;
    default:
      kind satisfies never;
      return undefined;
  }
};

export const parseProved = (value: unknown): Proved | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.kind === "refused") {
    const why = parseRefusal(value.why);
    return why && { kind: "refused", why };
  }
  const sha = parseSha(value.sha);
  return value.kind === "proved" && sha && typeof value.url === "string"
    ? { kind: "proved", sha, url: value.url }
    : undefined;
};

export const parseShipStatus = (value: unknown): ShipStatus | undefined => {
  if (!isRecord(value)) return undefined;
  const kind = value.kind as ShipStatus["kind"];
  switch (kind) {
    case "stale":
    case "not-proven":
    case "origin-unreachable":
      return { kind };
    case "pushed":
    case "live": {
      const slug = parseSlug(value.slug);
      return slug && typeof value.url === "string"
        ? { kind, url: value.url, slug }
        : undefined;
    }
    default:
      kind satisfies never;
      return undefined;
  }
};
