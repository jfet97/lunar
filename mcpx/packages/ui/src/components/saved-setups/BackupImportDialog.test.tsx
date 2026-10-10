import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api";
import { BackupImportDialog } from "./BackupImportDialog";

vi.mock("@/lib/api", () => ({
  apiClient: {
    getPendingBackupImport: vi.fn(),
    previewLocalBackup: vi.fn(),
    importLocalBackup: vi.fn(),
    cancelBackupImport: vi.fn(),
  },
}));

const preview = {
  backupId: "mcpx-backup",
  createdAt: "2026-10-06T12:00:00.000Z",
  fingerprint: "a".repeat(64),
  serverNames: ["atlassian-media"],
  oauthFileCount: 3,
  savedSetupCount: 1,
  restored: ["config/app.yaml"],
  manual: ["deployment/compose.yaml"],
  restartRequired: true as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient.getPendingBackupImport).mockResolvedValue(null);
  vi.mocked(apiClient.previewLocalBackup).mockResolvedValue(preview);
  vi.mocked(apiClient.importLocalBackup).mockResolvedValue({
    backupId: preview.backupId,
    restartRequired: true,
    message: "Queued",
  });
  vi.mocked(apiClient.cancelBackupImport).mockResolvedValue(undefined);
});

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BackupImportDialog onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function loadPreview() {
  fireEvent.change(screen.getByLabelText("Backup folder name"), {
    target: { value: preview.backupId },
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Preview import" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  await screen.findByText("What will be replaced");
}

describe("BackupImportDialog", () => {
  it("requires preview before queuing and then shows restart and cancel controls", async () => {
    renderDialog();
    expect(
      screen.queryByRole("button", { name: "Queue import" }),
    ).not.toBeInTheDocument();
    await loadPreview();
    expect(
      screen.getByText(
        /1 configured servers, 1 saved setups, and 3 OAuth files/,
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Queue import" }));
    await screen.findByText(
      /Restart MCPX using your normal deployment controls/,
    );
    expect(apiClient.importLocalBackup).toHaveBeenCalledWith({
      backupId: preview.backupId,
      fingerprint: preview.fingerprint,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel queued import" }),
    );
    await screen.findByLabelText("Backup folder name");
    expect(apiClient.cancelBackupImport).toHaveBeenCalledOnce();
  });

  it("invalidates the preview when the selected folder changes", async () => {
    renderDialog();
    await loadPreview();
    fireEvent.change(screen.getByLabelText("Backup folder name"), {
      target: { value: "different-backup" },
    });
    expect(
      screen.queryByRole("button", { name: "Queue import" }),
    ).not.toBeInTheDocument();
  });

  it("shows validation and staging failures from the server", async () => {
    vi.mocked(apiClient.previewLocalBackup).mockRejectedValueOnce(
      new Error("Invalid backup manifest"),
    );
    renderDialog();
    fireEvent.change(screen.getByLabelText("Backup folder name"), {
      target: { value: preview.backupId },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Preview import" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid backup manifest",
    );
    await loadPreview();
    vi.mocked(apiClient.importLocalBackup).mockRejectedValueOnce(
      new Error("Backup changed since preview"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Queue import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Backup changed since preview",
    );
  });

  it("shows an import that was queued in a previous session", async () => {
    vi.mocked(apiClient.getPendingBackupImport).mockResolvedValue({
      backupId: preview.backupId,
      restartRequired: true,
      message: "Queued",
    });
    renderDialog();
    expect(
      await screen.findByRole("button", { name: "Cancel queued import" }),
    ).toBeVisible();
    expect(
      screen.queryByLabelText("Backup folder name"),
    ).not.toBeInTheDocument();
  });
});
