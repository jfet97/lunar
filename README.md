<div align="center">
<img src="readme-files/logo-light.png#gh-light-mode-only" width="50%" height="50%" />
<img src="readme-files/logo-dark.png#gh-dark-mode-only" width="50%" height="50%" />

<a href="https://opensource.org/licenses/MIT">![License](https://img.shields.io/badge/License-MIT-blue.svg)</a>
<a href="https://docs.lunar.dev/">![Documentation](https://img.shields.io/badge/docs-viewdocs-blue.svg?style=flat-square "Viewdocs")</a>
<a href="https://lunar.dev/">![Website](https://img.shields.io/badge/lunar.dev-website-purple.svg?style=flat-square "Website")</a>

</div>

# Welcome to Lunar.dev

**Lunar.dev** is an open-source platform for **managing, governing and optimizing** third-party API consumption across applications and AI agent workloads at scale.

## Additions in this fork

This fork of [TheLunarCompany/lunar](https://github.com/TheLunarCompany/lunar) adds MCPX features for local use and tool discovery:

- **Complete upstream tool discovery.** MCPX follows all pages of an upstream server's `tools/list` response, so tools beyond the first page are available in the gateway catalog.
- **On-demand tools through `/mcp/lazy`.** Clients see three tools: `mcpx_search_tools`, `mcpx_get_tool_schema`, and `mcpx_call_tool`. They can find a tool, fetch its schema, and execute it without loading the entire catalog into their context. Discovery and execution use the caller's current permissions and the existing gateway authentication, auditing, and metrics. The full `/mcp` and `/sse` endpoints remain available. See the [discovery guide and client configuration](mcpx/docs/lazy-tools.md).
- **Local semantic search.** Tool discovery combines keyword ranking with a bundled, quantized multilingual embedding model running locally on CPU. It requires no external inference service, persists tool embeddings in MCPX state, and falls back to keyword search if the embedding runtime is unavailable.
- **Local saved setups.** Standalone instances can save, list, overwrite, restore, and delete setups through the existing UI, with snapshots stored in `.mcpx/saved-setups`. Enterprise instances and instances authenticated to Hub continue using Hub storage. Saved Setup actions also show the API's error message when an operation fails.
- **Full local backups.** The Saved Setups page includes **Export Full Backup** for exporting app and server configuration, local saved setups, durable OAuth state, and available deployment and client configuration files. Exports default to `~/.config/mcpx/backups`, use private file permissions, and include a manifest of included and omitted sources. Docker deployments need host mounts for the destination and optional host files. See the [backup guide](mcpx/docs/local-saved-setups-and-export.md) and [Compose overlay](mcpx/examples/compose.local-export.yaml). Full backups are restored manually.
- **Fork Docker images and regression checks.** Changes to MCPX, the shared core, or the publishing workflow on `main` automatically run fork regression tests and publish a Linux ARM64 image to `ghcr.io/jfet97/mcpx`, tagged with `main` and the full commit SHA. Pull requests also check server and UI types, changed-file lint, regressions, and the UI build.

For local development, see the [MCPX README](mcpx/README.md). Docker builds use the repository root as their context: `docker build --target mcpx -f mcpx/Dockerfile .`.

<div  align="center">
<img src="readme-files/lunar-flow-light.svg#gh-light-mode-only" >
<img src="readme-files/lunar-flow-dark.svg#gh-dark-mode-only"  >
</div>

## Consumption Management for the AI Era

As AI agents and autonomous workflows increasingly rely on external APIs, there's a growing need for a mediation layer that acts as a central aggregation point between applications, agents, and the services they depend on.

Lunar.dev provides that layer—serving as a unified API Gateway for AI, delivering:

- **Live API Traffic Visibility:** Get real-time metrics on latency, errors, cost, and token usage across all outbound traffic, including LLM and agent calls.
- **AI-Aware Policy Enforcement:** Control tool access, throttle agent actions, and govern agentic traffic with fine-grained rules.
- **Advanced Traffic Shaping:** Apply rate limits, retries, priority queues, and circuit breakers to manage load and ensure reliability.
- **Cost & Performance Optimization:** Identify waste, smooth traffic peaks, and reduce overuse of costly APIs through smart gateway policies.
- **Centralized MCP Aggregation:** Streamline operations by consolidating multiple MCP servers into a single gateway, enhancing security, observability, and management.

## Choose Your Path

Lunar.dev is composed of two major components:

- [**Lunar Proxy**](https://github.com/TheLunarCompany/lunar/tree/main/proxy#readme) – our core API gateway and control layer
- [**Lunar MCPX**](https://github.com/TheLunarCompany/lunar/tree/main/mcpx#readme) – a zero-code aggregator for multiple MCP servers with unified API access

Explore the one that fits your needs—or use both for a full-stack solution.

## Open Source at the Core

This project was born out of the need for a more robust, production-ready approach to managing third-party APIs. It remains open-source at its core and free for non-production/personal use. For production environments, we offer advanced features through guided onboarding and platform tiers; [visit our website](https://lunar.dev) or reach out directly for more information
