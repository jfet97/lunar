# Built-in management tools

MCPX registers these tools on `/mcp` by default. On `/mcp/lazy`, permitted
management tools are advertised directly with the four discovery tools. Call
them by their qualified names without searching first, for example
`mcpx__management_add_server`.

| Tool                        | Purpose                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `management_list_servers`   | List configured servers with enabled, connection, and OAuth status.                 |
| `management_add_server`     | Add an MCP server using its stdio, SSE, or Streamable HTTP configuration.           |
| `management_update_server`  | Replace a server's connection configuration.                                        |
| `management_enable_server`  | Make an existing server's tools available.                                          |
| `management_disable_server` | Block an existing server's tools while preserving configuration and authentication. |
| `management_remove_server`  | Remove a server configuration and its saved OAuth authentication.                   |
| `management_create_backup`  | Save a setup snapshot or create a full local backup.                                |
| `management_login_server`   | Start OAuth login and return a browser URL and optional device code.                |
| `management_logout_server`  | Clear MCPX's saved OAuth authentication while retaining the server configuration.   |

## Access and credentials

The tools require the existing MCPX authentication. Each management capability
uses the configured `mcpx` tool permission for both listing and execution, so
denied tools are absent from discovery and calls are checked again when made.
Permission policies for upstream servers do not limit these administrative
actions: permission to a management tool allows it to administer any configured
upstream server.

Server names are normalized to lowercase. `mcpx` is reserved. Listing returns
only names, transport type, enabled state, connection state, and whether OAuth
is active; it does not return commands, environment values, URLs, headers, or
tokens. Add and update accept connection settings, including credentials, but
tool results and error messages do not echo submitted or stored credentials.
Treat configuration arguments as sensitive input in the calling client.
Update replaces the saved connection configuration; omitted remote headers are
cleared, so credentials from an old URL are not carried to its replacement.

OAuth login only starts the existing MCPX flow. The user must complete the
provider's browser or device-code consent step. MCPX does not return tokens or
automate consent. Logout clears credentials stored by MCPX and cancels a
pending flow; it does not revoke the provider's browser session or edit static
headers and environment credentials.
Server removal reports success only after disconnect, OAuth credential
deletion, and server configuration persistence succeed. A failure returns a
tool error instead of a successful removal result.

## Backups

Use `management_create_backup` with `mode: "setup"` for a configuration
snapshot. It follows the current saved-setup owner: standalone instances save
locally, while enterprise or Hub-authenticated instances continue using Hub.
This snapshot does not include OAuth token files.

Use `mode: "full"` for a private local recovery export. It uses the configured
MCPX backup directory, including `MCPX_BACKUP_DIR` when set; callers cannot
choose an arbitrary output path. The response includes the export location,
included items, and omissions, never file contents. Exports can contain OAuth
state and other credentials, so expose the destination only to trusted
operators. Hub-managed data and optional sources that are unavailable are
reported as omitted. With Docker, configure a writable host mount for the
backup directory if the export must be retrieved from the host.

See the [backup and restore guide](local-saved-setups-and-export.md) for export
coverage, Docker mounts, and manual recovery steps.
