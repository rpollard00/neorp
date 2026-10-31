import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { parsePad, parsePadId, type Pad, type PadId } from "../protocol";
import { log } from "./log";

export type Pads = {
  put: (pad: Pad) => Promise<{ rev: number }>;
  list: () => Promise<Pad[]>;
};

const SUFFIX = ".json";

const readPad = async (path: string) => {
  try {
    return parsePad(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    log("pad-corrupt", { path });
    return undefined;
  }
};

const syncPath = async (path: string) => {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeDurably = async ({
  dir,
  path,
  content,
}: {
  dir: string;
  path: string;
  content: string;
}) => {
  const temp = `${path}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await syncPath(dir);
};

export const createPads = ({ dataDir }: { dataDir: string }): Pads => {
  const dir = join(dataDir, "pads");
  const pathOf = (id: PadId) => join(dir, `${id}${SUFFIX}`);
  let tail: Promise<unknown> = Promise.resolve();

  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job, job);
    tail = result.catch(() => undefined);
    return result;
  };

  const put = (pad: Pad) =>
    serial(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const stored = await readPad(pathOf(pad.id));
      if (stored && stored.rev >= pad.rev) return { rev: stored.rev };
      await writeDurably({
        dir,
        path: pathOf(pad.id),
        content: JSON.stringify(pad),
      });
      return { rev: pad.rev };
    });

  const list = async () => {
    const names = await readdir(dir).catch(() => []);
    const ids = names.flatMap((name) => {
      const id = name.endsWith(SUFFIX)
        ? parsePadId(name.slice(0, -SUFFIX.length))
        : undefined;
      return id ? [id] : [];
    });
    const pads = await Promise.all(ids.map((id) => readPad(pathOf(id))));
    return pads.flatMap((pad, index) => {
      if (pad?.id === ids[index]) return [pad];
      log("pad-skipped", { id: ids[index] });
      return [];
    });
  };

  return { put, list };
};
