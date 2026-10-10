import z from "zod/v4";

const relativeFilePath = z
  .string()
  .min(1)
  .refine((value) => {
    const segments = value.split("/");
    return segments.every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        /^[a-zA-Z0-9._-]+$/.test(segment),
    );
  });

export const companionFilesSchema = z
  .object({
    version: z.literal(1),
    services: z.array(
      z
        .object({
          name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
          files: z.array(
            z
              .object({
                source: relativeFilePath,
                destination: relativeFilePath,
              })
              .strict(),
          ),
        })
        .strict()
        .refine(({ files }) => {
          const paths = files.map((file) => file.destination.toLowerCase());
          return paths.every((candidate, index) =>
            paths.every(
              (other, otherIndex) =>
                index === otherIndex ||
                (candidate !== other && !candidate.startsWith(`${other}/`)),
            ),
          );
        }),
    ),
  })
  .strict()
  .refine(({ services }) => {
    const names = services.map((service) => service.name);
    return new Set(names).size === names.length;
  });
