# AART Pack Library

The public discovery surface for reusable AART Blocks and Workflows.

It is deliberately separate from the local governance dashboard:

- npm carries versioned `aart-pack-*` bytes;
- `/aart-pack-index.json` serves the canonical discovery and trust metadata;
- this site gives people category, search, Pack-detail, provenance, and
  install surfaces over that index;
- CLI and MCP consume the same index contract.

The checked-in `data/aart-pack-index.json` is `mode: "preview"` and contains
representative fixtures for product development. It must not be presented as
a list of packages already published to npm.

```bash
npm run dev
npm test
```

Deployment is intentionally not configured yet. A Sites `project_id`,
production index URL, and public domain should be added only when their
external creation is explicitly authorized.
