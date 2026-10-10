# Local saved setups and gateway backups

For a practical explanation with remote MCP, local process, Docker, environment,
and migration examples, start with
[Understanding MCPX backups](backup-examples.md). This guide covers source paths,
file selection, import validation, and recovery procedures.

When MCPX is not authenticated to Hub, Saved Setups are stored under
`.mcpx/saved-setups` in the server's working directory. Save, list, overwrite,
restore, and delete use the existing Control Plane UI. Local setup listings hide
server environment values and headers; restores load the complete setup on the
server. When Hub is authenticated, the existing Hub saved-setup API remains the
source of truth.

A saved setup is a logical configuration snapshot. Restoring one applies server
and app configuration, but does not restore OAuth tokens, OAuth client metadata,
PKCE verifiers, deployment files, or client configuration.

## Example: one configuration, two different saves

Suppose your gateway has these three connections:

- **honeycomb-eu (Honeycomb):** a remote MCP service you have logged into through
  MCPX's OAuth flow.
- **atlassian-media:** a separate Docker container, reached at
  `http://atlassian-media:9005/mcp`. Its API token comes from that service's own
  Compose or environment file.
- **local-tools:** a server launched by MCPX using `node ./server.js`. Its MCPX
  server entry contains a literal `API_TOKEN` value and a `REGION` value configured
  as `{ "fromEnv": "LOCAL_REGION" }`.

The names and file contents below are illustrative. They do not describe a new
backup of your running installation.

### Save Working configuration

Choose **Save Current Setup** and name it **Working configuration**. On a
standalone instance, MCPX writes one JSON file under
`.mcpx/saved-setups/<setup-id>.json`, containing:

- The three server entries: addresses, transports, commands, arguments, and
  connection settings configured in MCPX.
- The literal `API_TOKEN` configured for `local-tools` and the `LOCAL_REGION`
  reference. The reference's external value is not captured.
- Gateway settings such as access rules, tool groups, and tool extensions.

It does not contain Honeycomb's OAuth login tokens, the `atlassian-media` container
or its API token, the `server.js` file or its Node dependencies, Docker images,
deployment files, or client configuration. A saved setup can contain credentials
entered directly in server or gateway settings even though it excludes OAuth
login state.

Now remove Honeycomb from MCPX or change an access rule. Choosing **Restore** for
**Working configuration** applies the saved server entries and gateway settings
to the running gateway. The separate Docker service must already be reachable,
and `server.js`, Node, and `LOCAL_REGION` must still be available. Lost, expired,
or revoked OAuth credentials may require login again.

### Export a gateway backup of the same configuration

With deployment and client files mounted and companion files explicitly selected,
an export could contain this directory. Optional files appear only when available;
`manifest.json` records the actual coverage.

```text
mcpx-<timestamp>-<backup-id>/
  config/
    app.yaml                         gateway settings
    mcp.json                         configured server entries
  sources/
    configured-app.yaml              original app file, when available
  runtime/
    mcp.json                         server entries captured from runtime
  .mcpx/
    saved-setups/<setup-id>.json      Working configuration
    tokens/
      honeycomb-eu-tokens.json        persisted access and refresh tokens
      honeycomb-eu-client.json        registered OAuth client information
      honeycomb-eu-verifier.txt       stored PKCE verifier, when present
  deployment/
    compose.yaml                     MCPX deployment recipe
    image.txt                        MCPX image reference
  clients/
    claude-config.json               mounted Claude configuration
    codex-config.toml                mounted Codex configuration
  companions/
    files.json                       explicit file selection
    atlassian-media/
      compose.yaml                   selected companion deployment recipe
      .env                           selected file with its actual env values
  RESTORE.md                         recovery instructions and service inventory
  manifest.json                      included files and omissions
```

The `atlassian-media/.env` file appears only if you explicitly selected a readable
file containing those values. A Compose placeholder such as
`${ATLASSIAN_API_TOKEN}` does not cause MCPX to read that token from the running
container or your shell. The literal `local-tools` token remains in its server
configuration; `LOCAL_REGION` remains an external requirement.

This export still contains no Docker installation, image archives, companion data
volumes, `server.js`, Node packages, or remote Honeycomb data. Embedding
caches, live sessions, and Hub-managed state are excluded. Compose and client
files are original reference copies whose paths may need adjustment.

On another machine, first install Docker or the native runtime and obtain the
MCPX image or packages. **Import Gateway Backup**, followed by a restart, restores
`config/app.yaml`, `config/mcp.json`, saved setups, and OAuth files. It can restore
the persisted Honeycomb credentials, although a new login may still be necessary.
It does not consume `runtime/mcp.json` as a second server configuration.

Recover `atlassian-media` manually using its selected Compose and `.env` files,
obtain its image, and recreate the required Docker network and any service data.
Install `local-tools` and provide `LOCAL_REGION` separately. Review and reapply
the deployment and client files for the destination machine. If companion files
were not selected, the export retains only MCPX's connection to that service;
you need its deployment files and credentials from another source.

## Gateway backup export

Choose **Export Gateway Backup** from Saved Setups. MCPX writes a new, uniquely named
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
- `RESTORE.md` with manual recovery steps and a service inventory listing
  unresolved environment and secret references. Connection credentials and URL
  query values are not exposed in this inventory.
- Explicitly selected companion service files when configured as described below.

This is a gateway file backup. Docker itself, container images, other services'
data volumes, and running container environments are not exported. Image
references identify images to obtain separately; they are not offline image
copies. Original Compose and client files may contain machine-specific paths and
must be reviewed on the destination machine.

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

### Optional companion service files

Set `MCPX_EXPORT_COMPANIONS_PATH` to a JSON selection file readable by MCPX.
Files are selected explicitly; MCPX does not inspect other containers or read
their environment. A selection can include a companion service's Compose file,
an environment file containing its actual credential values, and configuration
files. Nothing is inferred from `${VARIABLE}` placeholders in a Compose file.

For example, create a directory containing `files.json`, a Compose file, and
an environment file:

```json
{
  "version": 1,
  "services": [
    {
      "name": "atlassian-media",
      "files": [
        {
          "source": "atlassian-media.compose.yaml",
          "destination": "compose.yaml"
        },
        { "source": "atlassian-media.env", "destination": ".env" }
      ]
    }
  ]
}
```

Both paths are relative: sources resolve within the directory containing
`files.json`; destinations resolve within `companions/<service-name>/` in the
export. Nested paths are allowed. Paths use letters, numbers, dots, underscores,
hyphens, and `/` separators; absolute paths and `.` or `..` segments are rejected.
Service names must be unique lowercase letters, numbers, underscores, or hyphens,
starting with a letter or number. Match the MCPX server name to associate selected
files with its recovery inventory. Destination paths must be unique without file
and directory collisions, including case-only differences.

In Docker, mount only this selected directory read-only, for example:

```yaml
environment:
  MCPX_EXPORT_COMPANIONS_PATH: /host-companions/files.json
volumes:
  - ${HOME}/.config/mcpx/backup-companions:/host-companions:ro
```

An invalid or unavailable selection file fails the export. Missing selected
files, directories, and symlinks are reported as omissions. Other files in the
mounted directory are not copied. Selected files retain their private content
and are exported with the same private permissions as OAuth files; their values
are not returned to the UI or added to the manifest. The recovery inventory
reports files that were copied, without claiming the service is complete.

On recovery, adapt the Compose file's `env_file`, configuration paths, host
mounts, and networks to the selected destinations. If credentials come from a
password manager, shell, or other external source, supply them separately rather
than assuming the selection captures them. Keep service data backups separately.

### Import a gateway backup

On a standalone instance using file-backed server configuration, copy the exported
backup folder into the destination's configured backup directory. Keep its name
equal to `backupId` in `manifest.json`. In Docker, this means the host directory
mounted at `MCPX_BACKUP_DIR`, not an arbitrary host path visible only to the browser.
On a new machine, install Docker or the native runtime, obtain a compatible MCPX
image or packages, and start an empty gateway first.

Choose **Import Gateway Backup** on Saved Setups, enter the folder name, and choose
**Preview import**. The preview validates the manifest, app and server config,
saved setups, and OAuth files without exposing their values. It lists replacement
counts and files requiring manual recovery. Only backups with a declared `.mcpx`
state tree can be imported; a config-only export needs manual recovery.

Choose **Queue import**, then restart MCPX through your normal deployment controls.
The queue stores a private copy of the validated gateway files. It does not change
the running configuration, restore files live, or restart the process. If the
source changed since preview, queuing is rejected and a new preview is required.
You can reopen the dialog and cancel a queued import before restarting.

On startup, before loading configuration or connecting upstream servers, MCPX
replaces `APP_CONFIG_PATH`, `SERVERS_CONFIG_PATH`, `.mcpx/tokens`, and
`.mcpx/saved-setups`. Saved setups and OAuth state are replaced as a whole,
including when the backup contains none. Other `.mcpx` files, deployment files,
host client files, and companion selections are listed for manual recovery.
Imports do not install Docker, pull images, start companion containers, change
environment variables, or recover Hub-managed data. Enterprise instances and
instances authenticated to Hub reject local imports.

Both original unversioned manifests and export schema versions 1 and 2 are
accepted. Symlinks, traversal paths, invalid content, missing declared state, and
unsupported manifest versions are rejected. Gateway imports are limited to
64 MiB and 10,000 files, with at most 16 MiB per file. There is no browser upload:
the selection names a backup directory already readable by the gateway.

#### Interrupted imports and rollback

Files are replaced by rename on their destination filesystems. A private
transaction journal lets the next startup roll back an interrupted, uncommitted
replacement or finish an already committed import. If a replacement fails,
previous files are restored before the failure is reported. Startup stops on an
unsafe import or unresolved rollback; it does not connect using partial state.

After success, originals remain beside the destination files with names beginning
`.mcpx-import-` and ending `.old`. The private receipt at
`<backup-directory>/.restore/last-import.json` records their locations. Stop MCPX
before using those files for a manual rollback. These originals are excluded from
subsequent exports. Queued files and transaction metadata live under `.restore/`
in the configured backup directory and must persist across restarts.

If startup cannot apply a queued import, inspect the error while MCPX is stopped.
When `.restore/transaction.json` is absent, no replacement is in progress: removing
`.restore/pending.json` cancels automatic retry, and its `staged-<id>` directory can
be removed separately. If a transaction journal exists, preserve the journal and
original files and resolve the reported filesystem or destination-path problem
before restarting. Do not clear the journal to bypass recovery.

### Manual restore

On a new machine, install Docker or the native runtime and obtain compatible
images or packages first. Use `RESTORE.md`
and `manifest.json` from the export to check prerequisites and omissions. If an
image is no longer available from its registry, obtain an independently saved
image or build it from source. Recreate destination mounts and volumes while
MCPX is stopped; deployment files are references, not automatically portable
installation scripts.

Stop the MCPX process before replacing files. Copy `config/app.yaml` and
`config/mcp.json` to the active paths named by `APP_CONFIG_PATH` and
`SERVERS_CONFIG_PATH`, then copy the exported `.mcpx` directory into the
server's working directory. For Docker, restore through the configured host
mounts. Recheck ownership and keep credentials private. Reapply included host
client or deployment files separately if needed; the export does not install or
restart anything. Exporting creates the backup directory; importing gateway state
is a separate action.
