# Building Brainana Viewer 2.0.0

Requirements: Node.js 20 or newer and npm.

```bash
npm ci
npm test
npm run build
./scripts/package-macos.sh
```

The source tree is authoritative. The macOS app contains only the built `dist/`, `server.mjs`, version metadata, and the launcher.
