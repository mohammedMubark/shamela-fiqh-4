/**
 * The one check that must run before anything else loads.
 *
 * The server needs Node ≥ 22.5.0 for the built-in `node:sqlite`. On an older
 * Node the failure happens at *import time* — `ERR_UNKNOWN_BUILTIN_MODULE:
 * node:sqlite`, a stack trace that names neither Node nor a fix — and Claude
 * Desktop shows the user only "server disconnected". So `src/index.ts` runs
 * this check first and defers every other import until it passes.
 *
 * This module therefore imports **nothing**: it has to load and run on the
 * very Nodes it exists to reject, so it can rely only on syntax that old
 * runtimes already parse.
 */

export const MIN_NODE = { major: 22, minor: 5 } as const;

export interface PreflightProblem {
  ar: string;
  en: string;
}

/** Why this Node cannot run the server, or `null` when it can. */
export function nodeVersionProblem(version: string): PreflightProblem | null {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] ?? "0", 10) || 0;
  const minor = Number.parseInt(parts[1] ?? "0", 10) || 0;
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  if (ok) return null;
  const need = `${MIN_NODE.major}.${MIN_NODE.minor}.0`;
  return {
    en:
      `Node.js ${version} is too old for shamela-fiqh-4: it needs Node >= ${need} ` +
      `(the built-in node:sqlite module). Update Node.js, or update Claude Desktop so its bundled Node is current.`,
    ar:
      `نسخة Node.js المشغِّلة (${version}) أقدم من المطلوب: هذه الإضافة تحتاج Node ${need} فأحدث ` +
      `(لوحدة node:sqlite المدمجة). حدِّث Node.js، أو حدِّث Claude Desktop حتى تتحدث نسخة Node التي يشحنها.`,
  };
}
