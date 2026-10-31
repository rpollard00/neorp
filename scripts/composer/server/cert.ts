import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type { Acme } from "./config";
import { log } from "./log";
import type { Pipeline } from "./pipeline";
import { hostPath, run } from "./run";

/** The renewal check can include the random wait of lego, of up to 8 minutes. */
const LEGO_LIMIT = ["timeout", "--kill-after=10", "1800"];
const TAIL_LINES = 5;

/** The first retry waits long, so failed tries stay under the limit of the CA. */
const TIMING = {
  firstRetryMs: 5 * 60_000,
  maxRetryMs: 6 * 3_600_000,
  renewEveryMs: 24 * 3_600_000,
};

/**
 * `lego run` gets a certificate, or renews it when it is due. It writes nothing
 * and exits 0 when the certificate is not due. The local Pi-hole has a private
 * record for this name, so lego must ask a public resolver.
 */
const runLego = async ({ domain, email, tokenFile, dir }: Acme) => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { code, stderr } = await run({
    cmd: [
      ...LEGO_LIMIT,
      "lego",
      "--log.format",
      "text",
      "run",
      "--accept-tos",
      "--email",
      email,
      "--domains",
      domain,
      "--dns",
      "cloudflare",
      "--dns.resolvers",
      "1.1.1.1:53",
      "--path",
      dir,
      "--renew-days",
      "30",
    ],
    env: { PATH: hostPath(), CLOUDFLARE_DNS_API_TOKEN_FILE: tokenFile },
  });
  return { code, tail: stderr.trimEnd().split("\n").slice(-TAIL_LINES) };
};

const hasCert = async ({ cert, key }: Acme) => {
  const [certText, keyText] = await Promise.all(
    [cert, key].map((file) => readFile(file, "utf8").catch(() => "")),
  );
  return Boolean(certText.trim() && keyText.trim());
};

const certHash = async ({ cert }: Acme) =>
  createHash("sha256")
    .update(await readFile(cert).catch(() => ""))
    .digest("hex");

export const ensureCert = async (acme: Acme, timing = TIMING) => {
  let delay = timing.firstRetryMs;
  while (!(await hasCert(acme))) {
    log("cert-issue", { domain: acme.domain });
    const { code, tail } = await runLego(acme);
    if (await hasCert(acme)) {
      log("cert-issued", { domain: acme.domain });
      return;
    }
    log("cert-issue-failed", { code, retryInMs: delay, tail });
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, timing.maxRetryMs);
  }
};

const renew = async (acme: Acme) => {
  const before = await certHash(acme);
  const { code, tail } = await runLego(acme);
  const renewed = (await certHash(acme)) !== before;
  if (code !== 0 && !renewed) log("cert-renew-failed", { code, tail });
  return renewed;
};

export const watchRenewal = ({
  acme,
  whenIdle,
  restartToLoadCert,
  timing = TIMING,
}: {
  acme: Acme;
  whenIdle: () => Promise<void>;
  restartToLoadCert: () => Promise<void>;
  timing?: typeof TIMING;
}) => {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      if (await renew(acme)) {
        log("cert-renewed", { domain: acme.domain });
        await whenIdle();
        await restartToLoadCert();
        return;
      }
      await Bun.sleep(timing.renewEveryMs);
    }
  })();
  return () => {
    stopped = true;
  };
};

export const trackBusy = (pipeline: Pipeline) => {
  let busy = 0;
  const waiting = new Set<() => void>();

  const track =
    <A extends unknown[], R>(job: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      busy += 1;
      try {
        return await job(...args);
      } finally {
        busy -= 1;
        if (busy === 0) {
          for (const resume of waiting) resume();
          waiting.clear();
        }
      }
    };

  return {
    pipeline: {
      ...pipeline,
      prove: track(pipeline.prove),
      ship: track(pipeline.ship),
      tags: track(pipeline.tags),
    },
    whenIdle: () =>
      busy === 0
        ? Promise.resolve()
        : new Promise<void>((resume) => waiting.add(resume)),
  };
};
