import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the installed package root from either preserved `dist/<module>.js`
 * files or a single bundled `dist/index.js`.
 */
export function packageRoot(metaUrl: string): string {
  let current = dirname(fileURLToPath(metaUrl));
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(current, "manifest.json")) && existsSync(join(current, "config"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return resolve(dirname(fileURLToPath(metaUrl)), "..");
}

