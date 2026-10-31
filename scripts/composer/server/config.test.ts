import { describe, expect, test } from "bun:test";
import { SITE } from "../../../src/site";
import { parseConfig } from "./config";

const ENV = {
  COMPOSER_DATA: "/data",
  COMPOSER_REMOTE: "git@github.com:owner/repo.git",
  COMPOSER_APP_ORIGIN: "https://compose.example.com",
  COMPOSER_PROOF_ORIGIN: "https://compose.example.com:8444",
  COMPOSER_APP_PORT: "443",
  COMPOSER_PROOF_PORT: "8444",
  COMPOSER_TOKEN_FILE: "/run/token",
  COMPOSER_AUTHOR_NAME: "Composer",
  COMPOSER_AUTHOR_EMAIL: "composer@example.com",
  COMPOSER_SHELL_DIR: "/app/shell",
};

describe("parseConfig", () => {
  test("gives defaults for the optional values", () => {
    expect(parseConfig(ENV)).toEqual({
      dataDir: "/data",
      remote: ENV.COMPOSER_REMOTE,
      appOrigin: ENV.COMPOSER_APP_ORIGIN,
      proofOrigin: ENV.COMPOSER_PROOF_ORIGIN,
      appPort: 443,
      proofPort: 8444,
      tokenFile: "/run/token",
      sshKeyFile: undefined,
      knownHostsFile: undefined,
      tls: { kind: "plain" },
      author: { name: "Composer", email: "composer@example.com" },
      shellDir: "/app/shell",
      sandboxUid: undefined,
      siteUrl: SITE.url,
      buildTimeoutSeconds: 120,
    });
  });

  test("reads the optional values", () => {
    expect(
      parseConfig({
        ...ENV,
        COMPOSER_SSH_KEY_FILE: "/run/key",
        COMPOSER_KNOWN_HOSTS_FILE: "/run/hosts",
        COMPOSER_CERT_FILE: "/run/cert",
        COMPOSER_KEY_FILE: "/run/tls",
        COMPOSER_SANDBOX_UID: "1001",
        COMPOSER_SITE_URL: "https://site.test/",
        COMPOSER_BUILD_TIMEOUT_SECONDS: "5",
      }),
    ).toMatchObject({
      sshKeyFile: "/run/key",
      knownHostsFile: "/run/hosts",
      tls: { kind: "files", cert: "/run/cert", key: "/run/tls" },
      sandboxUid: 1001,
      siteUrl: "https://site.test",
      buildTimeoutSeconds: 5,
    });
  });

  test("names every missing value", () => {
    expect(() => parseConfig({})).toThrow(
      new RegExp(Object.keys(ENV).join("[^]*")),
    );
  });

  test("treats a blank value as missing", () => {
    expect(() => parseConfig({ ...ENV, COMPOSER_DATA: "  " })).toThrow(
      "COMPOSER_DATA is missing",
    );
  });

  test.each([
    ["COMPOSER_CERT_FILE", "/run/cert"],
    ["COMPOSER_KEY_FILE", "/run/key"],
  ])("refuses %s alone", (name, value) => {
    expect(() => parseConfig({ ...ENV, [name]: value })).toThrow("both be set");
  });

  test.each([
    ["COMPOSER_APP_PORT", "eighty", "must be a port number"],
    ["COMPOSER_PROOF_PORT", "70000", "must be a port number"],
    ["COMPOSER_APP_ORIGIN", "compose.example.com", "must be a bare origin"],
    ["COMPOSER_PROOF_ORIGIN", "https://a.test/path", "must be a bare origin"],
    ["COMPOSER_SANDBOX_UID", "root", "must be a whole number"],
    ["COMPOSER_SITE_URL", "not a url", "must be a URL"],
  ])("refuses a bad %s", (name, value, message) => {
    expect(() => parseConfig({ ...ENV, [name]: value })).toThrow(message);
  });
});
