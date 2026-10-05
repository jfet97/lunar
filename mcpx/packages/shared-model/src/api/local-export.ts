import z from "zod/v4";

export const localExportOmissionSchema = z.object({
  item: z.string(),
  reason: z.string(),
});

export const localExportResponseSchema = z.object({
  backupId: z.string(),
  createdAt: z.string().datetime(),
  destination: z.string(),
  included: z.array(z.string()),
  omitted: z.array(localExportOmissionSchema),
});

export type LocalExportResponse = z.infer<typeof localExportResponseSchema>;
