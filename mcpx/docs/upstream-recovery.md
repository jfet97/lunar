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

## Known recovery gaps

The shorter cap does not repair every recovery path:

- Capability discovery failures after OAuth completion or silent re-authentication
  can leave a failed connection without scheduling another attempt.
- SDK `RequestTimeout` and `ConnectionClosed` errors are currently excluded from
  transport failures, so timed-out calls can incorrectly reset watchdog failures.
- There is no per-server action to force an immediate retry while preserving
  credentials. Enabling tools does not perform that action.

These require separate fixes. DNS and network reachability also remain
prerequisites; a reachable probe does not mean a scheduled retry has already run.
