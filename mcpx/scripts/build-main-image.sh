#!/usr/bin/env bash
set -euo pipefail

checkout="${MCPX_SOURCE_CHECKOUT:-$HOME/Developer/lunar-jfet97}"
docker_context="${MCPX_DOCKER_CONTEXT:-desktop-linux}"
cd "$checkout"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Build the deployment image from main." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Commit all source changes before building the deployment image." >&2
  exit 1
fi

revision="$(git rev-parse HEAD)"
image="ghcr.io/jfet97/mcpx:$revision"
docker --context "$docker_context" build \
  --platform linux/arm64 \
  --target mcpx \
  --file mcpx/Dockerfile \
  --label org.opencontainers.image.source=https://github.com/jfet97/lunar \
  --label "org.opencontainers.image.revision=$revision" \
  --label org.opencontainers.image.ref.name=main \
  --tag "$image" \
  .
printf '%s\n' "$image"
