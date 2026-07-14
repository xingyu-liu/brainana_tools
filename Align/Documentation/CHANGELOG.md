# Brainana Align changelog

## 0.16.26-docs.1

- Replaced per-release architecture, changelog, and validation Markdown files with one maintained document of each type.
- Removed the duplicated `Documentation-release/` tree.
- Consolidated browser-support policy into the current architecture and validation documents.
- Added an automated documentation-layout test that fails on version-stamped release documents, duplicate documentation trees, or missing maintained documents.
- Updated package manifests and release verification requirements for the consolidated documentation model.
- No application, scientific, SSH, local-mode, remote-mode, or export behavior changed.

## 0.16.25-local-start.1

- Local mode now opens directly without a startup MRI/CT folder chooser.

# Brainana Align 0.16.24-ssh.1

## SSH reliability correction

- Removed the explicit OpenSSH `-f` option from the interactive persistent-master command.
- The Terminal helper now uses the command form verified successfully on the affected macOS/OpenSSH 10.2 system: `ssh -M -S <socket> -o ControlPersist=600 -o ExitOnForwardFailure=yes -NT <target>`.
- OpenSSH may background the control master through `ControlPersist` only after authentication succeeds.
- The launcher continues to require a successful `ssh -O check` before starting the application server.
- Failed and timed-out SSH helper directories are retained and their paths are reported for diagnosis.
- Added a regression test that rejects any generated helper containing `-fNT`.
- Browser-matrix functionality from 0.16.23-browser-matrix.1 is retained unchanged.

# Brainana Align 0.16.21-lifecycle.6

## Fixed
- Replaced the unreliable AppleScript `do script` SSH helper launch with an executable `.command` helper opened by macOS LaunchServices in Terminal.
- Added a positive startup acknowledgement so the launcher distinguishes “Terminal accepted the open request” from “the helper actually ran.”
- Added explicit user-facing errors when Terminal does not launch or execute the helper.
- Corrected the successful-SSH race by waiting for the persistent control socket to become ready after SSH returns success.
- Preserved clean cancellation behavior for Control-C, Terminal-tab closure, HUP, INT, and TERM.

## Packaging
- Restored the complete application documentation set, release manifest, build metadata, and checksums to the macOS package.
- Added package-content validation so required release files cannot be silently omitted.

## 0.16.22-lifecycle.7
- Fixed nounset-safe generation of the Terminal SSH authentication helper.
