import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assetPath,
  validateAsset,
  type AssetName,
  type ImageAsset,
} from "../images";
import type { Config } from "./config";
import { createRepo } from "./git";

export const createAssets = (config: Config) => {
  const root = join(config.dataDir, "assets");
  const repo = createRepo(config);
  const staged = async (name: AssetName) => {
    const bytes = await readFile(join(root, name)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    return bytes ? validateAsset(name, bytes) : undefined;
  };
  const put = async (asset: ImageAsset) => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = join(root, `${asset.name}.${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temp, asset.bytes, { mode: 0o600, flag: "wx" });
      await rename(temp, join(root, asset.name));
    } finally {
      await rm(temp, { force: true });
    }
  };
  const get = async (name: AssetName) => {
    const local = await staged(name);
    if (local) return local;
    await repo.fetch();
    const parent = await repo.lastFetchedMain();
    if (!parent) return undefined;
    const bytes = await repo.readBytes({
      commit: parent,
      path: assetPath(name),
    });
    return bytes ? validateAsset(name, bytes) : undefined;
  };
  return { staged, put, get };
};
