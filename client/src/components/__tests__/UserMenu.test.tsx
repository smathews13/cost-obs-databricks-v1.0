import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { UserMenu } from "../UserMenu";

const props = {
  name: "Example User",
  email: "user@example.com",
  isAdmin: true,
  workspaceHost: "dbc-example.cloud.databricks.com",
};

describe("UserMenu", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      github_issue_url: "https://github.com/smathews13/cost-obs-databricks-v1.0/issues/new",
      email_href: null,
      slack: null,
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replaces opaque forwarded identity names with a readable email-derived name", async () => {
    const user = userEvent.setup();
    render(<UserMenu {...props} name="00000000-0000-4000-8000-000000000000" />);

    await user.click(screen.getByRole("button", { name: /user@example\.com/i }));

    expect(await screen.findByText("User")).toBeInTheDocument();
    expect(screen.queryByText(/00000000-0000/)).not.toBeInTheDocument();
  });

  it("shows workspace navigation, feedback, and logout actions", async () => {
    const user = userEvent.setup();
    render(<UserMenu {...props} />);

    const trigger = screen.getByRole("button", { name: /user@example\.com/i });
    expect(trigger).toHaveClass(
      "rail-user-trigger",
      "rail-control-border",
      "h-[28px]",
      "min-w-0",
      "border",
      "bg-white/[.07]",
    );
    expect(trigger.className).not.toContain("border-white");
    expect(trigger).toHaveAttribute("data-state", "closed");
    expect(readFileSync("src/index.css", "utf8")).toMatch(
      /\.rail-user-trigger:hover\s*\{[^}]*background-color:\s*#294a56/s,
    );
    expect(screen.queryByTestId("user-menu-silhouette")).not.toBeInTheDocument();
    const domainIcon = screen.getByTestId("user-menu-domain-icon");
    expect(domainIcon).not.toHaveClass("border", "shadow-sm");
    expect(domainIcon).not.toHaveAttribute("style");
    expect(domainIcon.querySelector("img")).toHaveAttribute(
      "src",
      "/brand/databricks-symbol-white.svg",
    );
    expect(screen.getByText(props.email)).toHaveClass(
      "hidden",
      "min-[900px]:block",
      "min-[1280px]:max-w-[160px]",
    );
    await user.click(trigger);

    expect(trigger).toHaveAttribute("data-state", "open");
    expect(screen.getByTestId("user-menu-expanded-domain-icon")).toHaveStyle({
      backgroundColor: "rgb(255, 95, 70)",
    });
    expect(trigger).toHaveClass("bg-[#294A56]");
    const menu = await screen.findByRole("menu", { name: "User menu" });
    expect(menu).toBeInTheDocument();
    expect(menu.querySelector("img")).toHaveAttribute(
      "src",
      "/brand/databricks-symbol-white.svg",
    );
    expect(screen.getByRole("menuitem", { name: "Back to Apps" })).toHaveAttribute(
      "href",
      "https://dbc-example.cloud.databricks.com/apps",
    );
    expect(screen.getByRole("menuitem", { name: "Logout" })).toHaveAttribute(
      "href",
      "https://dbc-example.cloud.databricks.com",
    );
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("supports arrow navigation through the feedback submenu", async () => {
    const user = userEvent.setup();
    render(<UserMenu {...props} />);
    const trigger = screen.getByRole("button", { name: /user@example\.com/i });

    await user.click(trigger);
    const backToApps = await screen.findByRole("menuitem", { name: "Back to Apps" });
    await waitFor(() => expect(backToApps).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    const feedback = screen.getByRole("menuitem", { name: "Report Feedback" });
    expect(feedback).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    const github = await screen.findByRole("menuitem", { name: "GitHub issue" });
    const chooser = screen.getByRole("menu", { name: "Send via" });
    expect(chooser).toHaveAttribute("data-floating-menu");
    expect(chooser.parentElement).toBe(document.body);
    await waitFor(() => expect(github).toHaveFocus());
    expect(github).toHaveAttribute(
      "href",
      "https://github.com/smathews13/cost-obs-databricks-v1.0/issues/new",
    );

    await user.keyboard("{ArrowLeft}");
    expect(feedback).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "User menu" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("dismisses on an outside click and returns focus", async () => {
    const user = userEvent.setup();
    render(<UserMenu {...props} />);
    const trigger = screen.getByRole("button", { name: /user@example\.com/i });

    await user.click(trigger);
    expect(await screen.findByRole("menu", { name: "User menu" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "User menu" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("uses explicit dark-mode menu tokens for readable portaled content", async () => {
    const user = userEvent.setup();
    render(<UserMenu {...props} />);
    await user.click(screen.getByRole("button", { name: /user@example\.com/i }));
    expect(await screen.findByRole("menu", { name: "User menu" })).toHaveClass("user-menu-panel");

    const css = readFileSync("src/index.css", "utf8");
    expect(css).toMatch(/\.dark-mode \.user-menu-panel[\s\S]*background: var\(--dm-surface\)/);
    expect(css).toMatch(/\.dark-mode \.user-menu-item[\s\S]*color: var\(--dm-text\)/);
  });

  it("adds only runtime-configured email and Slack feedback targets", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      github_issue_url: "https://github.com/example/project/issues/new",
      email_href: "mailto:feedback@example.com?subject=cost-obs%20feedback",
      slack: {
        url: `slack://user?team=T${"1".repeat(8)}&id=U${"2".repeat(8)}`,
        fallback_url: "https://example.slack.com/team/member",
      },
    }));
    const user = userEvent.setup();
    render(<UserMenu {...props} />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/user/feedback-targets",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await user.click(screen.getByRole("button", { name: /user@example\.com/i }));
    await user.click(screen.getByRole("menuitem", { name: "Report Feedback" }));

    expect(await screen.findByRole("menuitem", {
      name: "Slack message",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Email" })).toHaveAttribute(
      "href",
      "mailto:feedback@example.com?subject=cost-obs%20feedback",
    );
  });

  it("omits an unsafe Slack target returned by a compromised backend", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      github_issue_url: "https://github.com/example/project/issues/new",
      email_href: null,
      slack: {
        url: "javascript:alert(1)",
        fallback_url: null,
      },
    }));
    const user = userEvent.setup();
    render(<UserMenu {...props} />);

    await user.click(screen.getByRole("button", { name: /user@example\.com/i }));
    await user.click(screen.getByRole("menuitem", { name: "Report Feedback" }));

    expect(screen.queryByRole("menuitem", {
      name: "Slack message",
    })).not.toBeInTheDocument();
  });
});
