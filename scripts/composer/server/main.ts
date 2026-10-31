import { ensureCert, trackBusy, watchRenewal } from "./cert";
import { parseConfig } from "./config";
import { createServer } from "./http";
import { log } from "./log";
import { createPads } from "./pads";
import { createPipeline } from "./pipeline";

const main = async () => {
  const config = parseConfig(process.env);
  let stop: () => Promise<void> = async () => process.exit(0);
  const onSignal = () => void stop();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  if (config.acme) await ensureCert(config.acme);

  const pads = createPads(config);
  const { pipeline, whenIdle } = trackBusy(createPipeline(config, { pads }));
  const server = await createServer(config, pipeline, pads);
  log("started", { appPort: server.appPort, proofPort: server.proofPort });

  stop = async () => {
    log("stopping");
    await server.stop();
    // Uid 0 has no CAP_KILL, so it cannot signal a build. The end of the
    // container stops the build.
    await pipeline.close().catch((error: unknown) => {
      log("close-failed", { message: String(error) });
    });
    process.exit(0);
  };
  if (config.acme) {
    watchRenewal({ acme: config.acme, whenIdle, restartToLoadCert: stop });
  }
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
