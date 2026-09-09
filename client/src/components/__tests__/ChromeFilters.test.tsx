import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceLabelFilter } from "../SourceLabelFilter";
import { WorkspaceFilter } from "../WorkspaceFilter";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chrome filter variants", () => {
  const workspaces = [
    { workspace_id: "1", workspace_name: "Workspace one", cloud: "gcp", region: "west4" },
    { workspace_id: "2", workspace_name: "Workspace two", cloud: "aws", region: "us-east-1" },
  ];
  const renderWithQueryClient = (component: React.ReactNode) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
  };

  it("keeps the existing header trigger by default", () => {
    renderWithQueryClient(
      <WorkspaceFilter
        workspaces={workspaces}
        selectedIds={[]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "2 Workspaces" })).toHaveClass("co-filter");
  });

  it("renders the workspace trigger with the rail skin", () => {
    renderWithQueryClient(
      <WorkspaceFilter
        workspaces={workspaces}
        selectedIds={[]}
        onChange={vi.fn()}
        variant="rail"
      />,
    );

    const trigger = screen.getByRole("button", { name: "2 Workspaces" });
    expect(trigger).toHaveClass(
      "rail-workspace-filter",
      "h-[28px]",
      "w-[116px]",
      "min-[1280px]:w-[190px]",
      "bg-white/[.07]",
      "rail-control-border",
    );
    expect(trigger.className).not.toContain("border-white");
    expect(trigger.querySelectorAll("svg").item(1)).toHaveClass("ml-auto");
    expect(screen.getByText("2 workspaces")).toHaveClass("min-[1180px]:hidden");
    expect(trigger).not.toHaveClass("co-filter");
  });

  it("labels the workspace where this app is deployed", async () => {
    renderWithQueryClient(
      <WorkspaceFilter
        workspaces={workspaces}
        currentWorkspaceId="1"
        selectedIds={[]}
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "2 Workspaces" }));
    expect(screen.getByText("this app")).toBeVisible();
    expect(screen.getByText("this app").closest("label")).toHaveTextContent("Workspace one");
    expect(screen.getByTitle("Google Cloud")).toHaveAttribute("src", expect.stringContaining("gcp.svg"));
    expect(screen.getByTitle("AWS")).toHaveAttribute("src", expect.stringContaining("aws"));
  });

  it("keeps a single source-linked workspace selectable", async () => {
    renderWithQueryClient(
      <WorkspaceFilter
        workspaces={[workspaces[0]]}
        selectedIds={["1"]}
        onChange={vi.fn()}
        showSingleOption
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Workspace one" }));
    expect(screen.getByRole("checkbox", { name: "Workspace one" })).toBeVisible();
  });

  it("keeps the applied Clear action outside the trigger", async () => {
    const onChange = vi.fn();
    renderWithQueryClient(
      <WorkspaceFilter
        workspaces={workspaces}
        selectedIds={["1"]}
        onChange={onChange}
        variant="rail"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Workspace one" });
    const clear = screen.getByRole("button", { name: "Clear workspace filter" });
    expect(trigger).not.toContainElement(clear);
    expect(trigger.querySelector("button")).toBeNull();

    await userEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("cancels draft changes and closes with Escape without applying", async () => {
    const onChange = vi.fn();
    renderWithQueryClient(
      <WorkspaceFilter
        workspaces={workspaces}
        selectedIds={["1"]}
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Workspace one" });
    await userEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Filter workspaces" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Workspace one" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Filter workspaces" })).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(screen.getByRole("checkbox", { name: "Workspace one" })).toBeChecked();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Filter workspaces" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps historical workspaces hidden and unselected until requested", async () => {
    const onIncludeHistoricalChange = vi.fn();
    renderWithQueryClient(
      <WorkspaceFilter
        workspaces={[
          ...workspaces,
          { workspace_id: "3", workspace_name: "Deleted workspace", historical: true },
        ]}
        selectedIds={[]}
        onChange={vi.fn()}
        includeHistorical={false}
        onIncludeHistoricalChange={onIncludeHistoricalChange}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "2 Workspaces" }));
    expect(screen.queryByRole("checkbox", { name: "Deleted workspace" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onIncludeHistoricalChange).toHaveBeenLastCalledWith(false);

    await waitFor(() => expect(screen.getByRole("button", { name: "2 Workspaces" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "2 Workspaces" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Include historical workspaces/i }));
    expect(screen.getByRole("checkbox", { name: /^Deleted workspace/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Workspace one" })).toBeChecked();
  });

  it("uses the shared dark rail border while workspaces load", () => {
    renderWithQueryClient(
      <WorkspaceFilter
        workspaces={[]}
        selectedIds={[]}
        onChange={vi.fn()}
        isLoading
        variant="rail"
      />,
    );

    const loading = screen.getByText("Updating…").closest(".rail-workspace-filter");
    expect(loading).toHaveClass("rail-control-border", "text-[11px]");
    expect(loading?.className).not.toContain("border-white");
  });

  it("renders the source trigger with the rail skin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        local_label: "This workspace",
        sources: [{ label: "Shared source", catalog: "main", schema: "billing" }],
      }),
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <SourceLabelFilter variant="rail" />
      </QueryClientProvider>,
    );

    const trigger = await screen.findByRole("button", { name: "2 Sources" });
    expect(trigger).toHaveClass(
      "rail-source-filter",
      "h-[28px]",
      "w-[116px]",
      "min-[1280px]:w-[190px]",
      "bg-white/[.07]",
      "rail-control-border",
    );
    expect(trigger.className).not.toContain("border-white");
    expect(trigger.querySelectorAll("svg").item(1)).toHaveClass("ml-auto");
    expect(screen.getByText("2 sources")).toHaveClass("min-[1180px]:hidden");
    expect(trigger).not.toHaveClass("co-filter");
  });
});
