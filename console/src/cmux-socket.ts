/**
 * NDJSON RPC client for the running cmux app's Unix socket.
 *
 * Wire format (one JSON object per line):
 *   request   {"id":"1","method":"surface.read_text","params":{...}}\n
 *   response  {"ok":true,"id":"1","result":{...}}\n
 *             {"ok":false,"id":"1","error":{"code":"...","message":"..."}}\n
 *
 * The `events.stream` method turns its connection into a one-way stream of
 * {"type":"ack"|"event"|"heartbeat",...} frames instead of a response, so
 * two separate connections are kept:
 *   (A) a command connection for request/response RPCs, and
 *   (B) a subscription connection for the event stream.
 * Both reconnect on their own; neither ever throws out of a handler.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";

const REQUEST_TIMEOUT_MS = 10_000;
/** The stream ack advertises 15-second heartbeats; three misses = dead peer. */
const STALL_TIMEOUT_MS = 45_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

/**
 * The socket is unreachable (connect failure, request timeout, or the
 * connection dropped before the reply). Callers may fall back to the CLI.
 */
export class CmuxSocketUnavailable extends Error {}

/** The cmux app answered the RPC with ok:false. */
export class CmuxRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------ socket path */

let socketPath: string | null = null;
/** The CLI fallback resolution (`cmux capabilities` → socket_path) runs once. */
let cliResolveTried = false;

function defaultSocketPath(): string {
  const env = process.env.CMUX_SOCK;
  if (env && env.length > 0) return env;
  return join(homedir(), ".local", "state", "cmux", "cmux.sock");
}

async function resolveSocketPathViaCli(): Promise<string | null> {
  // Dynamic import: cmux.ts imports this module, so a static import would
  // form a cycle at module-evaluation time.
  const { run } = await import("./cmux.ts");
  const result = await run(["capabilities"], 5_000);
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { socket_path?: unknown };
    return typeof parsed.socket_path === "string" && parsed.socket_path.length > 0
      ? parsed.socket_path
      : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- framing */

type LineHandlers = {
  onLine: (line: string) => void;
  onClose: () => void;
};

/**
 * Open one connection and deliver complete NDJSON lines to onLine.
 * Buffering splits on the newline byte (0x0A cannot occur inside a UTF-8
 * multi-byte sequence) and decodes each complete line, so multi-byte
 * characters split across TCP chunks are reassembled correctly.
 */
function dial(path: string, handlers: LineHandlers): Promise<Socket> {
  let buffer: Buffer = Buffer.alloc(0);
  return Bun.connect({
    unix: path,
    socket: {
      data(_socket, chunk: Buffer) {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        let index: number;
        while ((index = buffer.indexOf(0x0a)) !== -1) {
          const line = buffer.subarray(0, index).toString("utf8");
          buffer = buffer.subarray(index + 1);
          if (line.trim() !== "") handlers.onLine(line);
        }
      },
      close() {
        handlers.onClose();
      },
      error() {
        /* a close event follows; nothing to do here */
      },
    },
  });
}

/**
 * Connect using the resolved path (env CMUX_SOCK → default state path).
 * On the first-ever connect failure the path is re-resolved once through
 * `cmux capabilities`; afterwards failures surface as CmuxSocketUnavailable.
 */
async function connectTo(handlers: LineHandlers): Promise<Socket> {
  const path = socketPath ?? defaultSocketPath();
  try {
    const socket = await dial(path, handlers);
    socketPath = path;
    return socket;
  } catch (error) {
    if (!cliResolveTried) {
      cliResolveTried = true;
      const resolved = await resolveSocketPathViaCli().catch(() => null);
      if (resolved && resolved !== path) {
        try {
          const socket = await dial(resolved, handlers);
          socketPath = resolved;
          return socket;
        } catch {
          /* fall through to the shared error below */
        }
      }
    }
    throw new CmuxSocketUnavailable(
      `cmux socket unreachable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/* --------------------------------------------- (A) command connection */

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let commandSocket: Socket | null = null;
let commandConnecting: Promise<Socket> | null = null;
let nextRequestId = 1;
const pending = new Map<string, Pending>();

function rejectAllPending(reason: string): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new CmuxSocketUnavailable(reason));
  }
  pending.clear();
}

function handleCommandLine(line: string): void {
  let frame: {
    id?: unknown;
    ok?: unknown;
    result?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  try {
    frame = JSON.parse(line) as typeof frame;
  } catch {
    return;
  }
  if (typeof frame.id !== "string") return;
  const entry = pending.get(frame.id);
  if (!entry) return;
  pending.delete(frame.id);
  clearTimeout(entry.timer);
  if (frame.ok === true) {
    entry.resolve(frame.result);
  } else {
    entry.reject(
      new CmuxRpcError(
        typeof frame.error?.code === "string" ? frame.error.code : "error",
        typeof frame.error?.message === "string" ? frame.error.message : "cmux rpc failed",
      ),
    );
  }
}

/** Lazily (re)connect; a lost connection is re-dialed by the next request. */
function ensureCommandSocket(): Promise<Socket> {
  if (commandSocket) return Promise.resolve(commandSocket);
  if (!commandConnecting) {
    commandConnecting = connectTo({
      onLine: handleCommandLine,
      onClose: () => {
        commandSocket = null;
        rejectAllPending("cmux socket closed");
      },
    }).then(
      (socket) => {
        commandSocket = socket;
        commandConnecting = null;
        return socket;
      },
      (error: unknown) => {
        commandConnecting = null;
        throw error;
      },
    );
  }
  return commandConnecting;
}

/**
 * One request/response RPC over the command connection.
 * Throws CmuxRpcError on an ok:false reply and CmuxSocketUnavailable on
 * every transport problem (unreachable socket, timeout, disconnect).
 */
export async function request<T>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const socket = await ensureCommandSocket();
  const id = String(nextRequestId++);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // A peer that swallows one request will swallow the next; drop the
      // connection so the next request dials a fresh one.
      try {
        socket.end();
      } catch {
        /* already gone */
      }
      reject(new CmuxSocketUnavailable(`cmux rpc ${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(
        new CmuxSocketUnavailable(
          `cmux socket write failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}

/* ------------------------------------------ (B) subscription connection */

export type CmuxStreamEvent = {
  seq: number | null;
  name: string | null;
  category: string | null;
  surfaceId: string | null;
  workspaceId: string | null;
};

export type SubscriptionHandlers = {
  /** One event frame. Called for every event; keep this handler cheap. */
  onEvent: (event: CmuxStreamEvent) => void;
  /**
   * Stream continuity was lost: the cmux app restarted (boot_id changed)
   * or events were dropped between connections (resume.gap). Everything
   * derived from past events should be treated as stale.
   */
  onResync: () => void;
};

/**
 * Subscribe to the cmux event stream on a dedicated connection.
 * Reconnects forever with exponential backoff (500 ms → 10 s) and resumes
 * with after_seq so no events are lost across short drops. A connection
 * that stays silent for 45 s (three missed 15-second heartbeats) is
 * discarded and re-dialed. Returns a stop function.
 */
export function subscribeEvents(
  handlers: SubscriptionHandlers,
  categories: string[] = ["agent", "surface", "workspace"],
): () => void {
  let stopped = false;
  let socket: Socket | null = null;
  let backoff = BACKOFF_MIN_MS;
  let lastSeq: number | null = null;
  let lastBootId: string | null = null;
  let lastReceivedAt = Date.now();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const watchdog = setInterval(() => {
    if (socket && Date.now() - lastReceivedAt > STALL_TIMEOUT_MS) {
      const stale = socket;
      socket = null;
      try {
        stale.end();
      } catch {
        /* already gone */
      }
      scheduleReconnect();
    }
  }, 5_000);

  const onLine = (line: string) => {
    lastReceivedAt = Date.now();
    let frame: {
      type?: unknown;
      boot_id?: unknown;
      resume?: { gap?: unknown };
      seq?: unknown;
      name?: unknown;
      category?: unknown;
      surface_id?: unknown;
      workspace_id?: unknown;
    };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return;
    }
    if (frame.type === "ack") {
      backoff = BACKOFF_MIN_MS;
      const bootId = typeof frame.boot_id === "string" ? frame.boot_id : null;
      const gap = frame.resume?.gap === true;
      if ((lastBootId !== null && bootId !== lastBootId) || gap) {
        lastSeq = null;
        handlers.onResync();
      }
      lastBootId = bootId;
      return;
    }
    if (frame.type === "event") {
      const seq = typeof frame.seq === "number" ? frame.seq : null;
      if (seq !== null) lastSeq = seq;
      handlers.onEvent({
        seq,
        name: typeof frame.name === "string" ? frame.name : null,
        category: typeof frame.category === "string" ? frame.category : null,
        surfaceId: typeof frame.surface_id === "string" ? frame.surface_id : null,
        workspaceId: typeof frame.workspace_id === "string" ? frame.workspace_id : null,
      });
    }
    /* heartbeats only refresh lastReceivedAt */
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  };

  const connect = async () => {
    if (stopped) return;
    try {
      // `self` ties the close handler to this dial, so a stale socket's
      // late close event can never tear down a newer connection.
      let self: Socket | null = null;
      const next = await connectTo({
        onLine,
        onClose: () => {
          if (self === null || socket !== self) return;
          socket = null;
          scheduleReconnect();
        },
      });
      self = next;
      if (stopped) {
        next.end();
        return;
      }
      socket = next;
      lastReceivedAt = Date.now();
      const params: Record<string, unknown> = { categories };
      if (lastSeq !== null) params.after_seq = lastSeq;
      next.write(`${JSON.stringify({ id: "events", method: "events.stream", params })}\n`);
    } catch {
      scheduleReconnect();
    }
  };

  void connect();

  return () => {
    stopped = true;
    clearInterval(watchdog);
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    const open = socket;
    socket = null;
    try {
      open?.end();
    } catch {
      /* already gone */
    }
  };
}
