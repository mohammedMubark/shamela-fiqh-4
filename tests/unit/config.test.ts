import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleaned, envInt, envReport, unresolvedPlaceholders } from "../../src/config.js";
import { findJava, resolveJava } from "../../src/shamela/discover.js";

/**
 * These pin the rule that one shipped release got wrong: a `user_config` field
 * declared without a `default` reaches the process as the literal placeholder
 * text, and code that trusted any non-empty value then honoured a path that
 * could not exist.
 */

const touched: string[] = [];
function setEnv(name: string, value: string | undefined): void {
  touched.push(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name];
});

describe("cleaned", () => {
  it("keeps a real value, trimmed", () => {
    expect(cleaned("  D:\shamela  ")).toBe("D:\shamela");
  });
  it("treats blank and whitespace as unset — the client sends '' for untouched settings", () => {
    expect(cleaned("")).toBeUndefined();
    expect(cleaned("   ")).toBeUndefined();
    expect(cleaned(undefined)).toBeUndefined();
    expect(cleaned(null)).toBeUndefined();
  });
  it("drops an unsubstituted MCPB placeholder", () => {
    expect(cleaned("${user_config.java_path}")).toBeUndefined();
    expect(cleaned("  ${user_config.output_dir}  ")).toBeUndefined();
  });
  it("keeps a path that merely contains a brace, since only the whole-value form is a placeholder", () => {
    expect(cleaned("/opt/${weird}/java")).toBe("/opt/${weird}/java");
  });
});

describe("envInt", () => {
  it("falls back when the value is a placeholder rather than a number", () => {
    setEnv("FIQH4_CONCURRENCY", "${user_config.concurrency}");
    expect(envInt("FIQH4_CONCURRENCY", 4, 1, 16)).toBe(4);
  });
  it("clamps to the declared bounds", () => {
    setEnv("FIQH4_CONCURRENCY", "999");
    expect(envInt("FIQH4_CONCURRENCY", 4, 1, 16)).toBe(16);
  });
});

describe("envReport", () => {
  it("separates unset, empty and placeholder so health can name the problem", () => {
    setEnv("FIQH4_JAVA_PATH", "${user_config.java_path}");
    setEnv("FIQH4_OVERRIDES_FILE", "");
    setEnv("FIQH4_INDEX_DIR", undefined);

    const byName = new Map(envReport().map((e) => [e.name, e]));
    expect(byName.get("FIQH4_JAVA_PATH")?.state).toBe("unresolved_placeholder");
    expect(byName.get("FIQH4_OVERRIDES_FILE")?.state).toBe("empty");
    expect(byName.get("FIQH4_INDEX_DIR")?.state).toBe("unset");
    expect(unresolvedPlaceholders()).toContain("FIQH4_JAVA_PATH");
  });
});

describe("resolveJava", () => {
  const appDir = mkdtempSync(join(tmpdir(), "fiqh4-java-"));
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const bundled = join(appDir, "win", "64", "jre", "2", "bin", exe);
  mkdirSync(join(appDir, "win", "64", "jre", "2", "bin"), { recursive: true });
  writeFileSync(bundled, "");

  it("finds the bundled runtime when nothing is configured", () => {
    setEnv("FIQH4_JAVA_PATH", undefined);
    const r = resolveJava(appDir);
    expect(r.path).toBe(bundled);
    expect(r.source).toBe("bundled");
  });

  it("treats an empty setting as unset", () => {
    setEnv("FIQH4_JAVA_PATH", "");
    expect(resolveJava(appDir).path).toBe(bundled);
  });

  it("falls back to the bundled runtime when the placeholder was never substituted", () => {
    setEnv("FIQH4_JAVA_PATH", "${user_config.java_path}");
    const r = resolveJava(appDir);
    expect(r.path).toBe(bundled);
    expect(r.source).toBe("bundled");
    // Dropped before it is ever compared to the filesystem, so it is not
    // reported as a setting the user made and we ignored.
    expect(r.ignoredConfigured).toBeNull();
  });

  it("falls back — and says so — when a configured path does not exist", () => {
    const missing = join(appDir, "nowhere", exe);
    setEnv("FIQH4_JAVA_PATH", missing);
    const r = resolveJava(appDir);
    expect(r.path).toBe(bundled);
    expect(r.source).toBe("bundled");
    expect(r.ignoredConfigured).toBe(missing);
  });

  it("honours a configured path that exists", () => {
    setEnv("FIQH4_JAVA_PATH", bundled);
    const r = resolveJava(appDir);
    expect(r.source).toBe("configured");
    expect(r.path).toBe(bundled);
  });

  it("reports every location tried when there is no Java at all", () => {
    setEnv("FIQH4_JAVA_PATH", undefined);
    const empty = mkdtempSync(join(tmpdir(), "fiqh4-nojava-"));
    const r = resolveJava(empty);
    expect(r.path).toBeNull();
    expect(r.source).toBe("not_found");
    expect(r.tried.length).toBeGreaterThan(0);
    expect(findJava(empty)).toBeNull();
  });
});
