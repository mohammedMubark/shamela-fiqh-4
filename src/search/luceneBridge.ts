import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Fiqh4Error } from "../util/errors.js";
import { isFile } from "../util/paths.js";
import { log } from "../util/log.js";

/**
 * Client for the optional Java/Lucene helper.
 *
 * The jar is built by the user (`npm run java:build`) and pointed at with
 * FIQH4_LUCENE_JAR. It is never bundled: shipping Lucene jars or a JRE inside
 * the MCPB package is explicitly out of scope, so the extension has to work
 * without it and merely go faster with it.
 *
 * Transport is newline-delimited JSON on stdin/stdout — a local pipe to a child
 * process, no socket, no port. Requests carry an id so responses can be
 * correlated even though the protocol allows the helper to emit progress lines.
 */

export interface BridgeRequest {
  id: number;
  cmd: "health" | "index" | "search" | "counts" | "pages" | "close";
  [k: string]: unknown;
}

export interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function luceneJarPath(): string | null {
  const p = process.env.FIQH4_LUCENE_JAR?.trim();
  return p && isFile(p) ? p : null;
}

export function javaBin(): string {
  return process.env.FIQH4_JAVA_BIN?.trim() || "java";
}

export class LuceneBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly jar: string;
  private readonly timeoutMs: number;

  constructor(jar: string, timeoutMs = 120_000) {
    this.jar = jar;
    this.timeoutMs = timeoutMs;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed) return this.proc;

    const proc = spawn(javaBin(), ["-jar", this.jar], {
      stdio: ["pipe", "pipe", "pipe"],
      // No network is needed or wanted; the helper only touches local files.
      env: { ...process.env, JAVA_TOOL_OPTIONS: "" },
    });

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => log.debug("lucene-bridge stderr", chunk.trim()));
    proc.on("exit", (code) => {
      const err = new Fiqh4Error(
        "ENGINE_UNAVAILABLE",
        `توقف جسر Lucene بشكل غير متوقع (رمز الخروج ${code}). سيُستخدم محرك Node.`,
        `Lucene bridge exited with code ${code}.`,
        { exit_code: code },
      );
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.proc = null;
    });

    this.proc = proc;
    return proc;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: BridgeResponse;
      try {
        msg = JSON.parse(line) as BridgeResponse;
      } catch {
        log.debug("lucene-bridge non-JSON line", line);
        continue;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else
        waiter.reject(
          new Fiqh4Error(
            "ENGINE_UNAVAILABLE",
            `فشل جسر Lucene: ${msg.error ?? "سبب غير معروف"}`,
            `Lucene bridge error: ${msg.error ?? "unknown"}`,
            {},
          ),
        );
    }
  }

  send<T = unknown>(cmd: BridgeRequest["cmd"], payload: Record<string, unknown> = {}): Promise<T> {
    const proc = this.ensureStarted();
    const id = this.nextId++;
    const req: BridgeRequest = { id, cmd, ...payload };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Fiqh4Error(
            "ENGINE_UNAVAILABLE",
            `انتهت مهلة انتظار جسر Lucene (${this.timeoutMs}ms) للأمر ${cmd}.`,
            `Lucene bridge timed out after ${this.timeoutMs}ms on ${cmd}.`,
            { cmd },
          ),
        );
      }, this.timeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      proc.stdin.write(`${JSON.stringify(req)}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.send("close").catch(() => undefined);
    } finally {
      this.proc?.stdin.end();
      this.proc?.kill();
      this.proc = null;
    }
  }
}
