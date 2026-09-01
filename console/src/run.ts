/**
 * Running a child process and collecting its output.
 *
 * This lives apart from `change.ts` so that `github-identity.ts` — which has
 * to run `gh auth token` before `change.ts` can run `gh` at all — can use it
 * without the two modules importing each other. `change.ts` re-exports every
 * name here, so callers that already imported them from there keep working.
 */

export type RunResult = { code: number; stdout: string; stderr: string };

export class CommandError extends Error {
  constructor(
    readonly command: string[],
    readonly result: RunResult,
  ) {
    super(
      `${command.join(" ")} exited with ${result.code}: ` +
        (result.stderr.trim() || result.stdout.trim()),
    );
    this.name = "CommandError";
  }
}

/**
 * `code` for a command that never produced an exit status of its own: the
 * executable could not be spawned, or the run was killed at `timeoutMs`. It is
 * outside the 0-255 range a process can exit with, so it cannot collide with a
 * real status, and every caller already treats "not 0" as a failure.
 */
export const RUN_FAILED = -1;

/** Resolution of a race that the command lost. */
const TIMED_OUT = Symbol("timed out");

/**
 * How long a timed-out command is given to die, per signal.
 *
 * SIGTERM first, so git removes the `.lock` files it holds instead of leaving
 * them for the next command to trip over, then SIGKILL. Once both graces are
 * spent the pipes are abandoned, so nothing the command started can hold `run`
 * for longer than `timeoutMs` plus the two graces.
 */
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 250;

/** A piped stream being read into memory as it arrives. */
type CollectedStream = {
  /** Everything received so far, decoded. */
  text: () => string;
  /** Resolves when the stream ended, or when `cancel` released it. */
  done: Promise<void>;
  /** Stop reading and release the pipe. */
  cancel: () => void;
};

/**
 * Read a pipe incrementally rather than with `new Response(stream).text()`.
 *
 * `text()` can be called at any time, so a command that is killed at its
 * timeout still reports the diagnostics it printed before it died, and
 * `cancel()` lets the caller stop waiting for a pipe that something other than
 * the command itself is still holding open.
 */
function collectStream(stream: ReadableStream<Uint8Array>): CollectedStream {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        if (value) chunks.push(value);
      }
    } catch {
      // Cancelled here, or broken with the process that was writing to it.
    }
  })();
  return {
    text: () => {
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(joined);
    },
    done,
    cancel: () => {
      void reader.cancel().catch(() => undefined);
    },
  };
}

/** Wait for `settled`, giving up after `ms` and reporting which one happened. */
async function raceDeadline<T>(
  settled: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<typeof TIMED_OUT>((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([settled, reached]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Signal a timed-out command and everything it started.
 *
 * A command that carries a timeout is spawned detached, so it leads its own
 * process group and the negative pid reaches its children too. That is the
 * part that matters here: `git push` starts `git-remote-https` or `ssh`, both
 * of which inherit the pipes, so signalling git alone leaves the pipes open
 * and the grandchild running.
 */
function signalTree(
  proc: ReturnType<typeof Bun.spawn>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  try {
    process.kill(-proc.pid, signal);
    return;
  } catch {
    // No such process group (it already exited, or it was never detached).
  }
  try {
    proc.kill(signal);
  } catch {
    // Already exited.
  }
}

/**
 * Run a command and collect its output.
 *
 * Two failure modes are turned into a `RunResult` rather than an exception,
 * because `deliverCard` is called from the console server, where an unhandled
 * rejection would take down a request handler:
 *
 *   - `Bun.spawn` throws synchronously when the executable is not on the PATH
 *     (no `gh` installed, for instance);
 *   - a command that never finishes would otherwise hang the caller for ever,
 *     so `timeoutMs` kills it and reports `RUN_FAILED`.
 *
 * `timeoutMs` bounds the elapsed time of the call, not just the life of the
 * command: the process group is signalled and, if the pipes are still held
 * after both graces, they are abandoned unread. Waiting for the pipes to close
 * used to be the last step, which meant a grandchild that inherited them
 * (`git push` starts `git-remote-https` or `ssh`) kept the call running for as
 * long as the grandchild lived - measured at 10.4 s for a 1 s timeout.
 *
 * Without a `timeoutMs` the call waits as long as the command takes, which is
 * what the CLI subcommands want, and the command is not detached: `setsid`
 * takes the controlling terminal away, and a CLI `git push` may still need it
 * to prompt for a credential.
 *
 * `env` is merged over a copy of the current environment. It exists so that a
 * secret can reach one command through its environment rather than through its
 * argument vector, which every process on the machine can read.
 */
export async function run(
  command: string[],
  cwd?: string,
  timeoutMs?: number,
  env?: Record<string, string>,
): Promise<RunResult> {
  const bounded = timeoutMs !== undefined && timeoutMs > 0;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, {
      cwd,
      // A copy of the current environment rather than the default: Bun resolves
      // the executable against the PATH of the environment it is handed, and the
      // default is the environment the process was started with, so a PATH set
      // after startup would otherwise be ignored. `env` is layered on top of
      // that copy, which is how a credential is handed to one command without
      // putting it on the command line, where `ps` would show it.
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // Its own process group, so `signalTree` can reach the whole tree. Only
      // when there is a timeout to enforce; see the note about the terminal.
      detached: bounded,
    });
  } catch (error) {
    return {
      code: RUN_FAILED,
      stdout: "",
      stderr: `${command.join(" ")}: ${(error as Error).message}\n`,
    };
  }

  const out = collectStream(proc.stdout as ReadableStream<Uint8Array>);
  const err = collectStream(proc.stderr as ReadableStream<Uint8Array>);
  const finished = (async (): Promise<number> => {
    await Promise.all([out.done, err.done]);
    try {
      return await proc.exited;
    } catch {
      return RUN_FAILED;
    }
  })();

  if (!bounded) {
    const code = await finished;
    return { code, stdout: out.text(), stderr: err.text() };
  }

  const settled = await raceDeadline(finished, timeoutMs!);
  if (settled !== TIMED_OUT) {
    return { code: settled, stdout: out.text(), stderr: err.text() };
  }

  signalTree(proc, "SIGTERM");
  if ((await raceDeadline(finished, TERM_GRACE_MS)) === TIMED_OUT) {
    signalTree(proc, "SIGKILL");
    await raceDeadline(finished, KILL_GRACE_MS);
  }
  // Whatever still holds the pipes is not waited for any longer.
  out.cancel();
  err.cancel();
  return {
    code: RUN_FAILED,
    stdout: out.text(),
    stderr: `${err.text()}${command.join(" ")}: timed out after ${timeoutMs}ms\n`,
  };
}

export async function runOrThrow(
  command: string[],
  cwd?: string,
  timeoutMs?: number,
  env?: Record<string, string>,
): Promise<RunResult> {
  const result = await run(command, cwd, timeoutMs, env);
  if (result.code !== 0) throw new CommandError(command, result);
  return result;
}
