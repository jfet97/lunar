import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axiosClient } from "@/data/axios-client";
import { ServerLogoutButton } from "./ServerLogoutButton";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

describe("ServerLogoutButton", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.toast.mockReset();
  });

  it("logs out only the selected server and prevents repeated requests while pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const post = vi.spyOn(axiosClient, "post").mockImplementation(async () => {
      await gate;
      return { data: { message: "ok" } };
    });
    const parentClick = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div onClick={parentClick}>
          <ServerLogoutButton serverName="docs/team" />
        </div>
      </QueryClientProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Log out of docs/team" }),
    );
    expect(post).toHaveBeenCalledWith("/auth/logout/docs%2Fteam");
    expect(
      screen.getByRole("button", { name: "Log out of docs/team" }),
    ).toBeDisabled();
    expect(parentClick).not.toHaveBeenCalled();
    release();
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Logged out of docs/team" }),
      ),
    );
  });

  it("shows deletion failures and allows retry", async () => {
    vi.spyOn(axiosClient, "post").mockRejectedValue(
      new Error("Unable to clear credentials"),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ServerLogoutButton serverName="docs" />
      </QueryClientProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Log out of docs" }),
    );
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          description: "Unable to clear credentials",
        }),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Log out of docs" }),
    ).toBeEnabled();
  });
});
