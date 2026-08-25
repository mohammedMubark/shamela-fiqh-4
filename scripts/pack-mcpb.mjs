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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const OUT = process.argv[2] ?? join(ROOT, `${packageJson.name}-${packageJson.version}.mcpb`);

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  process.stderr.write("dist/ not found — run `npm run build` first.\n");
  process.exit(1);
}

process.stdout.write("building Java helper…\n");
execFileSync(process.execPath, [join(ROOT, "scripts", "build-java.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
});

// Exactly what the server needs to run, and nothing else.
const INCLUDE = ["dist", "helper", "config", "manifest.json", "package.json", "README.md", "LICENSE", "NOTICE"];

function packageDir(name) {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.split("/");
    return join(ROOT, "node_modules", scope, pkg);
  }
  return join(ROOT, "node_modules", name);
}

function packageDest(stageRoot, name) {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.split("/");
    return join(stageRoot, "node_modules", scope, pkg);
  }
  return join(stageRoot, "node_modules", name);
}

function copyRuntimeDependencyClosure(stageRoot) {
  const seen = new Set();
  const queue = Object.keys(packageJson.dependencies ?? {});
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const from = packageDir(name);
    if (!existsSync(from)) {
      process.stderr.write(`missing production dependency in node_modules: ${name}\n`);
      process.exit(1);
    }
    const to = packageDest(stageRoot, name);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });

    const depPkgPath = join(from, "package.json");
    if (!existsSync(depPkgPath)) continue;
    const depPkg = JSON.parse(readFileSync(depPkgPath, "utf8"));
    for (const dep of Object.keys(depPkg.dependencies ?? {})) queue.push(dep);
    for (const dep of Object.keys(depPkg.optionalDependencies ?? {})) {
      if (existsSync(packageDir(dep))) queue.push(dep);
    }
  }
  return seen.size;
}

function bundleServerInto(stageRoot) {
  const rolldownCli = join(ROOT, "node_modules", "rolldown", "bin", "cli.mjs");
  if (!existsSync(rolldownCli)) {
    process.stdout.write("  rolldown not installed; shipping preserved dist files\n");
    return false;
  }

  const outDir = join(stageRoot, "dist");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    process.execPath,
    [
      rolldownCli,
      join(ROOT, "dist", "index.js"),
      "--file",
      join(outDir, "index.js"),
      "--format",
      "esm",
      "--platform",
      "node",
      "--external",
      "@modelcontextprotocol/sdk/server/mcp.js,@modelcontextprotocol/sdk/server/stdio.js,zod",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  return true;
}

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
  const stripMaps = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) stripMaps(full);
      else if (name.name.endsWith(".map")) unlinkSync(full);
    }
  };
  stripMaps(join(stage, "dist"));

  process.stdout.write("bundling Node server…\n");
  const bundled = bundleServerInto(stage);
  if (bundled) process.stdout.write("  bundled to dist/index.js\n");

  process.stdout.write("copying production dependency closure…\n");
  const deps = copyRuntimeDependencyClosure(stage);
  process.stdout.write(`  copied ${deps} production packages\n`);

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
