#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_JDK = 21;
const isWin = platform() === "win32";
const exe = isWin ? ".exe" : "";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed with exit ${r.status}`);
}

function versionOf(javac) {
  const r = spawnSync(javac, ["-version"], { encoding: "utf8", shell: false });
  if (r.status !== 0) return null;
  const m = `${r.stdout}${r.stderr}`.match(/javac\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

function which(cmd) {
  const r = spawnSync(isWin ? "where.exe" : "which", [cmd], { encoding: "utf8", shell: false });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function* jdkBins() {
  for (const p of which(`javac${exe}`)) yield dirname(p);
  if (process.env.JAVA_HOME) yield join(process.env.JAVA_HOME, "bin");
  const bases = isWin
    ? [
        "C:\\Program Files\\Eclipse Adoptium",
        "C:\\Program Files\\Microsoft",
        "C:\\Program Files\\Java",
        "C:\\Program Files\\Amazon Corretto",
        "C:\\Program Files\\Zulu",
      ]
    : ["/usr/lib/jvm", "/opt/java", "/usr/local/opt"];
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) yield join(base, name, "bin");
  }
}

function findJdk() {
  const rejected = [];
  for (const bin of jdkBins()) {
    const javac = join(bin, `javac${exe}`);
    if (!existsSync(javac)) continue;
    const version = versionOf(javac);
    if (version && version >= MIN_JDK) return { bin, version };
    if (version) rejected.push(`${javac} (${version})`);
  }
  throw new Error(`No JDK ${MIN_JDK}+ found.${rejected.length ? ` Too old: ${rejected.join(", ")}` : ""}`);
}

function looksLikeLibrary(dir) {
  return existsSync(join(dir, "database")) && existsSync(join(dir, "app"));
}

function* libraryCandidates() {
  const env = process.env.FIQH4_SHAMELA_DIR || process.env.SHAMELA_INSTALL_ROOT;
  if (env) yield env;
  if (isWin) {
    for (const drive of ["D:", "C:", "E:", "F:"]) {
      yield `${drive}\\shamela`;
      yield `${drive}\\Shamela4`;
    }
  }
  const home = homedir();
  yield join(home, "shamela");
  yield join(home, "Shamela4");
}

function findLuceneDir() {
  const configured = process.env.FIQH4_LUCENE_DIR;
  if (configured && existsSync(configured)) return configured;
  for (const root of libraryCandidates()) {
    if (!root || !looksLikeLibrary(root)) continue;
    const dir = join(root, "app", "lucene", "2");
    if (existsSync(dir)) return dir;
  }
  throw new Error("Could not find Shamela Lucene jars. Set FIQH4_SHAMELA_DIR or FIQH4_LUCENE_DIR.");
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".java")) out.push(full);
  }
  return out;
}

const { bin, version } = findJdk();
const luceneDir = findLuceneDir();
const jars = readdirSync(luceneDir).filter((f) => f.endsWith(".jar")).map((f) => join(luceneDir, f));
if (jars.length === 0) throw new Error(`No jars found under ${luceneDir}`);

const srcRoot = join(ROOT, "java", "src", "main", "java");
const buildDir = join(ROOT, "java", "build");
const classesDir = join(buildDir, "classes");
const helperDir = join(ROOT, "helper");
const sources = walk(srcRoot);
if (sources.length === 0) throw new Error(`No Java sources under ${srcRoot}`);

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(classesDir, { recursive: true });
mkdirSync(helperDir, { recursive: true });

process.stdout.write(`JDK ${version}: ${bin}\n`);
process.stdout.write(`Lucene classpath: ${luceneDir} (${jars.length} jars)\n`);
run(join(bin, `javac${exe}`), [
  "-encoding",
  "UTF-8",
  "--release",
  String(MIN_JDK),
  "-Xlint:-options",
  "-d",
  classesDir,
  "-cp",
  jars.join(delimiter),
  ...sources,
]);

const manifest = join(buildDir, "MANIFEST.MF");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
writeFileSync(
  manifest,
  [
    "Manifest-Version: 1.0",
    "Main-Class: dev.shamela.fiqh4.Bridge",
    "Implementation-Title: shamela-fiqh-4 helper",
    `Implementation-Version: ${pkg.version}`,
    "",
  ].join("\n"),
  "ascii",
);

const outJar = join(helperDir, "fiqh4-helper.jar");
run(join(bin, `jar${exe}`), ["cfm", outJar, manifest, "-C", classesDir, "."]);
const size = statSync(outJar).size;
rmSync(buildDir, { recursive: true, force: true });
process.stdout.write(`Built ${outJar} (${(size / 1024).toFixed(1)} KB)\n`);
