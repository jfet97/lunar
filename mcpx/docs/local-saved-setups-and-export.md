# Local saved setups and full exports

When MCPX is not authenticated to Hub, Saved Setups are stored under
`.mcpx/saved-setups` in the server's working directory. Save, list, overwrite,
restore, and delete use the existing Control Plane UI. Local setup listings hide
server environment values and headers; restores load the complete setup on the
server. When Hub is authenticated, the existing Hub saved-setup API remains the
source of truth.

A saved setup is a logical configuration snapshot. Restoring one applies server
and app configuration, but does not restore OAuth tokens, OAuth client metadata,
PKCE verifiers, deployment files, or client configuration.

## Full local export

Choose **Export Full Backup** from Saved Setups. MCPX writes a new, uniquely named
directory under `~/.config/mcpx/backups` by default. Set `MCPX_BACKUP_DIR` to
change the destination. The UI shows the actual path, included files, omitted
sources, and the reason for each omission. The server does not return backup file
contents to the browser.

The export includes:

- `config/app.yaml` from the effective runtime configuration, including defaults
  when no app file exists, and `config/mcp.json` from the configured server file
  or a runtime snapshot when that file is unavailable.
- Only the configured app and MCP files are copied from their source locations;
  other sibling files in those directories are not swept into the export.
- A separate runtime server snapshot, the durable `.mcpx` state including OAuth
  tokens, registered OAuth client information, and PKCE verifier files.
- The deployment Compose file and image provenance, plus the relevant Claude
  and Codex client configuration files when the server can read them.
- A manifest containing file names and coverage information, but no credential
  values.

Files and directories in the export are written with modes `0600` and `0700`.
Symlinks in source trees are skipped. Tool embedding caches, live session data,
and nested backup directories are excluded. The effective app configuration
contains tool extensions and any literal secrets configured there. Hub-managed
profile secrets and skill catalogs are held by Hub or in process memory and are
not persisted in local state, so the export reports them as omitted. Re-provision
those values through Hub after restoring where applicable.

On macOS and other native runs, optional host files are discovered at
`~/.config/mcpx/compose.yaml`, `~/.config/mcpx/image.txt`, and
`~/.codex/config.toml`. Claude settings use `${CLAUDE_CONFIG_DIR}/.claude.json`
when `CLAUDE_CONFIG_DIR` is set, and `~/.claude.json` otherwise. Override
individual source paths with
`MCPX_EXPORT_COMPOSE_PATH`, `MCPX_EXPORT_IMAGE_PATH`,
`MCPX_EXPORT_CLAUDE_CONFIG_PATH`, and `MCPX_EXPORT_CODEX_CONFIG_PATH`.
`APP_CONFIG_PATH` and `SERVERS_CONFIG_PATH` may also point outside the default
config directory; their configured content is captured.

### Docker host paths

The default destination inside Docker is under the container's home directory.
It does not refer to the host's home directory. Mount the host backup directory
and set `MCPX_BACKUP_DIR` to its container path. Optional host Compose, image,
and client files must also be mounted read-only and selected with the matching
`MCPX_EXPORT_*_PATH` variables. Merge
[`examples/compose.local-export.yaml`](../examples/compose.local-export.yaml)
into the deployment Compose file; it is a sample overlay and does not change a
live Compose project. Remove optional file mounts from the overlay when the
corresponding host file does not exist.

### Manual restore

Stop the MCPX process before replacing files. Copy `config/app.yaml` and
`config/mcp.json` to the active paths named by `APP_CONFIG_PATH` and
`SERVERS_CONFIG_PATH`, then copy the exported `.mcpx` directory into the
server's working directory. For Docker, restore through the configured host
mounts. Recheck ownership and keep credentials private. Reapply included host
client or deployment files separately if needed; the export does not install or
restart anything. A full export is a filesystem backup, not an import action.
