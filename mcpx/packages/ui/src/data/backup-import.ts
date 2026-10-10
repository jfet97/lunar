import { apiClient } from "@/lib/api";
import type { LocalBackupImportRequest } from "@mcpx/shared-model";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const QUERY_KEY = ["backup-import"] as const;

export const usePendingBackupImport = () =>
  useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiClient.getPendingBackupImport(),
    staleTime: 0,
    retry: false,
  });

export const usePreviewBackupImport = () =>
  useMutation({
    mutationFn: (backupId: string) => apiClient.previewLocalBackup(backupId),
  });

export const useStageBackupImport = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LocalBackupImportRequest) =>
      apiClient.importLocalBackup(input),
    onSuccess: (result) => queryClient.setQueryData(QUERY_KEY, result),
  });
};

export const useCancelBackupImport = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.cancelBackupImport(),
    onSuccess: () => queryClient.setQueryData(QUERY_KEY, null),
  });
};
