#!/usr/bin/env node
/**
 * manifest.json and the code must advertise exactly the same tools.
 * A drift here means Claude Desktop shows a tool that does not exist, or hides
 * one that does — both silent failures for the user.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const source = readFileSync(join(ROOT, "src", "server", "registerTools.ts"), "utf8");

const inCode = [...source.matchAll(/"(fiqh4_[a-z_]+)"/g)].map((m) => m[1]);
const declared = (manifest.tools ?? []).map((t) => t.name);

const problems = [];

const missingInManifest = inCode.filter((n) => !declared.includes(n));
const extraInManifest = declared.filter((n) => !inCode.includes(n));
if (missingInManifest.length) problems.push(`registered in code but absent from manifest.json: ${missingInManifest.join(", ")}`);
if (extraInManifest.length) problems.push(`declared in manifest.json but not registered: ${extraInManifest.join(", ")}`);

for (const name of declared) {
  if (!name.startsWith("fiqh4_")) problems.push(`tool "${name}" does not use the required fiqh4_ prefix`);
}

if (manifest.name !== "shamela-fiqh-4") problems.push(`manifest name is "${manifest.name}", expected "shamela-fiqh-4"`);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
if (pkg.name !== manifest.name) problems.push(`package.json name "${pkg.name}" != manifest name "${manifest.name}"`);
if (pkg.version !== manifest.version) problems.push(`package.json version "${pkg.version}" != manifest version "${manifest.version}"`);

for (const [key] of Object.entries(manifest.user_config ?? {})) {
  if (!/^[a-z0-9_]+$/.test(key)) problems.push(`user_config key "${key}" should be snake_case`);
}

// Every env var the manifest wires up must use the agreed prefix.
const envKeys = Object.keys(manifest.server?.mcp_config?.env ?? {});
for (const k of envKeys) {
  if (!k.startsWith("FIQH4_")) problems.push(`env var "${k}" does not use the required FIQH4_ prefix`);
}

if (problems.length) {
  process.stderr.write("manifest parity check FAILED:\n");
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}
process.stdout.write(`manifest parity OK — ${declared.length} tools, ${envKeys.length} FIQH4_ env vars\n`);
