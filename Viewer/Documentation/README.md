# Brainana Viewer v1.2.25

## Imported volume surface projection

Each imported anatomical, atlas, or functional volume can be projected from its displayed T1w-space copy onto the cortical surface. Anatomical and functional layers support ribbon-weighted mean, maximum, and signed maximum-absolute summaries. Atlas layers use the most frequent nonzero label across the cortical ribbon. One imported projection is active at a time, and its colormap, display range, opacity, and zero-background setting remain synchronized with the Imported panel.

A NiiVue-based viewer for Brainana outputs.

## Run

```bash
npm install
npm run dev -- --output-dir /path/to/brainana/output
```

Open the local URL printed by the server.

## Volume import

Use **Import** to browse `.nii` and `.nii.gz` files under the configured Brainana output directory. Imports can be declared as T1w, Scanner, or NMT2Sym space and as anatomical, atlas/labels, or functional/statistical data. Auto interpolation uses linear interpolation for anatomical and functional images and nearest-neighbor interpolation for atlas data. Scanner and NMT2Sym imports are resampled to the active monkey's T1w grid.

Imported layers are managed in the dedicated **Imported** panel, with visibility, opacity, colormap, threshold/range, ordering, rename, removal, and transformed-copy download controls.

The NMT2Sym import route requires Brainana's reverse `from-NMT2Sym_to-T1w_mode-image_xfm.nii.gz` displacement field.

## Surface marker modes

The Morphology panel includes a Yellow marker selector. **3D crosshair position** displays the marker at the actual volume crosshair coordinate. **Nearest surface node** snaps only the yellow marker to the corresponding nearest vertex on the currently displayed surface while leaving the volume crosshair unchanged.

## Dynamic surface orientation

The surface viewport includes a live R/L, A/P, and S/I anatomical orientation triad. It follows the active NiiVue camera rotation and remains independent of pan and zoom.

## Startup reliability

The dynamic surface-orientation loop now starts only after viewer bootstrap completes and cannot interrupt monkey discovery during partial NiiVue initialization.

## Somatotopy

When a monkey has a file matching `atlas-somatotopy_space-T1w_*.nii.gz` in its T1w atlas folder, the Function panel exposes a Somatotopy section. Frame 0 is displayed as a linear 0–100 body-position map and frame 1 supplies the F-statistic threshold. Volume and surface visibility, opacity, and F threshold are independent of retinotopy.

## v1.2.16 interface changes

The bottom report row now gives more horizontal space to Anatomy and a more compact, responsive Visual field panel.

- Monkeys open with curvature and no atlas selected.
- Retinotopy and somatotopy can be projected together, with independent opacity and surface brightness.
- The Function report and Visual field neighborhood plot are separate bottom panels.

## v1.2.17 interface refinements

The bottom report row gives more horizontal space to Anatomy and less to Visual field. Functional subsection headings are more compact, while the visual-field graph uses heavier lines and larger point markers for better readability.

## v1.2.18

Refined bottom-panel proportions and visual-field graph legibility without changing retinotopy calculations.

## Launch lifecycle

On macOS, Brainana Viewer starts a detached, loopback-only local server, opens the system default browser, and then exits the launcher. A Terminal window is used only temporarily when interactive SSH authentication is required. Closing the browser does not leave a launcher Terminal window open. Reopening the app with the same local data root reopens the healthy matching session.
