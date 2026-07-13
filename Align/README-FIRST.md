# Brainana Align 0.16.0-parity.13

Open **Brainana Align.app**. The application is fully self-contained and uses the macOS default browser. No Node, npm, Python, Homebrew, NVM, Conda, or other installation is required.

This release replaces the per-panel optimization-window event patches with one shared window layer and one shared drawing implementation used by all six MRI and CT panels. A missing window in any plane is unrestricted for that plane. Only defined windows constrain automatic refinement.
