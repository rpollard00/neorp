import { chmod, chown, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makePad, createFixture } from "./fixture";
import type { Config } from "./config";
import { createPipeline } from "./pipeline";
import { createPads } from "./pads";

const BUILD_UID = 1001;

const hungBuild = async (hangFile: string) =>
  JSON.parse(await readFile(hangFile, "utf8")) as { pid: number; uid: number };

const isRunning = async (pid: number) => {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return stat !== "" && !/\) Z /.test(stat);
};

const stopsSoon = async (pid: number) => {
  for (let tries = 0; tries < 40; tries++) {
    if (!(await isRunning(pid))) return true;
    await Bun.sleep(50);
  }
  return false;
};

const inner = async ({
  config,
  secretFile,
  hangFile,
}: {
  config: Config;
  secretFile: string;
  hangFile: string;
}) => {
  const status = await readFile("/proc/self/status", "utf8");
  const caps = status
    .match(/^(CapEff|CapBnd|NoNewPrivs):.*$/gm)
    ?.map((line) => line.replace(/\s+/g, " "));
  const blocked = await Bun.write(
    join(config.dataDir, "builds", "server-file"),
    "x",
  ).then(
    () => false,
    () => true,
  );
  const pipeline = createPipeline(config, {
    fetchSite: async () => new Response("", { status: 404 }),
  });
  const pad = makePad({
    text: [
      "Sandboxed",
      "",
      `READ_PROBE:${secretFile}`,
      `READ_PROBE:${dirname(secretFile)}`,
      `READ_PROBE:${join(config.dataDir, "pads")}`,
      `READ_PROBE:${join(config.dataDir, "repo.git")}`,
      `READ_PROBE:${join(config.dataDir, "proof")}`,
      `LINK_TO:${secretFile}`,
    ].join("\n"),
  });
  const proved = await pipeline.prove({ pad });
  if (proved.kind !== "proved") return { proved };
  const hung = await createPipeline(
    { ...config, buildTimeoutSeconds: 1 },
    { fetchSite: async () => new Response("", { status: 404 }) },
  ).prove({
    pad: makePad({ text: `Stuck\n\nBUILD_HANGS\nHANG_FILE:${hangFile}` }),
  });
  const { pid: hungPid, uid: hungUid } = await hungBuild(hangFile);
  const shipped = await pipeline.ship({ sha: proved.sha });
  const current = join(config.dataDir, "proof", "current");
  return {
    blocked,
    caps,
    proved,
    hung,
    hungUid,
    hungStopped: await stopsSoon(hungPid),
    shipped,
    probe: JSON.parse(await readFile(join(current, "probe.json"), "utf8")),
    pads: await createPads(config).list(),
  };
};

const outer = async () => {
  const fixture = await createFixture();
  try {
    const { config, dir, secretFile } = fixture;
    await chmod(dir, 0o755);
    await chmod(dirname(secretFile), 0o700);
    await chmod(secretFile, 0o400);
    await chmod(config.tokenFile, 0o400);
    await chmod(join(dir, "builds.log"), 0o666);
    await chmod(join(dir, "installs.log"), 0o666);
    const hangFile = join(dir, "hung-build.json");
    await writeFile(hangFile, "");
    await chmod(hangFile, 0o666);

    await mkdir(config.dataDir);
    for (const name of ["builds", "deps"]) {
      await mkdir(join(config.dataDir, name));
      await chown(join(config.dataDir, name), BUILD_UID, BUILD_UID);
    }

    const sandboxed = { ...config, sandboxUid: BUILD_UID };
    const child = Bun.spawn(
      [
        "setpriv",
        "--bounding-set=-all,+setuid,+setgid",
        "--inh-caps=-all",
        "--no-new-privs",
        "bun",
        import.meta.path,
        "inner",
        JSON.stringify({ config: sandboxed, secretFile, hangFile }),
      ],
      {
        env: { PATH: process.env.PATH ?? "" },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const output = await new Response(child.stdout).text();
    await child.exited;
    // Uid 0 here keeps CAP_KILL, so it can stop a build that the sandbox missed.
    await hungBuild(hangFile)
      .then(
        ({ pid }) => process.kill(pid, "SIGKILL"),
        () => undefined,
      )
      .catch(() => undefined);
    const last = output.trim().split("\n").at(-1) ?? "{}";
    process.stdout.write(
      `${JSON.stringify({ ...JSON.parse(last), mainSha: await fixture.remoteMain() })}\n`,
    );
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
};

const [mode, payload] = process.argv.slice(2);
if (mode === "inner") {
  const args = JSON.parse(payload ?? "{}") as Parameters<typeof inner>[0];
  process.stdout.write(`${JSON.stringify(await inner(args))}\n`);
} else {
  await outer();
}
