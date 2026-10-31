type LogField = string | number | boolean | undefined | readonly string[];

/** Never pass pad text. */
export const log = (event: string, fields: Record<string, LogField> = {}) => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`,
  );
};
