import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Fiqh4Error } from "../util/errors.js";
import { isDirectory } from "../util/paths.js";
import { log } from "../util/log.js";
import { helperClasses } from "../config.js";

/**
 * Client for the Lucene helper that reads Shamela's own indexes.
 *
 * Shamela 4 keeps every page body in Lucene under `database/store`, so this is
 * not an optional accelerator — it is the only way to reach book text at all.
 *
 * Nothing is bundled. The helper runs on **Shamela's own JRE** with **Shamela's
 * own Lucene jars** on the classpath; this project ships only the few kilobytes
 * of classes compiled from `java/src`. That is what keeps "no JRE, no Lucene
 * jars in the package" true while still needing no build step from the user.
 *
 * Transport is newline-delimited JSON over a child process's stdin/stdout — a
 * local pipe, no socket, no port.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/search/… and src/search/… both sit two levels under the package root. */
const PACKAGE_ROOT = join(HERE, "..", "..");

/** Where `npm run build:java` puts the compiled helper. */
export function helperClassesDir(): string {
  return helperClasses() ?? join(PACKAGE_ROOT, "java", "classes");
}

export function helperAvailable(): boolean {
  return isDirectory(helperClassesDir());
}

export interface BridgeRequest {
  id: number;
  cmd: "health" | "search" | "counts" | "pages" | "getPages" | "getTitles" | "inspect" | "close";
  [k: string]: unknown;
}

export interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BridgeLaunch {
  /** Shamela's bundled `java` (or a configured override). */
  javaPath: string;
  /** `app/lucene/2` — Shamela's own Lucene jars. */
  luceneDir: string;
  /** `database/store` — the indexes to read. */
  storeDir: string;
}

export class LuceneBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  /**
   * The last few lines the helper wrote to stderr.
   *
   * When Java fails, its own message is by far the most useful thing we have —
   * a missing class, an unsupported class-file version, a locked index. Sending
   * it only to a debug log means it is discarded at the default log level and
   * the user is left with "something went wrong with Java".
   */
  private stderrTail: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly launch: BridgeLaunch;
  private readonly timeoutMs: number;

  constructor(launch: BridgeLaunch, timeoutMs = 180_000) {
    this.launch = launch;
    this.timeoutMs = timeoutMs;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed) return this.proc;

    // Shamela's jars first, then our classes. The wildcard is expanded by the
    // JVM itself, so the exact jar names do not have to be known here.
    const classpath = [join(this.launch.luceneDir, "*"), helperClassesDir()].join(delimiter);

    const proc = spawn(
      this.launch.javaPath,
      ["-Xmx512m", "-Dfile.encoding=UTF-8", "-cp", classpath, "dev.shamela.fiqh4.Main"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        // The helper reads local files only; a proxy setting inherited from the
        // environment has nothing to act on and would only confuse diagnostics.
        env: { ...process.env, JAVA_TOOL_OPTIONS: "" },
      },
    );

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (!text) return;
      log.debug("lucene helper stderr", text);
      this.stderrTail.push(text);
      // Keep the tail bounded: a JVM stack trace should not accumulate forever.
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });

    // Without this listener a failed spawn — a java binary that is missing, not
    // executable, or the wrong architecture — raises an unhandled 'error' event
    // and every pending request hangs until its timeout.
    proc.on("error", (cause: Error) => {
      this.failAll(
        new Fiqh4Error(
          "ENGINE_UNAVAILABLE",
          `تعذّر تشغيل Java من المسار «${this.launch.javaPath}»: ${cause.message}. ` +
            `تأكد أن الملف موجود وقابل للتنفيذ، أو اضبط FIQH4_JAVA_PATH على java أخرى.`,
          `Could not start Java at ${this.launch.javaPath}: ${cause.message}`,
          { java_path: this.launch.javaPath, cause: cause.message },
        ),
      );
    });

    proc.on("exit", (code) => {
      const detail = this.stderrTail.join("\n").trim();
      this.failAll(
        new Fiqh4Error(
          "ENGINE_UNAVAILABLE",
          `توقف مساعد Lucene بشكل غير متوقع (رمز الخروج ${code}).` +
            (detail ? ` رسالة Java:\n${detail}` : ""),
          `Lucene helper exited with code ${code}.${detail ? `\n${detail}` : ""}`,
          { exit_code: code, java_path: this.launch.javaPath, stderr: detail || null },
        ),
      );
    });

    this.proc = proc;
    return proc;
  }

  /** Reject every in-flight request and forget the process. */
  private failAll(err: Fiqh4Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.proc = null;
  }

  /** Whatever the helper last wrote to stderr, for diagnostics. */
  get lastStderr(): string {
    return this.stderrTail.join("\n").trim();
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
    const req: BridgeRequest = { id, cmd, storeDir: this.launch.storeDir, ...payload };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Fiqh4Error(
            "ENGINE_UNAVAILABLE",
            `انتهت مهلة انتظار مساعد Lucene (${this.timeoutMs}ms) عند الأمر «${cmd}». ` +
              `أشيع سبب لذلك أن برنامج الشاملة يعيد بناء فهارسه الآن — تصير القراءة بطيئة جدًا في أثناء ذلك. ` +
              `انتظر حتى ينتهي التنزيل أو إعادة الفهرسة ثم أعد المحاولة.`,
            `Lucene helper timed out after ${this.timeoutMs}ms on ${cmd}. Shamela may be rebuilding its indexes.`,
            { cmd, timeout_ms: this.timeoutMs, stderr: this.lastStderr || null },
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
