# Data contract: brainana outputs the Viewer reads

The Viewer is a **consumer** of a brainana derivatives tree. A local or remote `DataSource` serves
per-subject files, and the Viewer's manifest builder (`apps/viewer/server/manifest.mjs`) discovers
the on-disk layout and hands the browser a per-subject manifest of URLs. This page documents which
outputs each Viewer feature needs, and the space-selection rule for overlays.

Only a small subset of a brainana run is consumed. Everything not listed here (JSON/`.bib`/`.md`
sidecars, QC `figures/`, the `func/` BOLD series, `nextflow_reports/`, most FreeSurfer
intermediates) is ignored.

> **Concrete example.** [`datasets/demo_viewer/`](../datasets/demo_viewer/) is a committed,
> minimal real instance of this contract — the `sub-example` subject trimmed to exactly the
> files below (intermediates and the regenerable cache omitted). Use it to see the layout in
> practice or to launch the Viewer without your own data.

## Expected layout

```
<root>/
  sub-<id>/                              subject dir; name MUST start "sub-"
    anat/         OR  sub-<id>/ses-<n>/anat/     (flat OR BIDS session — both handled)
      <prefix>_space-T1w_desc-preproc_T1w[_brain].nii.gz    base anatomy
      <prefix>_from-*_to-*_mode-image_xfm.{nii.gz,mat}      transforms (see note)
      atlas_space-fsnative/   atlas_space-T1w/   atlas_space-scanner/
  fastsurfer/sub-<id>[_ses-<n>]/
    surf/          FreeSurfer surfaces + morphometry
    mri/*.mgz      selectable base volumes
```

A directory is treated as a subject only when its name starts `sub-` **and** an `anat/` directory is
found (flat, or under the first `ses-*`). The gate checks only that the directory **exists**, not its
contents — so any subject with an `anat/` (e.g. one holding `atlas_space-fsnative/`) is listed, and a
subject without a resolvable `anat/` is not.

## Feature → required (R) / optional (O) inputs

| Feature | Inputs |
|---|---|
| **Anatomical view** (slice base) | **R** at least one base volume. The default base is `fastsurfer/<sub>/mri/norm.mgz` (fsnative — same space as the surfaces); any `mri/*.mgz` is selectable. **O** the preprocessed T1w adds a "T1w (preproc)" option — first of `space-T1w_desc-preproc_T1w_brain.nii.gz` → `…_T1w.nii.gz` → `desc-preproc_T1w.nii.gz` → `desc-preproc_brain.nii.gz` → `space-scanner_T1w.nii.gz` — and becomes the base only when no `mri/*.mgz` exists. |
| **Cortical surfaces** | **R** `surf/{lh,rh}.pial` (prefers `.pial.surf.gii`). **O** `white`, `smoothwm`; server-derived `inflated`, `sphere`. |
| **Morphology shading** | **O** `surf/{lh,rh}.{curv,sulc,thickness}` (rendered via server-generated `.shape.gii`). |
| **Atlas overlay** | **R** per atlas: a volume `atlas-<name>_space-<space>_*.nii.gz`. Integer volumes are categorical parcellations; float scalar volumes (e.g. `CortHierarchy`) are rendered as a continuous colormap, not ROI labels. **O** `atlas-<name>.tsv` LUT (region names for report/legend, plus an optional `color` column — hex `#RRGGBB` or an RGB triple — honored over the procedural golden-angle color; without a LUT the atlas still renders with derived-ID colors). **O** surface pair `atlas-<name>_space-fsnative_hemi-{L,R}*.func.gii`. |
| **Retinotopy / somatotopy** | **R** 4-D map `atlas-retinotopy_space-<space>_*.nii.gz` (frames polar/polarF/eccentricity/eccentricityF) and `atlas-somatotopy_space-<space>_*.nii.gz` (frames phase/fstat). **O** the matching fsnative surface pair. Drives the functional report, F-threshold masking, and the visual-field plot. |

Atlas names in the macaque pipeline: `ARM1`…`ARM6`, `D99`, `MacBNA`, `CortHierarchy` (continuous
scalar), `FuncNetwork`, plus the functional `retinotopy`/`somatotopy`. Discovery is generic — any
`atlas-<name>_space-*` volume is picked up — and atlases are ordered `ARM<n>` first (numeric), then
alphabetical.

## Overlay space-selection rule

The default slice base is the FreeSurfer conformed volume `norm.mgz`, which is in **fsnative**
space — the same space as the surfaces. Atlas and functional **volume** overlays are therefore
sourced to match that space so they are voxel-aligned to the base and need no resampling.

- The Viewer picks **one** atlas space directory per subject, in priority order
  **`atlas_space-fsnative` → `atlas_space-T1w` → `atlas_space-scanner`** (the first that contains an
  atlas label volume).
- **All** volume-side assets — the atlas label volume, its `.tsv` LUT, and the retinotopy /
  somatotopy functional volumes — come from that single chosen directory. There is no per-file
  fallback to another space: if the chosen directory lacks a `.tsv`, the atlas simply renders with
  derived-ID colors, exactly as when a LUT is absent.
- The atlas **surface** overlay is the one exception: surface `func.gii` data exists only in
  fsnative space, so it is always read from `atlas_space-fsnative`, independent of which space the
  volume was chosen from (and is absent when that directory is not present).

Because brainana emits atlases uniformly across all three spaces, current runs resolve to
`atlas_space-fsnative` and the overlays render without any transform. Older runs that predate the
fsnative backprojection fall back to `atlas_space-T1w` (then `atlas_space-scanner`) with identical
behavior to before.

> **Note — transforms.** The manifest still exposes a `transforms` block (scanner / template /
> NMT2Sym warps discovered from `*_mode-image_xfm.*`). It is retained for future imported-volume
> projection / ROI work and is not needed by the display path above.

## Minimal viewable subject

Two separate thresholds:

- **To appear** in the subject list: a `sub-*/` with an `anat/` directory (contents irrelevant).
- **To render a base volume**: at least one volume — normally `fastsurfer/<sub>/mri/norm.mgz`, else
  a preprocessed `*_T1w.nii.gz` in `anat/`.

In practice a subject with **`fastsurfer/` (surf + `mri/norm.mgz`) and `anat/atlas_space-fsnative/`**
is fully viewable — base volume, cortical surfaces, atlas overlays, and (if present) the retino/somato
maps — with **no** preprocessed `*_T1w.nii.gz` required. The T1w preproc only adds the "T1w (preproc)"
base-volume option. Everything beyond that first volume is additive.
