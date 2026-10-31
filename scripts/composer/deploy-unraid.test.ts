import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "deploy-unraid");
const PREVIOUS = "composer:20261001000000";
const LOG_TAIL =
  '{"event":"cert-issue-failed","retryInMs":300000,"tail":["dns: no zone"]}';

let dir: string;

const stub = async (name: string, body: string) => {
  const file = join(dir, "bin", name);
  await writeFile(file, `#!/bin/bash\nT=${dir}\n${body}\n`);
  await chmod(file, 0o755);
};

/** `T/existing` is the answer of `docker ps`. `T/up-after` is the number of `docker run` calls before curl connects. */
const stubs = async () => {
  await stub(
    "ssh",
    `shift 7
cmd="$*"
printf '%s\\n' "$cmd" >> $T/calls
[[ $cmd == *'cat >'* || $cmd == 'docker load' ]] && cat > /dev/null
case $cmd in
  'docker ps -a'*) cat $T/existing ;;
  'docker inspect'*) cat $T/running ;;
  'docker logs'*) cat $T/log ;;
esac
exit 0`,
  );
  await stub("docker", `[[ $1 == save ]] && echo image-bytes\nexit 0`);
  await stub("bun", "exit 0");
  await stub("sleep", "exit 0");
  await stub(
    "curl",
    `[[ $* == *'@-'* ]] && cat > /dev/null
(($(grep -c '^docker run' $T/calls) > $(cat $T/up-after))) || exit 7
case $* in
  *api/pair*) printf 'HTTP/1.1 200 OK\\r\\nset-cookie: composer=abc; HttpOnly\\r\\n\\r\\n' ;;
  *api/pads*) echo '[]' ;;
  *:8444/*) printf 401 ;;
  *) printf text/html ;;
esac`,
  );
};

const given = async (state: {
  existing: string;
  upAfter: number;
  running?: boolean;
  log?: string;
}) => {
  await writeFile(join(dir, "existing"), state.existing);
  await writeFile(join(dir, "up-after"), String(state.upAfter));
  await writeFile(join(dir, "running"), `${state.running ?? true}\n`);
  await writeFile(join(dir, "log"), `${state.log ?? LOG_TAIL}\n`);
};

const deploy = async () => {
  const child = Bun.spawn([SCRIPT, "deploy"], {
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      COMPOSER_DEPLOY_CONFIG: join(dir, "deploy.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const calls = await readFile(join(dir, "calls"), "utf8");
  return { code, output: out + err, calls: calls.split("\n") };
};

const removed = (calls: string[]) =>
  calls.filter((call) => call.startsWith("docker rm -f composer"));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "composer-deploy-"));
  await mkdir(join(dir, "bin"));
  await stubs();
  await writeFile(join(dir, "calls"), "");
  const secret = (name: string) =>
    writeFile(join(dir, name), "SECRET\n", { mode: 0o600 });
  await Promise.all(["key", "cf", "pair"].map(secret));
  await writeFile(
    join(dir, "deploy.json"),
    JSON.stringify({
      sshTarget: "root@composer-smoke.invalid",
      ip: "127.0.0.1",
      authorName: "Owner",
      authorEmail: "owner@example.com",
      acmeEmail: "owner@example.com",
      deployKeyFile: join(dir, "key"),
      cloudflareTokenFile: join(dir, "cf"),
      pairTokenFile: join(dir, "pair"),
    }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("deploy when the new container does not answer", () => {
  test("a first deploy keeps the container that retries the certificate", async () => {
    await given({ existing: "", upAfter: 99 });

    const { code, output, calls } = await deploy();

    expect(code).not.toBe(0);
    expect(removed(calls)).toEqual([]);
    expect(output).toContain(LOG_TAIL);
    expect(output).toContain("The certificate is not issued yet");
    expect(output).toContain("tries again by itself");
    expect(output).toContain("deploy-unraid status");
    expect(output).not.toContain("NO CONTAINER RUNS");
  });

  test("a first deploy with no failed try says only that the container stays", async () => {
    await given({ existing: "", upAfter: 99, log: '{"event":"cert-issue"}' });

    const { code, output, calls } = await deploy();

    expect(code).not.toBe(0);
    expect(removed(calls)).toEqual([]);
    expect(output).not.toContain("The certificate is not issued yet");
    expect(output).toContain("stays running");
    expect(output).toContain("deploy-unraid status");
  });

  test("a first deploy removes a container that stopped", async () => {
    await given({ existing: "", upAfter: 99, running: false });

    const { code, output, calls } = await deploy();

    expect(code).not.toBe(0);
    expect(removed(calls)).toHaveLength(1);
    expect(output).toContain("NO CONTAINER RUNS");
  });

  test("an update goes back to the previous image", async () => {
    await given({ existing: `1|${PREVIOUS}`, upAfter: 1 });

    const { code, output, calls } = await deploy();

    expect(code).not.toBe(0);
    expect(removed(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("docker run")).at(-1)).toContain(
      `${PREVIOUS} >/dev/null`,
    );
    expect(output).toContain(`Went back to ${PREVIOUS}`);
  });
});

test("a first deploy that answers succeeds and removes nothing", async () => {
  await given({ existing: "", upAfter: 0 });

  const { code, output, calls } = await deploy();

  expect(code).toBe(0);
  expect(removed(calls)).toEqual([]);
  expect(output).toContain("Deployed composer:");
});
