# Understanding MCPX backups: examples and recovery

MCPX can save a configuration or export a gateway backup. Neither action creates
a complete copy of your computer or every MCP service connected to the gateway.

**Save Current Setup** keeps a configuration you can switch back to. **Export
Gateway Backup** creates a separate directory for recovering gateway files and
durable state. Older versions may call the export **Export Full Backup**; that
name does not imply that it includes all connected services.

This guide explains those boundaries with illustrative examples. All credentials,
image names, and service addresses in examples are placeholders.

Jump to [storage locations](#2-where-mcpx-and-exported-backups-live),
[credential examples](#4-environment-variables-and-credentials-what-is-actually-saved),
[MCP server examples](#5-examples-for-different-kinds-of-mcp-servers),
[exported files](#6-an-exported-directory-and-what-each-file-does),
[companion file selection](#7-opt-in-to-companion-files-without-collecting-an-entire-machine),
or [import and missing dependencies](#8-what-happens-when-you-import).

## 1. Three things that can need recovery

Think of an installation as three parts:

1. **MCPX:** server connection settings, gateway rules, locally saved setups, and
   persisted OAuth login state.
2. **The upstream MCP services:** a hosted provider, a local script, or another
   Docker container. These have their own software, credentials, and sometimes data.
3. **The surrounding installation:** Docker, images, Compose files, environment
   sources, networks, host mounts, and client configuration.

A saved setup covers configuration in the first part. A gateway backup covers
gateway configuration and durable local state, plus certain readable installation
files and explicitly selected companion files. Other services and the runtime
still need their own recovery plan.

| Item                                                                         | Saved setup            | Exported gateway backup                                       | Applied by Import Gateway Backup    |
| ---------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------- | ----------------------------------- |
| MCP server URLs, transports, commands, arguments, and configured env/headers | Yes                    | Yes                                                           | Yes                                 |
| Gateway configuration, such as permissions and tool groups                   | Saved setup settings   | Effective app configuration                                   | Yes                                 |
| Literal credentials stored in those settings                                 | Yes                    | Yes                                                           | Yes, as part of configuration       |
| Values behind environment or secret references                               | Reference only         | Reference only, unless separately captured in a selected file | Reference only                      |
| Locally stored saved setups                                                  | One snapshot per setup | All local saved setups                                        | Replaces the local collection       |
| Persisted local OAuth tokens, registered clients, and PKCE verifier files    | No                     | Yes, when present                                             | Replaces local OAuth files          |
| MCPX Compose file and image reference                                        | No                     | When readable at the configured source paths                  | Manual recovery                     |
| Configured Claude and Codex client files                                     | No                     | When readable at the configured source paths                  | Manual recovery                     |
| Explicitly selected companion Compose, env, or config files                  | No                     | Yes, when readable                                            | Manual recovery                     |
| Docker engine, image archives, other containers, and their data volumes      | No                     | No automatic capture                                          | Separate recovery                   |
| Scripts and installed packages outside selected files or gateway state       | No                     | No automatic capture                                          | Separate recovery                   |
| Remote provider data and Hub-managed data                                    | No local copy          | No local copy                                                 | Recover through the provider or Hub |

**A reference identifies where to obtain a value; it is not a copy of that value.**
The export does not resolve references into credentials or inspect other
containers to discover their environments.

## 2. Where `.mcpx` and exported backups live

`.mcpx` is a directory under the **MCPX server's working directory**. It is not
automatically `~/.mcpx`, and it is separate from the active configuration files
selected by `APP_CONFIG_PATH` and `SERVERS_CONFIG_PATH`.

For example, a native development run started in `mcpx/packages/mcpx-server`
uses `mcpx/packages/mcpx-server/.mcpx`. A container whose working directory is
`/lunar/packages/mcpx-server` uses `/lunar/packages/mcpx-server/.mcpx`.

Within it, standalone saved setups live in `.mcpx/saved-setups`, and locally
persisted OAuth files live in `.mcpx/tokens`. Enterprise instances and instances
authenticated to Hub use Hub saved-setup storage; an enterprise instance does not
switch to local storage when its Hub connection drops.

For Docker, distinguish these locations:

| Location                          | Meaning                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Container `.mcpx` path            | Where the MCPX process reads and writes its local state                           |
| Docker named volume mounted there | Persistent state managed by Docker; on Docker Desktop, it resides in the Linux VM |
| Host directory bind-mounted there | State stored at the host path you selected                                        |
| Export destination                | A separate directory containing an exported copy                                  |

A named volume called `mcpx_state` is not a macOS folder called `~/mcpx_state`.
The mount connects the volume to the container path. A persistent volume keeps
data through ordinary container replacement, but losing or deleting the volume
also loses the saved setups and OAuth files stored in it.

The export default is `~/.config/mcpx/backups`, where `~` means the home directory
**of the process running MCPX**. In Docker, that is the container's home, unless
you configure a destination and mount it to the host. For example, this fragment
of the MCPX service makes exports available on the host:

```yaml
environment:
  MCPX_BACKUP_DIR: /mcpx-backups
volumes:
  - ${HOME}/.config/mcpx/backups:/mcpx-backups
```

An export at `/mcpx-backups/mcpx-<timestamp>-<id>` is then visible on the host as
`~/.config/mcpx/backups/mcpx-<timestamp>-<id>`. The full exported path displayed in
the UI is the gateway's path, which may differ from the host path.

A backup left on the same disk can help recover accidentally deleted gateway
state, but losing that disk also loses the backup. Copy exported directories to
the storage you use for disaster recovery.

## 3. Saved setup: return to a working configuration

Suppose you connect Honeycomb and a Docker service, configure permissions, and
save **Working configuration**. You then experiment with a different server URL
or access rule.

Choosing **Restore** on that saved setup applies its server entries and saved
gateway settings to the running MCPX instance. It can reconnect services and
launch configured local processes, subject to the destination's runtime and policy.
It does not recreate another Docker deployment or restore its data.

On a standalone instance, the setup is one private JSON file:

```text
<MCPX working directory>/.mcpx/saved-setups/<setup-id>.json
```

That file can include credentials entered directly in configuration. It does
not contain persisted OAuth login state. Restoring a setup does not rewind OAuth
tokens to their values when the setup was saved. An unchanged connection may
reuse existing login state; changing or recreating a connection, or losing its
tokens, can require authentication again.

Saving a setup also does not create an independent export. If the gateway's
local state is lost, its local saved setups are lost with it.

## 4. Environment variables and credentials: what is actually saved?

The same variable name can be supplied in different places. Its location, not
the name, determines whether the value is captured.

### A literal entered in MCPX

An illustrative local server entry in `mcp.json`:

```json
{
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["/opt/local-tools/server.js"],
      "env": {
        "API_TOKEN": "example-token-not-a-real-secret",
        "REGION": "eu"
      }
    }
  }
}
```

Both actions save these literal values with the server entry. After restore,
MCPX supplies them when launching the process. The script and Node runtime must
be available separately. A literal credential in a remote server's `headers`,
URL, or configured command arguments is likewise part of configuration.

### A value referenced through `fromEnv`

Replace the server's `env` with:

```json
{
  "API_TOKEN": { "fromEnv": "LOCAL_TOOLS_TOKEN" },
  "REGION": { "fromEnv": "LOCAL_REGION" }
}
```

Both actions save these reference objects, not the values of `LOCAL_TOOLS_TOKEN`
and `LOCAL_REGION`. After restore, those names must resolve in the destination's
MCPX environment or its configured target-server environment source.

If MCPX runs inside Docker, exporting a variable in your Mac terminal does not
by itself put that variable inside the running container. Supply the variable to
the MCPX service through its deployment configuration or the appropriate secret
source. A value supplied only to a different service's container is also not
available to MCPX merely because both containers use Docker.

### A value referenced through `fromSecret`

```json
{
  "API_TOKEN": { "fromSecret": "LOCAL_TOOLS_TOKEN" }
}
```

The reference is saved; its resolved value is not copied out of the secret source.
Re-provision the destination's corresponding value. Hub-managed profile secrets
need recovery through Hub. Static OAuth credentials supplied externally to MCPX
also remain external unless they are literally stored in exported configuration.

### A remote HTTP header with a variable placeholder

An illustrative remote server entry:

```json
{
  "type": "streamable-http",
  "url": "https://mcp.example.invalid/mcp",
  "headers": {
    "Authorization": "Bearer {{REMOTE_TOKEN}}"
  }
}
```

Both actions save the header template. The destination still needs a value for
`REMOTE_TOKEN`. This MCPX header syntax and Compose's `${VARIABLE}` syntax are
different mechanisms. Neither placeholder is a backed-up credential.

### Compose interpolation, `env_file`, and shell variables

These are fragments of a companion service's Compose configuration:

```yaml
environment:
  ATLASSIAN_API_TOKEN: ${ATLASSIAN_API_TOKEN}
```

```yaml
env_file:
  - ./atlassian-media.env
```

Copying the first fragment preserves a placeholder. Copying the second preserves
a filename. Neither copies the actual token. If you explicitly select a readable
environment file containing the actual value, the gateway export copies that
file. If the file itself contains references, those references still need their
sources. Values held only in a shell, password manager, Docker secret, or running
container environment are not extracted automatically.

| How the value is supplied                                | What the export retains                          | What recovery still needs                                   |
| -------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| Literal in an MCPX server entry or gateway setting       | The literal value                                | A service that can use it; the credential must remain valid |
| `fromEnv` or `fromSecret`                                | The reference name                               | Its destination environment or secret source                |
| HTTP header `{{REMOTE_TOKEN}}`                           | The template                                     | The corresponding value                                     |
| Companion Compose `${ATLASSIAN_API_TOKEN}`               | The expression, if that Compose file is selected | A value for Compose interpolation                           |
| Companion Compose `env_file: ./service.env`              | The path, if Compose is selected                 | The actual file; select and recover it separately           |
| Literal in an explicitly selected `.env` or Compose file | The file's contents                              | Manual placement and any path adjustments                   |
| Inherited MCPX process environment                       | No automatic environment snapshot                | The deployment or environment source                        |
| OAuth login persisted locally by MCPX                    | OAuth files in a gateway backup                  | A provider that accepts them; possibly login again          |

`STDIO_INHERIT_PROCESS_ENV`, when enabled, changes which environment a local
process receives. It does not make that inherited environment part of a backup.

## 5. Examples for different kinds of MCP servers

### Hosted remote MCP using OAuth

MCPX connects to a provider-hosted MCP and handles its OAuth login, for example
Honeycomb. The provider operates the upstream service.

- **Saved setup:** keeps the connection settings and gateway rules, without the
  persisted login tokens.
- **Gateway backup:** additionally keeps OAuth tokens, registered client metadata,
  and verifier files that MCPX persisted locally.
- **After import:** MCPX attempts the configured connection using its restored
  state. The provider must remain reachable and accept the credentials. Expired
  or revoked credentials, or changed OAuth registration requirements, can require
  login again. The provider's own data is not in the backup.

If another application or the upstream service itself handles authentication,
its login state is not automatically MCPX's local OAuth state.

### Remote MCP using an API token

For an HTTP MCP whose token is entered directly into an MCPX header, the literal
header is saved. For a token supplied through a reference or template, the
reference is saved and the value must be supplied again. No gateway backup copies
the remote service's application, database, or files merely because MCPX calls it.

### Another Docker container reached over HTTP

MCPX has this server entry:

```json
{
  "type": "streamable-http",
  "url": "http://atlassian-media:9005/mcp"
}
```

From MCPX's perspective this is an HTTP connection. It does not infer the Docker
image, Compose file, environment, or volumes behind that address.

- **Saved setup:** keeps the URL and gateway rules.
- **Gateway backup without companion selection:** also keeps gateway state, but
  has no deployment or credentials for this other container.
- **Gateway backup with selected companion files:** can include that service's
  Compose, actual `.env`, and selected configuration files. It still has no image
  archive or automatic volume backup.
- **After import:** MCPX tries to reach that URL. You must recreate the service and
  networking separately. A container named `atlassian-media` on an unrelated
  Docker network does not make the address reachable from MCPX.

A Compose file for MCPX does not automatically include a second, separate Compose
file. If several services are declared in the one exported file, their declarations
are copied as file content; their environments, referenced files, images, and data
are still not recursively collected.

### Local MCP launched as `node`, `npx`, or `uvx`

For `node /opt/local-tools/server.js`, both actions retain the command, arguments,
configured env values or references, and gateway rules. They do not automatically
copy `/opt/local-tools/server.js`, its dependency tree, or its data directory.

For `npx` or `uvx`, package names and versions in the arguments are saved. Package
caches and installed packages are not. Ordinary startup may obtain packages
through those tools, but that depends on available runtimes, registries, and
credentials. Pin versions and keep the software available separately when
reproducibility or offline recovery matters.

“Local” means local to the **MCPX process**. If MCPX runs in Docker, a host script
is available only when mounted or included in the image. `/Users/alex/server.js`
on the host is not automatically that path inside the container. Review paths
and mounts when moving machines. Local launches also require the destination's
`ENABLE_STDIO_MCP_SERVERS` policy to permit them; import does not configure it.

### A Docker MCP launched by MCPX through stdio

An illustrative launch entry might use:

```json
{
  "type": "stdio",
  "command": "docker",
  "args": ["run", "--rm", "-i", "example/local-tools:1.2.3"],
  "env": {
    "API_TOKEN": { "fromEnv": "LOCAL_TOOLS_TOKEN" }
  }
}
```

Both actions retain the launch recipe and token reference. Neither saves the
image contents, Docker engine, or service volumes.

This differs from the HTTP container example: during normal connection startup,
MCPX can launch a Docker command for this entry. The destination needs an allowed
Docker launch configuration, working Docker access, the required credential,
and a compatible image. MCPX's stdio and Docker launch policies must permit it.
Docker may obtain an available image during ordinary `run`; a missing registry
image or unavailable Docker engine can still make the connection fail.

Import does not run a general deployment plan. Restoring a launch recipe can
lead to its execution when MCPX opens normal upstream connections.

## 6. An exported directory, and what each file does

With all optional source files available and selected, an export could look like:

```text
mcpx-<timestamp>-<id>/
  config/
    app.yaml
    mcp.json
  sources/
    configured-app.yaml
  runtime/
    mcp.json
  .mcpx/
    saved-setups/<setup-id>.json
    tokens/<server>-tokens.json
    tokens/<server>-client.json
    tokens/<server>-verifier.txt
  deployment/
    compose.yaml
    image.txt
  clients/
    claude-config.json
    codex-config.toml
  companions/
    files.json
    atlassian-media/compose.yaml
    atlassian-media/.env
  RESTORE.md
  manifest.json
```

- `config/app.yaml` contains the effective gateway app configuration.
- `config/mcp.json` contains the configured server file, or a runtime-derived
  file when that source is unavailable. This is the server file used by import.
- `sources/configured-app.yaml` preserves the original app file when available.
  `runtime/mcp.json` is a separate snapshot for reference. Import does not merge
  these reference copies into the canonical `config/` files.
- `.mcpx/` contains exported durable local gateway state. Import applies its
  `tokens` and `saved-setups` directories; other durable files need manual recovery.
- `deployment/` and `clients/` contain readable source files, not automatically
  rewritten configurations for the new machine. An image reference identifies
  an image to obtain; it contains no image layers.
- `companions/` contains only explicitly selected files, not complete services.
- `RESTORE.md` explains recovery and lists upstream requirements recognized from
  MCPX's connection configuration. It does not discover every dependency or parse
  all credential requirements in companion files.
- `manifest.json` records what was included or omitted. Optional files shown here
  may be absent in your export: check your own manifest.

Tool embedding caches, live sessions, temporary state, nested backup directories,
and previous import rollback files are excluded. Source symlinks are skipped.
Host files must be readable by the gateway; a file existing on your Mac is not
enough if the container cannot see it.

The files are copies with private permissions (`0600` files, `0700` directories),
not encrypted archives. Actual configuration and selected files can contain
credentials even though the UI and manifest do not display their values.

## 7. Opt in to companion files without collecting an entire machine

For example, prepare this host directory with regular files:

```text
~/.config/mcpx/backup-companions/
  files.json
  atlassian-media.compose.yaml
  atlassian-media.env
```

Use this `files.json`:

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
        {
          "source": "atlassian-media.env",
          "destination": ".env"
        }
      ]
    }
  ]
}
```

Sources resolve relative to `files.json`; destinations resolve inside
`companions/atlassian-media/`. Match the MCPX server name to associate the files
with its recovery inventory. For a Docker deployment, add this fragment to the
MCPX service:

```yaml
environment:
  MCPX_EXPORT_COMPANIONS_PATH: /host-companions/files.json
volumes:
  - ${HOME}/.config/mcpx/backup-companions:/host-companions:ro
```

Only selected regular files are copied. The export does not sweep the directory,
follow symlinks, inspect Docker, or collect files referenced by Compose. Missing
selected files are reported as omissions; an invalid or unavailable selection
file fails the export.

Because this example renames `atlassian-media.env` to `.env` in the export,
review any `env_file` paths when recovering the service. Select an actual env
file only if you want its contents in the backup. Keeping secrets in a password
manager and supplying them again is also a valid recovery strategy.

Keep Docker volume data or databases in separate service backups. Copying a
service's recipe does not capture its running state or guarantee that its
database can be recovered.

## 8. What happens when you import?

**Restore** on a saved setup applies configuration to the running gateway.
**Import Gateway Backup** stages gateway recovery for the next startup. These
are separate actions.

On a standalone instance with file-backed server configuration:

1. Install the runtime and obtain a compatible MCPX image or packages. Start the
   destination gateway so its UI and backup directory are available.
2. Copy the entire exported directory into the destination's `MCPX_BACKUP_DIR`.
   Keep its folder name equal to `backupId` in the manifest. There is no browser
   upload; the gateway must already be able to read the directory.
3. Choose **Import Gateway Backup**, enter the folder name, and choose **Preview
   import**. Inspect the replacement counts and files requiring manual recovery.
4. Choose **Queue import**. MCPX stores a private validated copy. The running
   configuration remains active. You can cancel the queue before restarting.
5. Restart MCPX through your normal deployment controls. Before loading
   configuration or opening upstream connections, it replaces the app config,
   server config, `.mcpx/tokens`, and `.mcpx/saved-setups` with the queued copies.
6. MCPX opens its normal upstream connections. Verify them and recover the
   missing service, credential, runtime, or network dependencies separately.

Import is **replacement, not merge**. Current local saved setups and OAuth files
are replaced even when the backup contains none. Previous gateway files are
retained for manual rollback; their locations are recorded in
`<backup-directory>/.restore/last-import.json`. The queue must persist across the
restart. Export the current state first if you need an independent copy of it.

Import leaves deployment files, client files, companion files, external env
sources, and other durable state for manual recovery. It does not install Docker,
provision remote services, configure networks, or apply companion Compose files.
Enterprise and Hub-authenticated instances reject local imports. Use a version
that provides **Import Gateway Backup**, or follow the manual restore guide.

### If something is missing on the destination

| Missing dependency                                           | What happens                                                   | What to recover separately                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Docker or a native MCPX runtime                              | You cannot start that deployment to use its import UI          | Install the runtime and obtain MCPX first                                                 |
| MCPX image                                                   | A copied reference cannot start a container by itself          | Pull a compatible available image, use an independent image archive, or build from source |
| Separate HTTP MCP container                                  | Gateway state can be imported; that connection cannot succeed  | The service's deployment, image, credentials, network, and any data                       |
| Image for a stdio Docker MCP                                 | Normal connection startup may obtain it or fail                | An available compatible image, Docker access, and permitted launch settings               |
| `node`, `npx`, `uvx`, a script, or package dependencies      | The configured local launch cannot succeed                     | Runtime, script, packages, mounts, and allowed launch settings                            |
| Value named by `fromEnv`, `fromSecret`, or a header template | The server can require input or fail authentication/connection | The destination environment or secret source                                              |
| OAuth files, or provider acceptance of restored tokens       | Authentication is needed again                                 | A new login or provider registration                                                      |
| Companion data volume or database                            | A recreated container does not recover its old data            | That service's separate consistent data backup                                            |
| Old host paths or a Docker network                           | Saved addresses or mounts may not work                         | Adapt paths, mount sources, addresses, and network membership                             |

A valid gateway import does not verify that every upstream service is reachable.
Successful file recovery and successful upstream connections are different checks.

Missing dependencies are different from missing backup files. If a gateway state
file declared in the manifest is absent, or the backup content is invalid, preview
rejects the import. A config-only export without a declared `.mcpx` state tree
needs manual recovery. If a queued filesystem replacement fails, recovery rolls
back before startup proceeds; an unresolved recovery problem stops startup.

Images must also support the destination architecture. An ARM64 image used on
Apple Silicon is not automatically a native AMD64 image for an x86 machine.
Preserving a tag or digest identifies the image; it does not make the image
available for every architecture or guarantee the registry will retain it.

## 9. Choosing what to save for common situations

**“I want to experiment with permissions or connections.”** Save a setup. You can
restore the configuration from the UI while keeping the installation you already
have. Use an export too if you need recovery of persisted OAuth state.

**“I want to replace or upgrade the MCPX container on the same machine.”** Preserve
the gateway configuration and state mounts, and export a gateway backup first.
The backup does not retain the old image itself; keep an obtainable reference or
a separate image archive if needed. Companion containers have their own lifecycle.

**“I want to move to another machine.”** Export gateway state, select useful
companion deployment/config files, keep credentials available through selected
files or your secret source, and back up companion data separately. Obtain images
and runtimes, adapt machine-specific paths, import gateway state, and recreate the
services. This keeps the backup useful without requiring a copy of every image
and filesystem.

**“The gateway's `.mcpx` volume was lost.”** A setup stored in that volume cannot
recover itself. An independent gateway export can recover local saved setups and
persisted OAuth files that were present when exported. It cannot recover changes
made after that export.

**“A separate MCP service lost its data volume.”** Restore that service's data
backup. MCPX's saved URL and a copied Compose file cannot reconstruct its database.

Neither saving nor exporting runs automatically. An export is a copy made when
you request it; import does not keep a background synchronization running.

For source path overrides, import validation, interrupted imports, and manual
rollback, see [Local saved setups and gateway backups](local-saved-setups-and-export.md).
For host mounts, see the [Compose overlay](../examples/compose.local-export.yaml).
