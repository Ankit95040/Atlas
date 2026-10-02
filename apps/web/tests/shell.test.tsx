import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Shell } from "../src/components/Shell";

describe("Shell", () => {
  it("renders brand, primary nav, and projection footer", () => {
    render(
      <Shell route="#/">
        <p>child</p>
      </Shell>,
    );
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const label of ["Home", "Runs", "Activity", "Workflow"]) {
      expect(nav).toHaveTextContent(label);
    }
    expect(screen.getByText(/projection UI/i)).toBeInTheDocument();
  });

  it("marks the active route with aria-current", () => {
    render(
      <Shell route="#/runs">
        <p>child</p>
      </Shell>,
    );
    expect(screen.getByRole("link", { name: /Runs/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /^Home$/ })).not.toHaveAttribute("aria-current");
  });
});
