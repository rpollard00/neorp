// The contract between the composer app and the composer server. No bare
// imports: the server process that holds the deploy key loads this file.

export type Slug = string & { readonly __brand: "Slug" };
export type Sha = string & { readonly __brand: "Sha" };
export type PadId = string & { readonly __brand: "PadId" };

/** What a pad becomes in the repo. A fix keeps the slug and the date. */
export type Target =
  | { kind: "new" }
  | { kind: "revise"; slug: Slug; from: Sha };

export type Stage =
  | { kind: "writing" }
  /** `ship` was called, and the answer is not known yet. */
  | { kind: "shipping"; sha: Sha }
  | { kind: "published"; slug: Slug; sha: Sha; url: string }
  | { kind: "discarded" };

/** One piece of text. The app owns it. The server keeps a copy. */
export type Pad = {
  id: PadId;
  /** Grows with each edit. The server keeps the highest. */
  rev: number;
  text: string;
  tags: string[];
  target: Target;
  stage: Stage;
  updatedAt: string;
};

export type Refusal =
  | { kind: "blank" }
  | { kind: "origin-unreachable" }
  | { kind: "toolchain"; need: string }
  | { kind: "revise-conflict" }
  | { kind: "not-revisable" }
  | { kind: "build-failed"; tail: string }
  | { kind: "no-page" };

export type Proved =
  | { kind: "proved"; sha: Sha; url: string }
  | { kind: "refused"; why: Refusal };

export type ShipStatus =
  | { kind: "pushed"; url: string; slug: Slug }
  | { kind: "live"; url: string; slug: Slug }
  /** `main` moved after the preview, and nothing was pushed. */
  | { kind: "stale" }
  | { kind: "not-proven" }
  | { kind: "origin-unreachable" };

/** Every route, with its body and its answer. */
export type Api = {
  "POST /api/pair": { body: { token: string }; answer: null };
  "GET /api/session": { body: null; answer: null };
  "GET /api/pads": { body: null; answer: Pad[] };
  "PUT /api/pads/:id": { body: Pad; answer: { rev: number } };
  "GET /api/tags": { body: null; answer: string[] };
  "POST /api/prove": { body: { pad: Pad }; answer: Proved };
  "POST /api/ship": { body: { sha: Sha }; answer: ShipStatus };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SLUG = /^[a-z0-9][a-z0-9/-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const PAD_ID = /^[a-z0-9-]{8,64}$/;

export const parseSlug = (value: unknown): Slug | undefined =>
  typeof value === "string" && SLUG.test(value) ? (value as Slug) : undefined;

export const parseSha = (value: unknown): Sha | undefined =>
  typeof value === "string" && SHA.test(value) ? (value as Sha) : undefined;

export const parsePadId = (value: unknown): PadId | undefined =>
  typeof value === "string" && PAD_ID.test(value) ? (value as PadId) : undefined;

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

/** Parses a pad from JSON. The app and the server both use this. */
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
