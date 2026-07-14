# Brainana Align documentation

Brainana Align is a self-contained browser-based MRI and CT alignment application. The current macOS package includes Apple Silicon and Intel Node runtimes, while the shared source contains the platform-neutral frontend, server, scientific code, tests, and platform packaging foundations.

## Documentation set

- `BUILD.md`: build and packaging instructions
- `CHANGELOG.md`: running release history, newest first
- `ARCHITECTURE.md`: current architecture and platform boundaries
- `FEATURE_PARITY.md`: feature reconstruction and parity status
- `VALIDATION.md`: current validation results and remaining native checks
- `TECHNICAL_FINDINGS.md`: reconstruction findings and design rationale

Browser support requirements for Safari, Firefox, Chrome, and Edge are incorporated into `ARCHITECTURE.md` and `VALIDATION.md`.

Release identity and file inventories are stored separately in `VERSION.json`, `RELEASE_CONTENTS.txt`, and `SHA256SUMS.txt`.
