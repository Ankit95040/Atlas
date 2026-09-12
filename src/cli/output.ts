// Shared CLI output helpers (M12).
//
// Conventions: human-readable text on stdout by default; `--json` prints the
// same underlying result object as JSON. Errors always go to stderr so that
// `--json` stdout stays machine-parseable. Exit codes: 0 success, 1 usage /
// validation / refusal, 2 completed-but-unfavorable (halted train, failed
// tasks). No domain logic lives here — formatting only.

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_HALTED = 2;

export interface CommandOutput {
  readonly exitCode: number;
  readonly human: string;
  readonly data: unknown;
}

/** Print a command result: JSON envelope or human text on stdout. */
export function writeCommandOutput(output: CommandOutput, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: output.exitCode === EXIT_OK, ...asRecord(output.data) }));
    return;
  }
  console.log(output.human);
}

/** Print a command failure: JSON envelope or `atlas: error:` line on stderr. */
export function writeCommandError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }));
    return;
  }
  console.error(`atlas: error: ${message}`);
}

function asRecord(data: unknown): Record<string, unknown> {
  if (typeof data === "object" && data !== null) {
    return data as Record<string, unknown>;
  }
  return { value: data };
}
