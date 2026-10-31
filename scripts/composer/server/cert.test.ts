import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureCert, trackBusy, watchRenewal } from "./cert";
import { parseConfig, type Acme } from "./config";
import type { Pipeline } from "./pipeline";

setDefaultTimeout(30_000);

const FAST = { firstRetryMs: 1, maxRetryMs: 4, renewEveryMs: 1 };
const MAIN = join(import.meta.dir, "main.ts");

let dir: string;
let acme: Acme;
const realPath = process.env.PATH;

const fakeLego = async (body: string) => {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const file = join(bin, "lego");
  await writeFile(
    file,
    `#!/bin/sh
env > "${dir}/env"
printf '%s\\n' "$@" > "${dir}/args"
calls=$(($(cat "${dir}/calls" 2>/dev/null || echo 0) + 1))
echo "$calls" > "${dir}/calls"
write_cert() { mkdir -p "${dirname(acme.cert)}"; echo "cert $calls" > "${acme.cert}"; echo key > "${acme.key}"; }
${body}
`,
  );
  await chmod(file, 0o755);
  process.env.PATH = `${bin}:${realPath}`;
};

const calls = async () =>
  Number(await readFile(join(dir, "calls"), "utf8").catch(() => "0"));

const waitFor = async (condition: () => Promise<boolean>) => {
  for (let tries = 0; tries < 2_000; tries += 1) {
    if (await condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("The condition did not become true.");
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "composer-cert-"));
  const certs = join(dir, "lego", "certificates");
  acme = {
    domain: "compose.test",
    email: "owner@example.com",
    tokenFile: join(dir, "cloudflare-token"),
    dir: join(dir, "lego"),
    cert: join(certs, "compose.test.crt"),
    key: join(certs, "compose.test.key"),
  };
});

afterEach(async () => {
  process.env.PATH = realPath;
  await rm(dir, { recursive: true, force: true });
});

describe("ensureCert", () => {
  test("does not run lego when a certificate exists", async () => {
    await fakeLego("exit 1");
    await mkdir(dirname(acme.cert), { recursive: true });
    await writeFile(acme.cert, "cert");
    await writeFile(acme.key, "key");
    await ensureCert(acme, FAST);
    expect(await calls()).toBe(0);
  });

  test("runs lego with flags of the pinned version and the token file only", async () => {
    await fakeLego("write_cert");
    await ensureCert(acme, FAST);
    const args = (await readFile(join(dir, "args"), "utf8")).trim().split("\n");
    expect(args).toEqual([
      "--log.format",
      "text",
      "run",
      "--accept-tos",
      "--email",
      "owner@example.com",
      "--domains",
      "compose.test",
      "--dns",
      "cloudflare",
      "--dns.resolvers",
      "1.1.1.1:53",
      "--path",
      acme.dir,
      "--renew-days",
      "30",
    ]);
    const env = await readFile(join(dir, "env"), "utf8");
    expect(env).toContain(`CLOUDFLARE_DNS_API_TOKEN_FILE=${acme.tokenFile}\n`);
    expect(env).not.toContain("CLOUDFLARE_DNS_API_TOKEN=");
    expect(env).not.toContain("COMPOSER_");
  });

  test("retries a failed issue with growing waits, and returns only with a certificate", async () => {
    await fakeLego(`[ "$calls" -lt 5 ] && exit 1\nwrite_cert`);
    const sleep = spyOn(Bun, "sleep");
    await ensureCert(acme, FAST);
    const delays = sleep.mock.calls.map(([ms]) => ms);
    sleep.mockRestore();
    expect(await calls()).toBe(5);
    expect(delays).toEqual([1, 2, 4, 4]);
  });

  test("retries when lego exits 0 and leaves no key", async () => {
    await fakeLego(`[ "$calls" -lt 2 ] && exit 0\nwrite_cert`);
    await ensureCert(acme, FAST);
    expect(await calls()).toBe(2);
  });
});

describe("watchRenewal", () => {
  const issued = async () => {
    await mkdir(dirname(acme.cert), { recursive: true });
    await writeFile(acme.cert, "first cert");
    await writeFile(acme.key, "key");
  };

  test("keeps checking and does not restart while the certificate stays the same", async () => {
    await issued();
    await fakeLego("exit 0");
    let restarts = 0;
    const stop = watchRenewal({
      acme,
      whenIdle: () => Promise.resolve(),
      restartToLoadCert: async () => {
        restarts += 1;
      },
      timing: FAST,
    });
    await waitFor(async () => (await calls()) >= 3);
    stop();
    expect(restarts).toBe(0);
  });

  test("a failed check does not restart, and the next check still runs", async () => {
    await issued();
    await fakeLego(`[ "$calls" -lt 2 ] && exit 1\nexit 0`);
    let restarts = 0;
    const stop = watchRenewal({
      acme,
      whenIdle: () => Promise.resolve(),
      restartToLoadCert: async () => {
        restarts += 1;
      },
      timing: FAST,
    });
    await waitFor(async () => (await calls()) >= 2);
    stop();
    expect(restarts).toBe(0);
  });

  test("a new certificate restarts once, after the queue is idle", async () => {
    await issued();
    await fakeLego("write_cert");
    let finishJob = () => {};
    const events: string[] = [];
    const restarted = new Promise<void>((resolve) => {
      watchRenewal({
        acme,
        whenIdle: () =>
          new Promise<void>((resume) => {
            events.push("waiting");
            finishJob = () => {
              events.push("idle");
              resume();
            };
          }),
        restartToLoadCert: async () => {
          events.push("restart");
          resolve();
        },
        timing: FAST,
      });
    });
    await waitFor(async () => events.length > 0);
    await Bun.sleep(20);
    expect(events).toEqual(["waiting"]);
    finishJob();
    await restarted;
    expect(events).toEqual(["waiting", "idle", "restart"]);
    expect(await calls()).toBe(1);
  });
});

describe("trackBusy", () => {
  const pending = () => {
    let finish = (_error?: Error) => {};
    const job = new Promise<never>((_resolve, reject) => {
      finish = (error) => reject(error ?? new Error("done"));
    });
    return { job, finish };
  };

  test("whenIdle waits for all jobs, also a job that fails", async () => {
    const first = pending();
    const second = pending();
    const { pipeline, whenIdle } = trackBusy({
      prove: () => first.job,
      ship: () => second.job,
      tags: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    } satisfies Pipeline);
    const running = [
      pipeline.prove({ pad: {} as never }).catch(() => undefined),
      pipeline.ship({ sha: "" as never }).catch(() => undefined),
    ];
    let idle = false;
    const waited = whenIdle().then(() => {
      idle = true;
    });
    first.finish();
    await running[0];
    await Bun.sleep(1);
    expect(idle).toBe(false);
    second.finish();
    await Promise.all([...running, waited]);
    expect(idle).toBe(true);
  });

  test("whenIdle answers at once with no job", async () => {
    const { whenIdle } = trackBusy({
      prove: () => Promise.reject(new Error("unused")),
      ship: () => Promise.reject(new Error("unused")),
      tags: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    });
    await whenIdle();
  });
});

describe("the certificate settings", () => {
  const base = {
    COMPOSER_DATA: "/data",
    COMPOSER_REMOTE: "git@example.com:a/b.git",
    COMPOSER_APP_ORIGIN: "https://compose.example.com",
    COMPOSER_PROOF_ORIGIN: "https://compose.example.com:8444",
    COMPOSER_APP_PORT: "443",
    COMPOSER_PROOF_PORT: "8444",
    COMPOSER_TOKEN_FILE: "/run/secrets/pair-token",
    COMPOSER_AUTHOR_NAME: "Owner",
    COMPOSER_AUTHOR_EMAIL: "owner@example.com",
    COMPOSER_SHELL_DIR: "/app/shell",
  };
  const withAcme = {
    ...base,
    COMPOSER_ACME_EMAIL: "owner@example.com",
    COMPOSER_CLOUDFLARE_TOKEN_FILE: "/run/secrets/cloudflare-token",
  };

  test("with no ACME values, there is no acme and TLS stays plain", () => {
    const config = parseConfig(base);
    expect(config.acme).toBeUndefined();
    expect(config.tls).toEqual({ kind: "plain" });
  });

  test("the hostname of the app origin names the certificate files", () => {
    const config = parseConfig(withAcme);
    const stem = "/data/lego/certificates/compose.example.com";
    expect(config.acme).toEqual({
      domain: "compose.example.com",
      email: "owner@example.com",
      tokenFile: "/run/secrets/cloudflare-token",
      dir: "/data/lego",
      cert: `${stem}.crt`,
      key: `${stem}.key`,
    });
    expect(config.tls).toEqual({
      kind: "files",
      cert: `${stem}.crt`,
      key: `${stem}.key`,
    });
  });

  test.each([
    ["only the email", { ...base, COMPOSER_ACME_EMAIL: "a@example.com" }],
    ["only the token", { ...base, COMPOSER_CLOUDFLARE_TOKEN_FILE: "/token" }],
    ["plain http", { ...withAcme, COMPOSER_APP_ORIGIN: "http://compose.test" }],
    [
      "fixed certificate files",
      {
        ...withAcme,
        COMPOSER_CERT_FILE: "/cert",
        COMPOSER_KEY_FILE: "/key",
      },
    ],
  ])("refuses %s", (_name, env) => {
    expect(() => parseConfig(env)).toThrow("The composer config has errors");
  });
});

describe("the server process", () => {
  const makeKeyPair = async () => {
    const pair = join(dir, "pair");
    await mkdir(pair);
    const made = Bun.spawnSync([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(pair, "key"),
      "-out",
      join(pair, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=compose.test",
    ]);
    expect(made.exitCode).toBe(0);
    return pair;
  };

  test("starts only with a certificate, and a renewal exits with code 0", async () => {
    const pair = await makeKeyPair();
    await fakeLego(`mkdir -p "${dirname(acme.cert)}"
cp "${pair}/key" "${acme.key}"
cp "${pair}/cert" "${acme.cert}"
[ "$calls" -eq 2 ] && echo "# new" >> "${acme.cert}"
exit 0`);
    const shell = join(dir, "shell");
    await mkdir(shell);
    const tokenFile = join(dir, "pair-token");
    await writeFile(tokenFile, "a-pair-token\n");
    const child = Bun.spawn(["bun", "--no-install", MAIN], {
      env: {
        PATH: process.env.PATH,
        COMPOSER_DATA: dir,
        COMPOSER_REMOTE: join(dir, "remote.git"),
        COMPOSER_APP_ORIGIN: "https://compose.test",
        COMPOSER_PROOF_ORIGIN: "https://compose.test:8444",
        COMPOSER_APP_PORT: "0",
        COMPOSER_PROOF_PORT: "0",
        COMPOSER_TOKEN_FILE: tokenFile,
        COMPOSER_AUTHOR_NAME: "Owner",
        COMPOSER_AUTHOR_EMAIL: "owner@example.com",
        COMPOSER_SHELL_DIR: shell,
        COMPOSER_ACME_EMAIL: "owner@example.com",
        COMPOSER_CLOUDFLARE_TOKEN_FILE: acme.tokenFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(errors).toBe("");
    expect(code).toBe(0);
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    expect(events).toEqual([
      "cert-issue",
      "cert-issued",
      "started",
      "cert-renewed",
      "stopping",
    ]);
  });
});
