# Brainana Align architecture

## Shared application core

The frontend, scientific alignment logic, session model, export construction, local server, SFTP transport, and automated tests are shared across platforms. Platform-specific code is restricted to launchers, folder selection, browser opening, process lifecycle, runtime selection, and package assembly.

The intended repository model is one shared source tree with platform directories for macOS, Linux, and Windows. Linux and Windows packaging are not yet complete releases.

## macOS runtime

The macOS application bundles Apple Silicon and Intel Node executables. The launcher selects the runtime from physical hardware architecture, starts a loopback-only server, waits for a secure launch handshake, and opens the authenticated browser URL.

Local mode opens without a startup data-folder chooser. MRI and CT files are selected with the dedicated browser controls. The user's home directory is supplied internally as the server-side filesystem containment boundary. Export destination selection occurs when an export is requested.

Remote mode uses a saved workstation profile and remote root. The launcher establishes an interactive system-SSH control connection in Terminal, verifies it with `ssh -O check`, then the local server performs structured remote filesystem operations through SFTP. No server or Node runtime is installed on the workstation.

## Storage and security

The server binds only to loopback. Each launch uses an unpredictable session credential and a fresh port handshake. Filesystem operations are contained beneath the configured root, validate paths, and use temporary-file and replacement procedures intended to avoid partial output. Remote filesystem requests use structured SFTP messages rather than shell command construction.

## Browser compatibility

Safari, Firefox, Chrome, and Edge are first-class targets. Core behavior must not require Chromium-only APIs. Folder APIs are optional enhancements; ordinary file inputs, browser downloads, and server-side export remain supported fallbacks.

Automated CI is designed to run the production bundle through Playwright Chromium, Firefox, and WebKit. Native certification additionally requires real Safari on macOS, Firefox on macOS and Linux, Chrome across supported systems, and Edge on Windows because WebGL drivers, file dialogs, privacy prompts, and graphics acceleration cannot be fully represented by engine automation.

## Documentation and release model

Documentation is maintained as a small current-state set. `CHANGELOG.md` is the single running historical record. New releases update the existing architecture and validation documents instead of creating version-stamped copies. Git history and release archives provide deeper historical snapshots.
