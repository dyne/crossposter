// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Client contracts and display metadata must not reach the configuration server.
vi.mock("@/lib/local-config", () => { throw new Error("Server configuration reached browser metadata"); });

afterEach(cleanup);

describe("browser platform metadata", () => {
  it("renders every platform label and keeps shared contracts browser-safe", async () => {
    const { platformIds, platformLabels } = await import("@/lib/platform-catalog");
    const { platformSchema } = await import("@/lib/publishing/contracts");
    const { requiredConfigByPlatform } = await import("@/lib/config-spec");
    const { SocialLogo } = await import("@/components/social-logo");
    render(<>{platformIds.map((platform) => <SocialLogo key={platform} platform={platform} />)}</>);
    expect(Object.keys(requiredConfigByPlatform)).toEqual([...platformIds]);
    for (const platform of platformIds) {
      expect(platformSchema.parse(platform)).toBe(platform);
      expect(screen.getByRole("img", { name: `${platformLabels[platform]} logo` }).title).toBe(platformLabels[platform]);
    }
  });
});
