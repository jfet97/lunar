import {
  HEADER_PARAMS_EXTRACTION_REGEX,
  LocalExportRecovery,
} from "@mcpx/shared-model";
import { EnvValue, TargetServer } from "../model/target-servers.js";

export function buildRecoveryReport(
  servers: TargetServer[],
  companionFiles: Map<string, string[]>,
): LocalExportRecovery {
  return {
    guide: "RESTORE.md",
    requirements: [
      "Install Docker or a supported native MCPX runtime on the destination machine.",
      "Obtain compatible images or packages separately; image references are not image archives.",
      "Adapt deployment mounts, client paths, service addresses, and Docker networks to the destination machine.",
      "Recreate companion services and restore their persistent data separately. Selected files do not include their data volumes.",
      "Supply environment and secret references from their original source; these references are not resolved into credentials by the export.",
    ],
    servers: servers.map((server) => {
      const values: EnvValue[] = Object.values(
        server.type === "stdio" ? server.env : (server.headers ?? {}),
      );
      const requiredEnvironment = values.flatMap((value) =>
        value && typeof value === "object" && "fromEnv" in value
          ? [value.fromEnv]
          : [],
      );
      if (server.type !== "stdio") {
        for (const value of values) {
          if (typeof value !== "string") continue;
          for (const match of value.matchAll(HEADER_PARAMS_EXTRACTION_REGEX)) {
            if (match[1] !== undefined) requiredEnvironment.push(match[1]);
          }
        }
      }
      const requiredSecrets = values.flatMap((value) =>
        value && typeof value === "object" && "fromSecret" in value
          ? [value.fromSecret]
          : [],
      );
      const files = companionFiles.get(server.name) ?? [];
      return {
        name: server.name,
        transport: server.type,
        host: server.type === "stdio" ? undefined : getHost(server.url),
        files,
        requiredEnvironment: [...new Set(requiredEnvironment)].sort(),
        requiredSecrets: [...new Set(requiredSecrets)].sort(),
        note:
          files.length > 0
            ? "Selected companion files are included. Review omissions and recreate the service, credentials, networking, and persistent data separately."
            : server.type === "stdio"
              ? "The launch configuration is included. Install the command and packages separately; referenced scripts and data are not copied automatically."
              : "The connection configuration is included. Keep the remote service reachable or recreate the separately hosted service; its deployment, environment, and data are not copied automatically.",
      };
    }),
  };
}

export function renderRestoreGuide(recovery: LocalExportRecovery): string {
  const requirements = recovery.requirements
    .map((item) => `- ${item}`)
    .join("\n");
  const servers = recovery.servers
    .map((server) => {
      const details = [
        `### ${markdownText(server.name)}`,
        `Transport: ${markdownText(server.transport)}${server.host ? `; host: ${markdownText(server.host)}` : ""}.`,
        server.note,
        ...server.files.map((file) => `- Selected file: ${file}`),
        ...server.requiredEnvironment.map(
          (name) => `- Required environment variable: ${markdownCode(name)}`,
        ),
        ...server.requiredSecrets.map(
          (name) => `- Required secret reference: ${markdownCode(name)}`,
        ),
      ];
      return details.join("\n\n");
    })
    .join("\n\n");
  return `# Restore this MCPX gateway backup

This directory contains configuration files and durable gateway state. It does not install software, create containers, or restore companion service data. The Saved Setups Restore action applies a saved configuration only. Use Import Gateway Backup to recover the gateway's configuration, locally saved setups, and OAuth state.

## Before restoring

${requirements}

Read manifest.json for the exact included files and omissions. Deployment and client files are original reference copies and may contain machine-specific paths. Review them before using them on another machine. Image references require an accessible registry and an image compatible with the destination architecture; an unavailable image needs a separately saved image or a source build.

## Restore the gateway

For a standalone gateway with file-backed server configuration, place this entire backup folder in the destination gateway's configured backup directory. Start MCPX, open Saved Setups > Import Gateway Backup, enter the folder name, and choose Preview import. Review the replacement counts and files for manual recovery, then choose Queue import and restart MCPX through your deployment controls. The import is applied before configuration is loaded and upstream connections are opened. You can cancel the queued import before restarting. Host client files, deployment files, companion files, and other durable state need manual recovery.

The import replaces saved setups and OAuth state even if the backup contains none. Previous gateway files are retained privately beside their destinations; .restore/last-import.json in the backup directory records their locations. OAuth credentials may still require login. Hub-managed installations must recover their state through Hub.

For manual recovery instead:

1. Install the runtime and obtain the MCPX image or native packages. Review deployment/compose.yaml and deployment/image.txt if included. Create the destination mounts or volumes while the MCPX server is stopped.
2. Copy config/app.yaml and config/mcp.json to the destination's APP_CONFIG_PATH and SERVERS_CONFIG_PATH. Copy .mcpx/ into the MCPX server's working directory or its mounted state volume. Preserve private permissions and set ownership for the destination server user.
3. Review companions/ if included. Each service directory contains only its selected files. Reconnect Compose env_file and other file references to those destinations, supply any missing credentials, recreate the service and network, and restore its data from a separate backup where necessary.
4. Update machine-specific paths and server addresses. Reapply selected client configuration entries from clients/ to the destination clients instead of overwriting their entire configurations blindly.
5. Start MCPX and verify each upstream connection. OAuth credentials may be expired, revoked, or require a new login. Recover Hub-managed data through Hub.

## Upstream services

${servers || "No upstream servers were configured at export time."}
`;
}

function getHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function markdownText(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/([\\`*_{}[\]<>#])/g, "\\$1");
}

function markdownCode(value: string): string {
  const content = value.replace(/[\r\n]/g, " ");
  const runs = content.match(/`+/g) ?? [];
  const delimiter = "`".repeat(
    Math.max(0, ...runs.map((run) => run.length)) + 1,
  );
  return `${delimiter} ${content} ${delimiter}`;
}
