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
  stdin?: string;
}) => {
  const child = Bun.spawn(cmd, {
    env,
    cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
};
