# Upstream connection recovery

MCPX detects transport failures through periodic pings and tool calls. After the
configured failure threshold, it marks the upstream connection failed and
automatically retries. Failed initial connections are also retried.

Retry waits start at `UPSTREAM_RECONNECT_BASE_DELAY_MS` (30 seconds by default),
double after each failure, and stop increasing at **five minutes**. Attempts
continue while the server is unavailable. A successful connection resets the
backoff and restores tool discovery. The cap covers the wait between attempts;
connection timeouts and the handshake take additional time.

Every failed connection transition schedules recovery, including capability
discovery failures after OAuth completion or silent re-authentication. The old
watchdog is stopped while reconnecting. SDK request timeouts and closed
connections count as transport failures; ordinary MCP application errors do not.
Unexpected recovery errors are caught and retried rather than escaping the timer.

Recovery retains saved configuration and authentication. It retries connection
handshakes and capability discovery, **not failed tool calls**. A rebooted
upstream normally needs no gateway restart or token replacement. DNS and network
reachability remain prerequisites.

## Retry one server now

Call `mcpx__management_reconnect_server` with `{ "name": "your-server" }` to
cancel its pending wait, reset the backoff, and immediately attempt a failed
connection. Concurrent requests do not create parallel attempts. Connected,
connecting and pending-auth servers are left alone; pending-auth requires login.
The action never replaces configuration, deletes credentials or replays calls.
Enabling a server controls tool availability and does not force reconnection.

## Notification streams and configuration reload

Both normal and OAuth Streamable HTTP connections use a bounded notification
stream retry budget: 15 attempts, with waits growing from one to 30 seconds.
This lets supported streams survive brief outages. An optional GET returning
405 remains valid and causes no retry loop. Closing the client prevents further
network requests. Longer upstream outages are handled by full connection recovery.

`POST /admin/reload` re-reads configuration and clears all old connections,
watchdogs and retry timers, including failed servers removed from the file.
It retains credentials and cancels obsolete pending login flows. Stale in-flight
connections cannot restore removed servers. Subscriptions and the token-expiry
monitor are installed once; reload does not duplicate them. Existing downstream
sessions are closed, so clients reconnect as before.
