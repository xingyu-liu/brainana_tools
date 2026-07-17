# Demo dataset — `sub-example`

A small, bundled `brainana` derivatives tree so you can launch the Viewer against real data
without preprocessing your own subject. It is a **trimmed** copy of one macaque subject:
only the files the Viewer actually reads are kept (FastSurfer intermediates, the
`label/stats/…` directories, and the regenerable render cache are omitted), so it renders
identically to a full run at a fraction of the size.

## Run it

From the repo root:

```sh
npm run server -- --port 5174 --output-dir datasets/demo_viewer   # Terminal 1: API + demo data
npm run dev:web                                                   # Terminal 2: Vite UI → http://localhost:5173
```

Or launch the app unbound (`npm start` / `npm run dev:desktop`) and add this folder in-app
via the local-source picker.

## What's inside

```
sub-example/ses-001/anat/atlas_space-fsnative/
    atlas-*_space-fsnative_*.nii.gz              atlas label + retinotopy/somatotopy volumes
    atlas-*_space-fsnative_hemi-{L,R}_*.func.gii  surface overlays
    atlas-*.tsv                                  region LUTs
    *.json  *.bib  *.md                          sidecars (provenance; not read by the Viewer)
fastsurfer/sub-example/
    mri/norm.mgz        required default base volume (fsnative)
    mri/T1.mgz          optional selectable base
    surf/{lh,rh}.*      pial, white, smoothwm, inflated, sphere + curv/sulc/thickness morphometry
```

This matches the layout documented in [`docs/data-contract.md`](../../docs/data-contract.md).

## Note on the cache

On first open the Viewer writes derived assets (inflated/sphere surfaces, `.shape.gii`
morphometry) into `datasets/demo_viewer/.brainana-viewer-cache/`. That directory is
`.gitignore`d and regenerates automatically, so it never dirties the working tree.
