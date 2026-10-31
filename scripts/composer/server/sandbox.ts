import { join } from "node:path";
import type { Subprocess } from "bun";
import { hostPath } from "./run";

const TAIL_BYTES = 64 * 1024;
/** A daemon can hold a pipe open after the build exits. Do not wait for it. */
const PIPE_GRACE_MS = 500;

type Command = {
  args: string[];
  cwd?: string;
  timeoutSeconds?: number;
};

const collectTail = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  const finished = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      tail = (tail + decoder.decode(value, { stream: true })).slice(
        -TAIL_BYTES,
      );
    }
  })().catch(() => undefined);
  return {
    finished,
    read: () => tail,
    stop: () => reader.cancel().catch(() => undefined),
  };
};

export const sandboxArgv = ({
  deps,
  sandboxUid,
  args,
  timeoutSeconds,
}: Pick<Command, "args" | "timeoutSeconds"> & {
  deps: string;
  sandboxUid?: number;
}) => [
  ...(sandboxUid === undefined
    ? []
    : [
        "setpriv",
        `--reuid=${sandboxUid}`,
        `--regid=${sandboxUid}`,
        "--clear-groups",
      ]),
  "env",
  "-i",
  `PATH=${hostPath()}`,
  `HOME=${join(deps, "home")}`,
  "CI=1",
  "ASTRO_TELEMETRY_DISABLED=1",
  `BUN_INSTALL_CACHE_DIR=${join(deps, "cache")}`,
  ...(timeoutSeconds === undefined
    ? []
    : ["timeout", "--kill-after=5", String(timeoutSeconds)]),
  ...args,
];

export const createSandbox = ({
  dataDir,
  sandboxUid,
}: {
  dataDir: string;
  sandboxUid?: number;
}) => {
  const deps = join(dataDir, "deps");
  const running = new Set<Subprocess>();

  const argv = ({ args, timeoutSeconds }: Command) =>
    sandboxArgv({ deps, sandboxUid, args, timeoutSeconds });

  const track = <T extends Subprocess>(child: T) => {
    running.add(child);
    void child.exited.finally(() => running.delete(child));
    return child;
  };

  const spawn = ({
    command,
    stdin,
  }: {
    command: Command;
    stdin: ReadableStream<Uint8Array> | "ignore";
  }) =>
    track(
      Bun.spawn(argv(command), {
        env: { PATH: hostPath() },
        cwd: command.cwd,
        stdin,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

  const finish = async (child: ReturnType<typeof spawn>) => {
    const out = collectTail(child.stdout);
    const err = collectTail(child.stderr);
    const code = await child.exited;
    await Promise.race([
      Promise.all([out.finished, err.finished]),
      Bun.sleep(PIPE_GRACE_MS),
    ]);
    await Promise.all([out.stop(), err.stop()]);
    return { code, tail: `${out.read()}${err.read()}` };
  };

  return {
    run: (command: Command) => finish(spawn({ command, stdin: "ignore" })),
    unpack: ({
      input,
      dir,
    }: {
      input: ReadableStream<Uint8Array>;
      dir: string;
    }) =>
      finish(
        spawn({ command: { args: ["tar", "-x", "-C", dir] }, stdin: input }),
      ),
    pack: (dir: string) => {
      const child = Bun.spawn(argv({ args: ["tar", "-c", "-C", dir, "."] }), {
        env: { PATH: hostPath() },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      return { output: track(child).stdout, exited: child.exited };
    },
    stop: () => {
      for (const child of running) child.kill();
    },
  };
};
