# MCP server authentication

OAuth servers offer **Logout** in the MCP Servers list and the server details drawer. Logout closes the active connection and clears MCPX's saved access and refresh tokens, PKCE verifier, and OAuth client registration. The server remains configured and returns to **Authentication required**. Use **Authenticate** to sign in again.

Logout cancels pending login flows and invalidates old callbacks and background credential writes. Connected clients immediately lose access to the server's normal tools and prompts. Cached responses from the previous login are not reused after signing in again. A deletion failure is reported, and Logout remains available for retry.

The activation toggle controls access independently. Disabling a server preserves its authentication and connection while rejecting calls and removing its capabilities from discovery. Re-enabling restores access without another login. Logging out of a disabled server does not re-enable it.

Logout clears authentication stored by MCPX. The provider's browser session remains managed by that provider. Servers using configured API keys or authorization headers do not offer OAuth Logout; edit their configuration to change those credentials.

The authenticated control-plane endpoint is `POST /auth/logout/:name`. It returns success only after closing the connection and clearing credentials. Unsupported authentication returns HTTP 400, an unknown server returns HTTP 404, and credential deletion failures return HTTP 500.
