import z from "zod/v4";

export const localExportOmissionSchema = z.object({
  item: z.string(),
  reason: z.string(),
});

export const localExportRecoverySchema = z.object({
  guide: z.string(),
  requirements: z.array(z.string()),
  servers: z.array(
    z.object({
      name: z.string(),
      transport: z.string(),
      host: z.string().optional(),
      files: z.array(z.string()),
      requiredEnvironment: z.array(z.string()),
      requiredSecrets: z.array(z.string()),
      note: z.string(),
    }),
  ),
});

export const localExportResponseSchema = z.object({
  backupId: z.string(),
  createdAt: z.string().datetime(),
  destination: z.string(),
  included: z.array(z.string()),
  omitted: z.array(localExportOmissionSchema),
  recovery: localExportRecoverySchema.optional(),
});

export type LocalExportRecovery = z.infer<typeof localExportRecoverySchema>;
export type LocalExportResponse = z.infer<typeof localExportResponseSchema>;

export const localBackupSelectionSchema = z.object({
  backupId: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    .max(200),
});

export const localBackupImportRequestSchema = localBackupSelectionSchema.extend(
  {
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  },
);

export const localBackupPreviewSchema = z.object({
  backupId: z.string(),
  createdAt: z.string(),
  fingerprint: z.string(),
  serverNames: z.array(z.string()),
  savedSetupCount: z.number().int().nonnegative(),
  oauthFileCount: z.number().int().nonnegative(),
  restored: z.array(z.string()),
  manual: z.array(z.string()),
  restartRequired: z.literal(true),
});

export const localBackupImportResponseSchema = z.object({
  backupId: z.string(),
  restartRequired: z.literal(true),
  message: z.string(),
});

export type LocalBackupPreview = z.infer<typeof localBackupPreviewSchema>;
export type LocalBackupImportRequest = z.infer<
  typeof localBackupImportRequestSchema
>;
export type LocalBackupImportResponse = z.infer<
  typeof localBackupImportResponseSchema
>;
