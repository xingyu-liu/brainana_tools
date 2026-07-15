# Local-only workstation architecture

## Local mode

Browser → bundled local Node server → local Brainana files

## Workstation mode

Browser → bundled local Node server → macOS system SSH client → workstation files

No Viewer code is uploaded to or executed on the workstation.

The SSH connection is established by the launcher using the user's normal SSH configuration and authentication. The local server reuses the authenticated control connection for directory listings, file transfers, and output writes.

Remote source files are cached on demand under:

`~/Library/Caches/Brainana Viewer/2.2.2/<profile>/`

The cache is disposable. Cache entries are validated against remote size and modification time.

Workstation exports are streamed through SSH to a temporary remote file and renamed atomically after the transfer succeeds.

## 2.2.0 hardening

Profiles are stored in versioned JSON with atomic migration from the legacy TSV store. Version metadata is centralized in VERSION.json. Validation and release-content checks are executable gates.

## Detached macOS lifecycle (2.4.0)

The macOS launcher starts the bundled local server as a version-identified `launchd` job. The server binds only to `127.0.0.1`, requests an OS-assigned port, writes an atomic handshake containing its PID, port, version, build ID, and per-launch session token, and remains independent of the launcher and browser windows. The launcher verifies the authenticated health endpoint, records the active instance atomically, opens the default browser, and exits.

Local relaunches with the same data root reopen a healthy matching instance. Stale or mismatched instances are removed before replacement. Remote launches deliberately perform visible system-SSH authentication before replacing an earlier remote session. The browser exchanges the URL-fragment token for an HttpOnly, SameSite=Strict localhost cookie before application API calls.

## Cross-platform readiness in 2.4.0

The server now exposes a formal filesystem-adapter contract shared by local and SSH implementations. Platform-specific launch behavior remains isolated in the macOS launcher, while server, frontend, scientific logic, browser tests, and filesystem contracts remain platform-neutral. Linux and Windows packaging are not yet shipped, but CI definitions exercise shared source on all three operating systems.

The detached server exposes authenticated status and quit controls and supports an idle timeout. Restart remains launcher-managed so that each platform can preserve its native process-management model.
