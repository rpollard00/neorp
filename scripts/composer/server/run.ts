export const hostPath = () => process.env.PATH ?? "";

export const run = async ({
  cmd,
  env,
  cwd,
  stdin,
}: {
  cmd: string[];
  env: Record<string, string>;
  cwd?: string;
  stdin?: string | Uint8Array;
}) => {
  const child = Bun.spawn(cmd, {
    env,
    cwd,
    stdin:
      stdin === undefined
        ? "ignore"
        : typeof stdin === "string"
          ? new TextEncoder().encode(stdin)
          : stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutBytes, stderr, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    code,
    stdout: new TextDecoder().decode(stdoutBytes),
    stdoutBytes,
    stderr,
  };
};
