# Upstream connection recovery

MCPX detects transport failures through periodic pings and tool calls. After the
configured failure threshold, it marks the upstream connection failed and
automatically retries. Failed initial connections are also retried.

Retry waits start at `UPSTREAM_RECONNECT_BASE_DELAY_MS` (30 seconds by default),
double after each failure, and stop increasing at **five minutes**. Attempts
continue while the server is unavailable. A successful connection resets the
backoff and restores tool discovery. The cap covers the wait between attempts;
connection timeouts and the handshake take additional time.

Recovery retains the saved server configuration and authentication. A rebooted
upstream does not normally require restarting MCPX or re-entering its token.
Enabling a server controls tool availability; it does not force reconnection.

## Local Telegram endpoint

The Raspfet deployment uses one hostname for two separate HTTPS endpoints:

- `https://hooks.raspfet.dev/t3/telegram/main`: Telegram's incoming webhook,
  authenticated with its webhook secret, on port 443.
- `https://hooks.raspfet.dev:8443/mcp`: the LAN Telegram MCP used by MCPX,
  authenticated with its MCP bearer token.

MCPX must resolve that hostname to the Pi's LAN address to reach port 8443.
A connection timeout should prompt a DNS and LAN reachability check before
changing any credentials.
