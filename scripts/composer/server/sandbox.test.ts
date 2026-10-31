import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { sandboxArgv } from "./sandbox";

setDefaultTimeout(60_000);

const canMapUsers =
  Bun.spawnSync(["unshare", "--map-auto", "--map-root-user", "true"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

describe("a sandbox uid", () => {
  test("timeout starts after setpriv, so it has the uid of the build it signals", () => {
    const argv = sandboxArgv({
      deps: "/deps",
      sandboxUid: 1001,
      args: ["bun", "run", "build"],
      timeoutSeconds: 5,
    });
    const setpriv = argv.indexOf("setpriv");
    const timeout = argv.indexOf("timeout");
    expect(setpriv).toBe(0);
    expect(timeout).toBeGreaterThan(setpriv);
    expect(argv.indexOf("bun")).toBeGreaterThan(timeout);
  });

  test.skipIf(!canMapUsers)(
    "the build runs as that uid, cannot read secrets, and the post ships",
    async () => {
      const child = Bun.spawn(
        [
          "unshare",
          "--map-auto",
          "--map-root-user",
          "bun",
          join(import.meta.dir, "uid-check.ts"),
        ],
        { stdout: "pipe", stderr: "inherit" },
      );
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");

      expect(result.proved).toMatchObject({ kind: "proved" });
      expect(result.blocked).toBe(true);
      expect(result.probe.uid).toBe(1001);
      expect(result.probe.gid).toBe(1001);
      expect(result.probe.groups).toEqual([]);
      const reads = Object.values(result.probe.probes);
      expect(reads.length).toBeGreaterThanOrEqual(5);
      expect(reads.every((read) => read === false)).toBe(true);

      expect(result.caps).toEqual([
        "CapEff: 00000000000000c0",
        "CapBnd: 00000000000000c0",
        "NoNewPrivs: 1",
      ]);
      expect(result.hung).toMatchObject({
        kind: "refused",
        why: { kind: "build-failed" },
      });
      expect(result.hungUid).toBe(1001);
      expect(result.hungStopped).toBe(true);
      expect(result.shipped.kind).toBe("pushed");
      expect(result.mainSha).toBe(result.proved.sha);
      expect(result.pads).toHaveLength(2);
    },
  );
});
