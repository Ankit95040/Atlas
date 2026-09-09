import { describe, expect, it } from "vitest";
import {
  checkConfiguration,
  checkNodeVersion,
  formatDoctorResult,
  runDoctor,
} from "../src/cli/doctor.js";

describe("doctor command", () => {
  it("checkNodeVersion passes on the current runtime", () => {
    const check = checkNodeVersion();
    expect(check.name).toBe("Node.js");
    expect(check.ok).toBe(true);
  });

  it("checkNodeVersion fails on old versions", () => {
    expect(checkNodeVersion("v16.0.0").ok).toBe(false);
    expect(checkNodeVersion("not-a-version").ok).toBe(false);
  });

  it("checkConfiguration passes with valid env", () => {
    const check = checkConfiguration({ DATABASE_URL: "file:./dev.db", NODE_ENV: "test" });
    expect(check.ok).toBe(true);
  });

  it("checkConfiguration fails with invalid env", () => {
    const check = checkConfiguration({ DATABASE_URL: "", NODE_ENV: "test" });
    expect(check.ok).toBe(false);
  });

  it("runDoctor returns all five checks", async () => {
    const result = await runDoctor();
    const names = result.checks.map((check) => check.name);
    expect(names).toEqual(["Node.js", "Git", "Docker", "Configuration", "Database"]);
    for (const check of result.checks) {
      expect(typeof check.ok).toBe("boolean");
      expect(typeof check.detail).toBe("string");
    }
    expect(typeof result.ok).toBe("boolean");
  });

  it("formatDoctorResult mentions every check", async () => {
    const result = await runDoctor();
    const output = formatDoctorResult(result);
    for (const check of result.checks) {
      expect(output).toContain(check.name);
    }
  });
});
