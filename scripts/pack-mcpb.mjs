#!/usr/bin/env node
/**
 * Builds the MCPB package from a clean, production-only staging directory.
 *
 * Packing the repository in place would sweep in devDependencies — TypeScript,
 * Vite, Vitest — which the server never loads at runtime. That produced a 20MB
 * bundle where a small one will do. Staging also guarantees the package cannot
 * accidentally carry tests, fixtures, the Java module, or a stray Shamela file:
 * only files named here are copied in.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? join(ROOT, "shamela-fiqh-4.mcpb");

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  process.stderr.write("dist/ not found — run `npm run build` first.\n");
  process.exit(1);
}

// Exactly what the server needs to run, and nothing else.
const INCLUDE = ["dist", "config", "manifest.json", "package.json", "package-lock.json", "README.md", "LICENSE", "NOTICE"];

const stage = mkdtempSync(join(tmpdir(), "fiqh4-mcpb-"));
try {
  for (const entry of INCLUDE) {
    const from = join(ROOT, entry);
    if (!existsSync(from)) {
      process.stderr.write(`missing required file: ${entry}\n`);
      process.exit(1);
    }
    cpSync(from, join(stage, entry), { recursive: true });
  }

  // Source maps are build artefacts; they double dist/ for no runtime benefit.
  const { readdirSync, unlinkSync } = await import("node:fs");
  const stripMaps = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) stripMaps(full);
      else if (name.name.endsWith(".map")) unlinkSync(full);
    }
  };
  stripMaps(join(stage, "dist"));

  process.stdout.write("installing production dependencies…\n");
  // shell:true because on Windows `npm` is `npm.cmd`, which Node refuses to
  // execute without a shell. No path is passed on the command line — the
  // staging directory travels in `cwd` — so a space in the path cannot break
  // the invocation.
  execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: stage,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  // The lockfile is only needed for that install; it is not a runtime file.
  rmSync(join(stage, "package-lock.json"), { force: true });

  process.stdout.write("packing…\n");
  // Invoke the packer's JS entry point directly rather than through `npx`.
  // npx is a .cmd shim on Windows, and running it through a shell would put
  // these two paths on a command line where a space (D:\develop shamela\…)
  // splits them into separate arguments. process.execPath sidesteps both.
  const packerCli = join(ROOT, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js");
  if (!existsSync(packerCli)) {
    process.stderr.write(
      "@anthropic-ai/mcpb not installed — run `npm install` first (it is a devDependency).\n",
    );
    process.exit(1);
  }
  const out = execFileSync(process.execPath, [packerCli, "pack", stage, OUT], {
    cwd: ROOT,
    encoding: "utf8",
  });
  process.stdout.write(out.split("\n").slice(-12).join("\n") + "\n");

  const size = statSync(OUT).size;
  process.stdout.write(`\n${OUT} — ${(size / 1048576).toFixed(1)}MB\n`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
