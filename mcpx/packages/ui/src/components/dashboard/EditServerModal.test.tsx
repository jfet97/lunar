import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditServerModal } from "./EditServerModal";

const { editServer, descriptionState } = vi.hoisted(() => ({
  editServer: vi.fn(),
  descriptionState: {
    _type: "stdio",
    args: ["-y", "@upstash/context7-mcp"],
    command: "npx",
    env: {},
    icon: "",
    name: "context7",
    description: "Search library documentation",
    configuredDescription: "Search library documentation",
  },
}));

vi.mock("@/store", () => ({
  useModalsStore: (
    selector: (state: { editServerModalData: unknown }) => unknown,
  ) =>
    selector({
      editServerModalData: descriptionState,
    }),
}));

vi.mock("@/data/catalog-servers", () => ({
  useGetMCPServers: () => ({ data: [] }),
}));

vi.mock("@/data/permissions", () => ({
  usePermissions: () => ({ canAddCustomServerAndEdit: true }),
}));

vi.mock("@/data/mcp-server", () => ({
  useEditMcpServer: () => ({
    error: null,
    isPending: false,
    mutate: editServer,
  }),
}));

vi.mock("@/hooks/use-color-scheme", () => ({
  useColorScheme: () => "light",
}));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/useDomainIcon", () => ({
  useDomainIcon: () => null,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogDescription: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogFooter: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogHeader: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogTitle: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
}));

vi.mock("./McpColorInput", () => ({
  McpColorInput: () => <div>icon-input</div>,
}));

vi.mock("./McpJsonForm", () => ({
  McpJsonForm: () => <div data-testid="mcp-json-form">json-form</div>,
}));

describe("EditServerModal", () => {
  beforeEach(() => {
    editServer.mockReset();
    descriptionState.configuredDescription = "Search library documentation";
  });

  afterEach(cleanup);

  it("shows the saved description and saves a description-only change", async () => {
    const user = userEvent.setup();
    render(<EditServerModal isOpen onClose={vi.fn()} />);

    const input = screen.getByRole("textbox", { name: "Description" });
    expect(input).toHaveValue("Search library documentation");
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();

    await user.clear(input);
    await user.type(input, "Find package documentation");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(editServer).toHaveBeenCalledWith(
      {
        name: "context7",
        payload: expect.objectContaining({
          description: "Find package documentation",
          type: "stdio",
          command: "npx",
        }),
      },
      expect.any(Object),
    );
  });

  it("sends an empty description when clearing the custom value", async () => {
    const user = userEvent.setup();
    render(<EditServerModal isOpen onClose={vi.fn()} />);

    await user.clear(screen.getByRole("textbox", { name: "Description" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(editServer).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ description: "" }),
      }),
      expect.any(Object),
    );
  });

  it("uses the default description as a placeholder without creating an override", () => {
    descriptionState.configuredDescription = "";
    render(<EditServerModal isOpen onClose={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
      "",
    );
    expect(
      screen.getByPlaceholderText("Search library documentation"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
  });

  it("keeps the dialog shell shrinkable on narrow viewports", () => {
    const html = renderToStaticMarkup(
      <EditServerModal isOpen onClose={vi.fn()} />,
    );

    expect(html).toContain("w-[calc(100%-2rem)]");
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("min-h-0");
    expect(html).toContain("[scrollbar-gutter:stable]");
  });
});
