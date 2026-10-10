import { useState } from "react";
import type { LocalBackupPreview } from "@mcpx/shared-model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  usePendingBackupImport,
  usePreviewBackupImport,
  useStageBackupImport,
  useCancelBackupImport,
} from "@/data/backup-import";

export function BackupImportDialog({ onClose }: { onClose: () => void }) {
  const [backupId, setBackupId] = useState("");
  const [preview, setPreview] = useState<LocalBackupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = usePendingBackupImport();
  const previewMutation = usePreviewBackupImport();
  const stageMutation = useStageBackupImport();
  const cancelMutation = useCancelBackupImport();
  const busy =
    previewMutation.isPending ||
    stageMutation.isPending ||
    cancelMutation.isPending;
  const showError = (error: Error) => setError(error.message);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Gateway Backup</DialogTitle>
          <DialogDescription>
            Restore gateway configuration, locally saved setups, and OAuth state
            on the next restart. Docker images, companion services, and host
            client files are recovered separately.
          </DialogDescription>
        </DialogHeader>
        {pending.data ? (
          <div className="space-y-3 text-sm">
            <p>
              Queued backup: <code>{pending.data.backupId}</code>
            </p>
            <p>
              Restart MCPX using your normal deployment controls to apply the
              import. Your running configuration stays active until then.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError(null);
                cancelMutation.mutate(undefined, {
                  onSuccess: () => {
                    setPreview(null);
                  },
                  onError: showError,
                });
              }}
            >
              Cancel queued import
            </Button>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <p>
              Place the exported backup folder in the gateway&apos;s configured
              backup directory. On a new machine, install and start MCPX first,
              then copy the folder there.
            </p>
            <div>
              <Label htmlFor="backup-folder">Backup folder name</Label>
              <Input
                id="backup-folder"
                className="mt-2"
                placeholder="mcpx-20261006T120000Z-…"
                value={backupId}
                disabled={busy}
                onChange={(event) => {
                  setBackupId(event.target.value);
                  setPreview(null);
                  setError(null);
                }}
              />
            </div>
            <Button
              variant="outline"
              disabled={
                busy || !backupId.trim() || pending.isLoading || !!pending.error
              }
              onClick={() => {
                setError(null);
                const requestedId = backupId.trim();
                previewMutation.mutate(requestedId, {
                  onSuccess: setPreview,
                  onError: showError,
                });
              }}
            >
              {previewMutation.isPending ? "Validating..." : "Preview import"}
            </Button>
            {preview && (
              <section className="space-y-3">
                <h3 className="font-semibold">What will be replaced</h3>
                <p>
                  {preview.serverNames.length} configured servers,{" "}
                  {preview.savedSetupCount} saved setups, and{" "}
                  {preview.oauthFileCount} OAuth files. Existing saved setups
                  and OAuth state will be replaced, including when the backup
                  contains none.
                </p>
                {preview.serverNames.length > 0 && (
                  <p>Servers: {preview.serverNames.join(", ")}</p>
                )}
                <p>
                  Gateway settings and access rules will also be replaced.
                  Previous files are retained privately for manual rollback.
                  Nothing is applied until MCPX restarts.
                </p>
                {preview.manual.length > 0 && (
                  <details>
                    <summary>
                      Files for manual recovery ({preview.manual.length})
                    </summary>
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {preview.manual.map((file) => (
                        <li className="break-all" key={file}>
                          {file}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            )}
          </div>
        )}
        {(error || pending.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? pending.error?.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Close
          </Button>
          {!pending.data && preview && (
            <Button
              disabled={busy || !!pending.error}
              onClick={() => {
                setError(null);
                stageMutation.mutate(
                  {
                    backupId: preview.backupId,
                    fingerprint: preview.fingerprint,
                  },
                  { onError: showError },
                );
              }}
            >
              {stageMutation.isPending ? "Queuing..." : "Queue import"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
