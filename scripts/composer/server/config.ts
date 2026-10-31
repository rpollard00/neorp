import { join } from "node:path";
import { SITE } from "../../../src/site";

export type Tls =
  { kind: "plain" } | { kind: "files"; cert: string; key: string };

export type Acme = {
  domain: string;
  email: string;
  tokenFile: string;
  dir: string;
  cert: string;
  key: string;
};

export type Config = {
  dataDir: string;
  remote: string;
  appOrigin: string;
  proofOrigin: string;
  appPort: number;
  proofPort: number;
  tokenFile: string;
  sshKeyFile?: string;
  knownHostsFile?: string;
  tls: Tls;
  acme?: Acme;
  author: { name: string; email: string };
  shellDir: string;
  sandboxUid?: number;
  siteUrl: string;
  buildTimeoutSeconds: number;
};

const DEFAULT_BUILD_TIMEOUT_SECONDS = 120;

const REQUIRED = [
  "COMPOSER_DATA",
  "COMPOSER_REMOTE",
  "COMPOSER_APP_ORIGIN",
  "COMPOSER_PROOF_ORIGIN",
  "COMPOSER_APP_PORT",
  "COMPOSER_PROOF_PORT",
  "COMPOSER_TOKEN_FILE",
  "COMPOSER_AUTHOR_NAME",
  "COMPOSER_AUTHOR_EMAIL",
  "COMPOSER_SHELL_DIR",
] as const;

const parseOrigin = (value: string) => {
  try {
    const url = new URL(value);
    return url.origin === value.replace(/\/$/, "") ? url.origin : undefined;
  } catch {
    return undefined;
  }
};

const parseWhole = ({ value, max }: { value: string; max: number }) => {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return parsed <= max ? parsed : undefined;
};

export const parseConfig = (
  env: Record<string, string | undefined>,
): Config => {
  const value = (name: string) => env[name]?.trim() || undefined;
  const required = (name: (typeof REQUIRED)[number]) => value(name) ?? "";

  const problems = REQUIRED.flatMap((name) =>
    value(name) ? [] : [`${name} is missing`],
  );

  const origin = (name: "COMPOSER_APP_ORIGIN" | "COMPOSER_PROOF_ORIGIN") => {
    const raw = value(name);
    const parsed = raw && parseOrigin(raw);
    if (raw && !parsed) problems.push(`${name} must be a bare origin`);
    return parsed ?? "";
  };

  const port = (name: "COMPOSER_APP_PORT" | "COMPOSER_PROOF_PORT") => {
    const raw = value(name);
    const parsed = raw ? parseWhole({ value: raw, max: 65535 }) : undefined;
    if (raw && parsed === undefined) {
      problems.push(`${name} must be a port number`);
    }
    return parsed ?? 0;
  };

  const whole = ({ name, max }: { name: string; max: number }) => {
    const raw = value(name);
    if (!raw) return undefined;
    const parsed = parseWhole({ value: raw, max });
    if (parsed === undefined) problems.push(`${name} must be a whole number`);
    return parsed;
  };

  const cert = value("COMPOSER_CERT_FILE");
  const key = value("COMPOSER_KEY_FILE");
  if (Boolean(cert) !== Boolean(key)) {
    problems.push(
      "COMPOSER_CERT_FILE and COMPOSER_KEY_FILE must both be set, or both be unset",
    );
  }

  const email = value("COMPOSER_ACME_EMAIL");
  const tokenFile = value("COMPOSER_CLOUDFLARE_TOKEN_FILE");
  if (Boolean(email) !== Boolean(tokenFile)) {
    problems.push(
      "COMPOSER_ACME_EMAIL and COMPOSER_CLOUDFLARE_TOKEN_FILE must both be set, or both be unset",
    );
  }
  if (email && cert) {
    problems.push(
      "COMPOSER_ACME_EMAIL and COMPOSER_CERT_FILE cannot both be set",
    );
  }

  const appOrigin = origin("COMPOSER_APP_ORIGIN");
  if (email && appOrigin && !appOrigin.startsWith("https://")) {
    problems.push("COMPOSER_ACME_EMAIL needs an https COMPOSER_APP_ORIGIN");
  }
  const proofOrigin = origin("COMPOSER_PROOF_ORIGIN");
  const appPort = port("COMPOSER_APP_PORT");
  const proofPort = port("COMPOSER_PROOF_PORT");
  const sandboxUid = whole({ name: "COMPOSER_SANDBOX_UID", max: 2 ** 31 - 1 });
  const buildTimeoutSeconds = whole({
    name: "COMPOSER_BUILD_TIMEOUT_SECONDS",
    max: 3600,
  });
  const siteUrl = value("COMPOSER_SITE_URL") ?? SITE.url;
  if (!URL.canParse(siteUrl)) problems.push("COMPOSER_SITE_URL must be a URL");

  if (problems.length > 0) {
    throw new Error(
      `The composer config has errors:\n- ${problems.join("\n- ")}`,
    );
  }

  const dataDir = required("COMPOSER_DATA");
  const acme = ((): Acme | undefined => {
    if (!email || !tokenFile) return undefined;
    const domain = new URL(appOrigin).hostname;
    const dir = join(dataDir, "lego");
    const stem = join(dir, "certificates", domain);
    return {
      domain,
      email,
      tokenFile,
      dir,
      cert: `${stem}.crt`,
      key: `${stem}.key`,
    };
  })();

  const tls = (): Tls => {
    if (acme) return { kind: "files", cert: acme.cert, key: acme.key };
    return cert && key ? { kind: "files", cert, key } : { kind: "plain" };
  };

  return {
    dataDir,
    remote: required("COMPOSER_REMOTE"),
    appOrigin,
    proofOrigin,
    appPort,
    proofPort,
    tokenFile: required("COMPOSER_TOKEN_FILE"),
    sshKeyFile: value("COMPOSER_SSH_KEY_FILE"),
    knownHostsFile: value("COMPOSER_KNOWN_HOSTS_FILE"),
    tls: tls(),
    acme,
    author: {
      name: required("COMPOSER_AUTHOR_NAME"),
      email: required("COMPOSER_AUTHOR_EMAIL"),
    },
    shellDir: required("COMPOSER_SHELL_DIR"),
    sandboxUid,
    siteUrl: siteUrl.replace(/\/+$/, ""),
    buildTimeoutSeconds: buildTimeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS,
  };
};
