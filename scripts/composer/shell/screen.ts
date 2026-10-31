// This file is pure: no DOM, no storage, no network.

import type { Pad, PadId, Proved, Refusal, Sha, ShipStatus } from "../protocol";

export const POLL_MS = 15_000;
export const MAX_POLLS = 40;

type PairFailure = { kind: "wrong-token" } | { kind: "no-server" };

export type WriteProblem =
  | { kind: "no-server" }
  | { kind: "server-error" }
  | { kind: "refused"; why: Refusal }
  | { kind: "stale" }
  | { kind: "not-proven" };

export type ShipProblem =
  | { kind: "no-server" }
  | { kind: "server-error" }
  | { kind: "origin-unreachable" };

/** The pad version that a build is for. An answer for another version is old. */
export type ProofSource = { pad: PadId; rev: number };

export type Screen =
  | { kind: "pair"; failure: PairFailure | null }
  | {
      kind: "write";
      popover: "closed" | "open";
      problem: WriteProblem | null;
    }
  | { kind: "building"; source: ProofSource }
  | { kind: "preview"; sha: Sha; url: string }
  | {
      kind: "shipping";
      sha: Sha;
      page: string | null;
      problem: ShipProblem | null;
    }
  | {
      kind: "pushed";
      sha: Sha;
      url: string;
      page: string | null;
      polls: number;
    }
  | { kind: "live"; url: string; page: string | null }
  | { kind: "earlier" };

export type Event =
  | { kind: "denied" }
  | { kind: "pair-failed"; failure: PairFailure }
  | { kind: "pad-opened"; pad: Pad }
  /** The open text moved to a new pad id. The editor keeps its doc. */
  | { kind: "pad-forked" }
  | { kind: "edited" }
  | { kind: "tags-toggled" }
  | { kind: "tags-closed" }
  | { kind: "server-back" }
  | { kind: "prove-started"; source: ProofSource }
  | { kind: "prove-answered"; source: ProofSource; answer: Proved }
  | {
      kind: "prove-failed";
      source: ProofSource;
      problem: "no-server" | "server-error";
    }
  | { kind: "back-to-editing" }
  | { kind: "ship-started" }
  | { kind: "ship-answered"; answer: ShipStatus }
  | { kind: "ship-failed"; problem: "no-server" | "server-error" }
  | { kind: "earlier-opened" }
  | { kind: "earlier-closed" };

const writing: Screen = { kind: "write", popover: "closed", problem: null };

export const screenForPad = (pad: Pad): Screen =>
  pad.stage.kind === "shipping"
    ? { kind: "shipping", sha: pad.stage.sha, page: null, problem: null }
    : writing;

const shipAnswered = (screen: Screen, answer: ShipStatus): Screen => {
  if (screen.kind === "pushed") {
    if (answer.kind === "live") {
      return { kind: "live", url: answer.url, page: screen.page };
    }
    return { ...screen, polls: screen.polls + 1 };
  }
  if (screen.kind !== "shipping") return screen;
  switch (answer.kind) {
    case "pushed":
      return {
        kind: "pushed",
        sha: screen.sha,
        url: answer.url,
        page: screen.page,
        polls: 0,
      };
    case "live":
      return { kind: "live", url: answer.url, page: screen.page };
    case "stale":
      return { ...writing, problem: { kind: "stale" } };
    case "not-proven":
      return { ...writing, problem: { kind: "not-proven" } };
    case "origin-unreachable":
      return { ...screen, problem: { kind: "origin-unreachable" } };
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
};

const isBuilding = (screen: Screen, source: ProofSource) =>
  screen.kind === "building" &&
  screen.source.pad === source.pad &&
  screen.source.rev === source.rev;

export const reduce = (screen: Screen, event: Event): Screen => {
  switch (event.kind) {
    case "denied":
      return { kind: "pair", failure: null };
    case "pair-failed":
      return screen.kind === "pair"
        ? { ...screen, failure: event.failure }
        : screen;
    case "pad-opened":
      return screenForPad(event.pad);
    case "pad-forked":
      return screen.kind === "write" ||
        screen.kind === "earlier" ||
        screen.kind === "pair"
        ? screen
        : writing;
    case "edited":
      if (screen.kind === "building") return writing;
      return screen.kind === "write" && screen.problem
        ? { ...screen, problem: null }
        : screen;
    case "tags-toggled":
      return screen.kind === "write"
        ? {
            ...screen,
            popover: screen.popover === "open" ? "closed" : "open",
          }
        : screen;
    case "tags-closed":
      return screen.kind === "write"
        ? { ...screen, popover: "closed" }
        : screen;
    case "server-back":
      return (screen.kind === "write" || screen.kind === "shipping") &&
        screen.problem?.kind === "no-server"
        ? { ...screen, problem: null }
        : screen;
    case "prove-started":
      return screen.kind === "write"
        ? { kind: "building", source: event.source }
        : screen;
    case "prove-answered":
      if (!isBuilding(screen, event.source)) return screen;
      return event.answer.kind === "proved"
        ? { kind: "preview", sha: event.answer.sha, url: event.answer.url }
        : {
            ...writing,
            problem: { kind: "refused", why: event.answer.why },
          };
    case "prove-failed":
      return isBuilding(screen, event.source)
        ? { ...writing, problem: { kind: event.problem } }
        : screen;
    case "back-to-editing":
      return screen.kind === "preview" ? writing : screen;
    case "ship-started":
      return screen.kind === "preview"
        ? {
            kind: "shipping",
            sha: screen.sha,
            page: screen.url,
            problem: null,
          }
        : screen;
    case "ship-answered":
      return shipAnswered(screen, event.answer);
    case "ship-failed":
      if (screen.kind === "shipping") {
        return { ...screen, problem: { kind: event.problem } };
      }
      return screen.kind === "pushed"
        ? { ...screen, polls: screen.polls + 1 }
        : screen;
    case "earlier-opened":
      return screen.kind === "write" ? { kind: "earlier" } : screen;
    case "earlier-closed":
      return screen.kind === "earlier" ? writing : screen;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
};

export const isWatching = (screen: Screen): boolean =>
  screen.kind === "pushed" && screen.polls < MAX_POLLS;

type Surface = "editor" | "page" | "earlier" | "pair";

export const surfaceOf = (screen: Screen): Surface => {
  switch (screen.kind) {
    case "pair":
      return "pair";
    case "write":
    case "building":
      return "editor";
    case "preview":
      return "page";
    case "shipping":
    case "pushed":
    case "live":
      return screen.page === null ? "editor" : "page";
    case "earlier":
      return "earlier";
    default: {
      const _exhaustive: never = screen;
      return _exhaustive;
    }
  }
};

export type Bar =
  "pair" | "write" | "preview" | "shipping" | "pushed" | "settled" | "earlier";

export const barOf = (screen: Screen): Bar => {
  switch (screen.kind) {
    case "pair":
      return "pair";
    case "write":
    case "building":
      return "write";
    case "preview":
      return "preview";
    case "shipping":
      return "shipping";
    case "pushed":
      return isWatching(screen) ? "pushed" : "settled";
    case "live":
      return "settled";
    case "earlier":
      return "earlier";
    default: {
      const _exhaustive: never = screen;
      return _exhaustive;
    }
  }
};

export type Notice = {
  label: string | null;
  text: string;
  action: string;
  outlined: boolean;
};

const failureLine = (tail: string) => {
  const lines = tail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = lines.flatMap(
    (line) => /^\[\w*Error\]\s*(.+)/.exec(line)?.[1] ?? [],
  );
  return errors.at(-1) ?? lines.at(-1) ?? "The build stopped.";
};

const notice = (args: Pick<Notice, "text"> & Partial<Notice>): Notice => ({
  label: null,
  action: "Try again",
  outlined: false,
  ...args,
});

const fixed = (text: string) => notice({ text });

export const refusalNotice = (why: Refusal): Notice => {
  switch (why.kind) {
    case "blank":
      return fixed("The post has no text.");
    case "origin-unreachable":
      return fixed("The server cannot connect to GitHub.");
    case "toolchain":
      return fixed(`The server needs ${why.need}. Deploy the composer again.`);
    case "revise-conflict":
      return fixed("This post changed on main. Fix it on the laptop.");
    case "not-revisable":
      return fixed("The composer cannot change this post.");
    case "unchanged":
      return fixed("This matches the live post.");
    case "build-failed":
      return { ...fixed(failureLine(why.tail)), label: "Build failed" };
    case "no-page":
      return fixed("The build made no page for this post.");
    default: {
      const _exhaustive: never = why;
      return _exhaustive;
    }
  }
};

export const buildingNotice = notice({
  text: "Building the preview, about 10 seconds.",
  action: "Preview",
  outlined: true,
});

export const writeNotice = (problem: WriteProblem): Notice => {
  switch (problem.kind) {
    case "no-server":
      return notice({
        text: "Preview needs the server. Turn on Tailscale.",
        action: "Preview",
        outlined: true,
      });
    case "server-error":
      return fixed("The server gave an error.");
    case "refused":
      return refusalNotice(problem.why);
    case "stale":
      return notice({
        text: "Main changed. Nothing was pushed.",
        action: "Preview again",
      });
    case "not-proven":
      return notice({
        text: "The preview is out of date. Nothing was pushed.",
        action: "Preview again",
      });
    default: {
      const _exhaustive: never = problem;
      return _exhaustive;
    }
  }
};

export const notSeenCopy = "Pushed. Not seen on the site yet.";

export const liveLine = (url: string) => `On ${new URL(url).hostname}`;

export const shippingCopy = (problem: ShipProblem | null) => {
  if (problem === null) {
    return { line: "Waiting for the server", quiet: "You can close the app." };
  }
  switch (problem.kind) {
    case "no-server":
      return { line: "Publish needs the server.", quiet: "Turn on Tailscale." };
    case "server-error":
      return {
        line: "The server gave an error.",
        quiet: "The app will try again.",
      };
    case "origin-unreachable":
      return {
        line: "The server cannot connect to GitHub.",
        quiet: "The app will try again.",
      };
    default: {
      const _exhaustive: never = problem;
      return _exhaustive;
    }
  }
};

export const pairFailureCopy: Record<PairFailure["kind"], string> = {
  "wrong-token": "This token is not correct.",
  "no-server": "Pairing needs the server. Turn on Tailscale.",
};

export const earlierLabel = (count: number) =>
  count > 0 ? `${count} earlier` : "Earlier";
