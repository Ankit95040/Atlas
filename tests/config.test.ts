import { describe, expect, it } from "vitest";
import { loadConfig, validateConfig } from "../src/config/index.js";

describe("configuration validation", () => {
  it("loads defaults when env is empty", () => {
    const config = loadConfig({});
    expect(config.databaseUrl).toBe("file:./dev.db");
    expect(config.nodeEnv).toBe("development");
    expect(config.gitBinary).toBe("git");
    expect(config.dockerBinary).toBe("docker");
  });

  it("loads values from env", () => {
    const config = loadConfig({
      DATABASE_URL: "file:./custom.db",
      NODE_ENV: "test",
    });
    expect(config.databaseUrl).toBe("file:./custom.db");
    expect(config.nodeEnv).toBe("test");
  });

  it("rejects an empty DATABASE_URL", () => {
    expect(() =>
      validateConfig({ databaseUrl: "", nodeEnv: "development" }),
    ).toThrow();
  });

  it("rejects an invalid nodeEnv", () => {
    expect(() =>
      validateConfig({ databaseUrl: "file:./dev.db", nodeEnv: "staging" }),
    ).toThrow();
  });

  it("rejects invalid config via loadConfig passthrough", () => {
    expect(() => loadConfig({ DATABASE_URL: "", NODE_ENV: "test" })).toThrow();
  });
});
