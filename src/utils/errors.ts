/**
 * An error whose message is written for a human operator: what went wrong,
 * what was checked, and what to do about it. Stack traces are suppressed.
 */
export class PipelineError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "PipelineError";
    this.hint = hint;
  }
}

export function formatError(err: unknown): string {
  if (err instanceof PipelineError) {
    return err.hint ? `${err.message}\n\n${err.hint}` : err.message;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}${err.stack ? `\n\n${err.stack}` : ""}`;
  }
  return String(err);
}

/** Run a CLI entry point, printing readable errors and exiting non-zero on failure. */
export function runMain(main: () => Promise<number | void>): void {
  main()
    .then((code) => {
      process.exitCode = typeof code === "number" ? code : 0;
    })
    .catch((err: unknown) => {
      console.error("");
      console.error("ERROR");
      console.error("-----");
      console.error(formatError(err));
      console.error("");
      process.exitCode = 1;
    });
}
