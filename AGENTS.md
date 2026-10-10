# Development and deployment

- Use the canonical checkout at `~/Developer/lunar-jfet97` on `main` for this fork unless a different branch or checkout is explicitly requested.
- Integrate completed changes into `main`; do not leave deployed fixes only in temporary worktrees or scratch folders.
- Build deployment images from a clean, committed `main`, with the commit SHA recorded in the image revision label.
- Preserve existing local work, gateway configuration, OAuth state, and container volumes during integration and deployment.
- Remove temporary scratch worktrees after their changes are integrated and verified.
