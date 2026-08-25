import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, delimiter } from "node:path";
import type { LibraryLocation } from "../shamela/discover.js";
import { Fiqh4Error } from "../util/errors.js";
import { packageRoot } from "../util/packageRoot.js";
import { isDirectory, isFile } from "../util/paths.js";
import { log } from "../util/log.js";

/**
 * Node side of the direct Shamela Lucene helper.
 *
 * The shipped jar contains our classes only. Lucene and Java are loaded from
 * the user's own Shamela install, so the MCPB does not redistribute either.
 */

export interface BridgeRequest {
  id: number;
  cmd: "health" | "books" | "search" | "counts" | "pages" | "get_pages" | "get_titles" | "close";
  [k: string]: unknown;
}

export interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const PACKAGE_ROOT = packageRoot(import.meta.url);
const DEFAULT_JAVA_OPTS = ["-Xms16m", "-Xmx512m", "-Xss4m"];

function javaOptions(): string[] {
  const configured = process.env.FIQH4_JAVA_OPTS?.trim();
  return configured ? configured.split(/\s+/).filter(Boolean) : DEFAULT_JAVA_OPTS;
}

export function helperJarPath(): string | null {
  const configured = process.env.FIQH4_HELPER_JAR?.trim();
  const p = configured || join(PACKAGE_ROOT, "helper", "fiqh4-helper.jar");
  return isFile(p) ? p : null;
}

export function luceneDirFor(loc: LibraryLocation): string | null {
  const configured = process.env.FIQH4_LUCENE_DIR?.trim();
  const candidates = [
    configured,
    join(loc.root, "app", "lucene", "2"),
    "D:\\shamela\\app\\lucene\\2",
    "C:\\shamela\\app\\lucene\\2",
  ].filter((p): p is string => !!p);

  for (const dir of candidates) {
    if (!isDirectory(dir)) continue;
    return dir;
  }
  return null;
}

export function javaBinFor(loc: LibraryLocation): string {
  const configured = process.env.FIQH4_JAVA_PATH?.trim();
  if (configured && isFile(configured)) return configured;

  const exe = process.platform === "win32" ? "java.exe" : "java";
  const candidates = [
    join(loc.root, "app", "win", "64", "jre", "2", "bin", exe),
    join(loc.root, "app", "win", "64", "jre", "bin", exe),
    join(loc.root, "app", "jre", "bin", exe),
    join("D:\\shamela", "app", "win", "64", "jre", "2", "bin", exe),
    join("C:\\shamela", "app", "win", "64", "jre", "2", "bin", exe),
    join("C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.3.9-hotspot", "bin", exe),
  ];
  for (const p of candidates) if (isFile(p)) return p;
  return "java";
}

export interface LuceneBridgeOptions {
  location: LibraryLocation;
  timeoutMs?: number;
}

export class LuceneBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private stderrTail: string[] = [];
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  readonly jar: string;
  readonly luceneDir: string;
  readonly javaPath: string;
  readonly libraryRoot: string;
  private readonly timeoutMs: number;

  constructor(opts: LuceneBridgeOptions) {
    const jar = helperJarPath();
    const luceneDir = luceneDirFor(opts.location);
    if (!jar) {
      throw new Fiqh4Error(
        "ENGINE_UNAVAILABLE",
        "لم يُبنَ مساعد Lucene بعد. شغّل npm run java:build ثم أعد المحاولة.",
        "Lucene helper jar was not found.",
        { expected: join(PACKAGE_ROOT, "helper", "fiqh4-helper.jar") },
      );
    }
    if (!luceneDir) {
      throw new Fiqh4Error(
        "ENGINE_UNAVAILABLE",
        `تعذر العثور على ملفات Lucene داخل تثبيت الشاملة: ${opts.location.root}\\app\\lucene\\2`,
        "Could not find Shamela Lucene jars.",
        { library_root: opts.location.root },
      );
    }
    this.jar = jar;
    this.luceneDir = luceneDir;
    this.javaPath = javaBinFor(opts.location);
    this.libraryRoot = opts.location.root;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed) return this.proc;

    const classpath = [join(this.luceneDir, "*"), this.jar].join(delimiter);
    const proc = spawn(
      this.javaPath,
      [
        ...javaOptions(),
        "-Dstdout.encoding=UTF-8",
        "-Dfile.encoding=UTF-8",
        "-cp",
        classpath,
        "dev.shamela.fiqh4.Bridge",
        this.libraryRoot,
        String(process.pid),
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, JAVA_TOOL_OPTIONS: "" },
      },
    );

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 30) this.stderrTail.shift();
      log.debug("fiqh4-helper stderr", chunk.trim());
    });
    proc.on("exit", (code) => {
      const tail = this.stderrTail.join("").trim().slice(-800);
      const err = new Fiqh4Error(
        "ENGINE_UNAVAILABLE",
        `توقف مساعد Lucene بشكل غير متوقع (رمز الخروج ${code}).${tail ? ` آخر رسالة: ${tail}` : ""}`,
        `Lucene helper exited with code ${code}.${tail ? ` stderr: ${tail}` : ""}`,
        { exit_code: code, stderr_tail: tail },
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
        log.debug("fiqh4-helper non-JSON line", line);
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
            `فشل مساعد Lucene: ${msg.error ?? "سبب غير معروف"}`,
            `Lucene helper error: ${msg.error ?? "unknown"}`,
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
            `انتهت مهلة انتظار مساعد Lucene (${this.timeoutMs}ms) للأمر ${cmd}.`,
            `Lucene helper timed out after ${this.timeoutMs}ms on ${cmd}.`,
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
    const proc = this.proc;
    if (!proc) return;
    try {
      await this.send("close").catch(() => undefined);
    } finally {
      try {
        proc.stdin.end();
      } catch {
        /* already closed */
      }
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
      this.proc = null;
    }
  }
}
