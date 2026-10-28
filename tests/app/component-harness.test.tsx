// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

it("renders an actual React component and handles a local user interaction", async () => {
  const { ThemeToggle } = await import("@/components/theme-toggle");
  render(<ThemeToggle />);

  expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(localStorage.getItem("crossposter:theme")).toBe("dark");
});
