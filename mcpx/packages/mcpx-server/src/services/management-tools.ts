import { normalizeServerName } from "@mcpx/toolkit-core/data";
import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "winston";
import z from "zod/v4";
import { INTERNAL_SERVICE_NAME } from "../model/internal-service.js";
import { targetServerSchema } from "../model/target-servers.js";
import { tagTools } from "./capability-registry.js";
import { ConsumerContext, PermissionCheck } from "./capability-resolver.js";
import { InternalCapabilityProvider } from "./internal-capabilities-service.js";
import type { Services } from "./services.js";

type ManagementServices = Pick<
  Services,
  | "controlPlane"
  | "upstreamHandler"
  | "setupManager"
  | "localSavedSetups"
  | "localExportService"
  | "hubService"
>;

const serverNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform(normalizeServerName)
  .refine(
    (name) => name !== INTERNAL_SERVICE_NAME,
    "mcpx is a reserved server name",
  );
const namedSchema = z.object({ name: serverNameSchema }).strict();
const configuredSchema = namedSchema.extend({ config: targetServerSchema });
const backupSchema = z
  .object({
    mode: z.enum(["setup", "full"]),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

interface ManagementAction {
  name: string;
  description: string;
  schema: z.ZodType;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** Built-in management capabilities use services directly, without a self-connection. */
export class ManagementToolsService implements InternalCapabilityProvider {
  constructor(
    private readonly services: ManagementServices,
    private readonly permissions: PermissionCheck,
    private readonly useHubSavedSetups: () => boolean,
    private readonly callbackUrl: string,
    private readonly logger: Logger,
  ) {}

  getInternalCapabilityRegistrations(): ReturnType<
    InternalCapabilityProvider["getInternalCapabilityRegistrations"]
  > {
    const actions = this.actions();
    const definitions: Tool[] = actions.map((action) => ({
      name: action.name,
      description: action.description,
      inputSchema: z.toJSONSchema(action.schema, {
        io: "input",
      }) as Tool["inputSchema"],
      annotations: {
        readOnlyHint: action.readOnly ?? false,
        destructiveHint: action.destructive ?? false,
        idempotentHint: action.idempotent ?? false,
        openWorldHint: !action.readOnly,
      },
    }));
    return {
      handlers: actions.map((action) => ({
        kind: "tools" as const,
        name: action.name,
        isVisible: (consumer: ConsumerContext): boolean =>
          this.permissions.hasPermission({
            capabilityKind: "tools",
            serviceName: INTERNAL_SERVICE_NAME,
            capabilityName: action.name,
            ...consumer,
          }),
        handle: ({ args }): Promise<CallToolResult> =>
          this.execute(action, args),
      })),
      eagerRegistrations: [
        {
          serverName: INTERNAL_SERVICE_NAME,
          capabilities: { tools: tagTools(definitions, "internal") },
        },
      ],
    };
  }

  private async execute(
    action: ManagementAction,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = action.schema.safeParse(args);
    if (!parsed.success)
      return result(
        {
          message: "Invalid management tool arguments",
          issues: parsed.error.issues.map(({ path, message }) => ({
            path,
            message,
          })),
        },
        true,
      );
    try {
      return result(
        await action.execute(parsed.data as Record<string, unknown>),
      );
    } catch (_error) {
      // upstream errors can contain credentials, headers, command arguments, or URLs
      this.logger.warn("Management action failed", { tool: action.name });
      return result(
        {
          message:
            "Management action failed. Check the MCPX server logs for details.",
        },
        true,
      );
    }
  }

  private requireServer(name: string): void {
    if (!this.services.upstreamHandler.getTargetServer(name))
      throw new Error("Target server not found");
  }

  private actions(): ManagementAction[] {
    const services = this.services;
    const configured = (action: "add" | "update"): ManagementAction => ({
      name: `management_${action}_server`,
      description: `${action === "add" ? "Add" : "Replace the configuration of"} an MCP server. Supply a stdio command/args/env or an SSE/Streamable HTTP URL/headers. Existing gateway policies still apply. Configuration values may contain credentials; results never echo them.`,
      schema: configuredSchema,
      destructive: action === "update",
      execute: async (args): Promise<unknown> => {
        const { name, config } = configuredSchema.parse(args);
        if (action === "add")
          await services.controlPlane.addTargetServer({ ...config, name });
        else {
          const replacement = {
            ...config,
            name,
            ...(config.type === "stdio"
              ? {}
              : { headers: config.headers ?? {} }),
          };
          await services.controlPlane.updateTargetServer(replacement, {
            replaceConfiguration: true,
          });
        }
        return {
          name,
          message: `Server ${action === "add" ? "added" : "updated"}. Inspect management_list_servers for connection status.`,
        };
      },
    });
    const activation = (enabled: boolean): ManagementAction => ({
      name: `management_${enabled ? "enable" : "disable"}_server`,
      description: `${enabled ? "Enable" : "Disable"} an existing MCP server's tools without deleting its configuration or logging out.`,
      schema: namedSchema,
      idempotent: true,
      destructive: !enabled,
      execute: async (args): Promise<unknown> => {
        const { name } = namedSchema.parse(args);
        this.requireServer(name);
        if (enabled)
          await services.controlPlane.config.activateTargetServer(name);
        else await services.controlPlane.config.deactivateTargetServer(name);
        return { name, enabled };
      },
    });
    return [
      {
        name: "management_list_servers",
        description:
          "List configured MCP servers, including disabled and pending-auth servers, with connection status and enabled state. Does not expose commands, environment values, headers, URLs, or tokens.",
        schema: z.object({}).strict(),
        readOnly: true,
        idempotent: true,
        execute: async (): Promise<unknown> => {
          const attributes =
            services.controlPlane.config.getTargetServerAttributes();
          const states = new Map(
            services.controlPlane
              .getSystemState()
              .targetServers.map((server) => [server.name, server]),
          );
          return {
            servers: services.upstreamHandler.servers.map((server) => {
              const name = normalizeServerName(server.name);
              const state = states.get(name);
              return {
                name: server.name,
                transport: server.type,
                enabled: !attributes[name]?.inactive,
                state: state?.state.type ?? "connecting",
                oauth:
                  state && state._type !== "stdio"
                    ? Boolean(state.oauth)
                    : false,
              };
            }),
          };
        },
      },
      configured("add"),
      configured("update"),
      activation(true),
      activation(false),
      {
        name: "management_remove_server",
        description:
          "Delete an existing MCP server configuration and disconnect it. Saved OAuth authentication is also cleared. Create a backup first if recovery is needed.",
        schema: namedSchema,
        destructive: true,
        execute: async (args): Promise<unknown> => {
          const { name } = namedSchema.parse(args);
          await services.controlPlane.removeTargetServer(name, {
            strict: true,
          });
          return { name, removed: true };
        },
      },
      {
        name: "management_create_backup",
        description:
          "Create a setup snapshot (configuration, no OAuth token files) or a full private local backup (configuration, saved setups, OAuth state, available deployment/client files). Returns metadata and omissions, never file contents. Full backups use the configured MCPX_BACKUP_DIR; setup snapshots follow existing local/Hub ownership.",
        schema: backupSchema,
        execute: async (args): Promise<unknown> => {
          const { mode, description } = backupSchema.parse(args);
          if (mode === "full")
            return services.localExportService.create({
              effectiveAppConfig: services.controlPlane.getAppConfig().yaml,
              effectiveTargetServers: services.upstreamHandler.servers,
            });
          const setup = services.setupManager.captureCurrentSetup();
          const label = description ?? "Management backup";
          const saved = this.useHubSavedSetups()
            ? await services.hubService.savedSetups.saveSetup({
                ...setup,
                description: label,
              })
            : await services.localSavedSetups.save(label, setup);
          if (!saved.success) throw new Error("Could not save setup");
          return saved;
        },
      },
      {
        name: "management_login_server",
        description:
          "Start OAuth login for an existing MCP server and return a sign-in URL and optional device code. Present the URL to the user to complete sign-in in their browser, then inspect management_list_servers. Does not automate consent or return tokens.",
        schema: namedSchema,
        execute: async (args): Promise<unknown> => {
          const { name } = namedSchema.parse(args);
          const auth = await services.upstreamHandler.initiateOAuthForServer(
            name,
            this.callbackUrl,
          );
          return {
            name,
            authorizationUrl: auth.authorizationUrl,
            ...(auth.userCode ? { userCode: auth.userCode } : {}),
          };
        },
      },
      {
        name: "management_logout_server",
        description:
          "Clear an MCP server's saved OAuth authentication, cancel pending login, and disconnect authenticated tools while retaining its configuration. Reconnect with management_login_server. This is local logout, not provider-wide account revocation. Static headers/env credentials must be edited instead.",
        schema: namedSchema,
        destructive: true,
        execute: async (args): Promise<unknown> => {
          const { name } = namedSchema.parse(args);
          await services.upstreamHandler.logoutOAuthForServer(name);
          return { name, loggedOut: true };
        },
      },
    ];
  }
}

function result(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}
