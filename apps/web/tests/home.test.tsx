import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HomePage } from "../src/routes/Home";
import { RunsPage } from "../src/routes/Runs";

const HOME_PAYLOAD = {
  ok: true,
  data: {
    metrics: { projects: 1, runs: 2, tasks: 3, liveWorkers: 0, verified: 1, merges: 1 },
    activeRuns: [
      {
        id: "feat-1",
        title: "demo run",
        status: "IN_PROGRESS",
        projectId: "proj-1",
        projectName: "demo",
        totalTasks: 3,
        workerCount: 0,
        verifiedCount: 1,
        mergeCount: 1,
      },
    ],
    recentRuns: [],
  },
};

const RUNS_PAYLOAD = {
  ok: true,
  data: [
    {
      id: "feat-1",
      title: "demo run",
      status: "IN_PROGRESS",
      projectId: "proj-1",
      projectName: "demo",
      totalTasks: 3,
      workerCount: 0,
      verifiedCount: 1,
      mergeCount: 1,
    },
  ],
};

function mockFetch(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => payload }) as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HomePage", () => {
  it("renders fleet metrics and active runs from /api/home", async () => {
    mockFetch(HOME_PAYLOAD);
    render(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("demo run")).toBeInTheDocument();
    });
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("IN_PROGRESS")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/home", expect.anything());
  });

  it("shows an empty state when Atlas has no active runs", async () => {
    mockFetch({ ok: true, data: { ...HOME_PAYLOAD.data, activeRuns: [] } });
    render(<HomePage />);
    await waitFor(() => {
      expect(screen.getByText("No active runs")).toBeInTheDocument();
    });
  });
});

describe("RunsPage", () => {
  it("lists runs from /api/runs", async () => {
    mockFetch(RUNS_PAYLOAD);
    render(<RunsPage />);
    await waitFor(() => {
      expect(screen.getByText("demo run")).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledWith("/api/runs", expect.anything());
  });
});
