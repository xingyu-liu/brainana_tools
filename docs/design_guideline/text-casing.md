# Text casing — UI label convention

_Status: decided & applied (2026-07-16). Applies to `apps/viewer` and any brainana tool that
shares its UI conventions._

## The rule

**UI labels are lowercase.** Every control label, button, dropdown option, tab, section header, and
field label is written lowercase — e.g. `map`, `opacity`, `surface brightness`, `monkey`, `size`,
`mode`, `dataset`, `reset`, `add local dataset`, `polar angle`, `viridis`.

## Exceptions (kept as written)

1. **Acronyms & initialisms** — `LH`, `RH`, `AP/SI/LR`, `D99`, `ARM1`–`ARM6`, `SSH/SFTP`, `HSV`,
   `BWR`, `RdBu`, `RdYlBu`, `L/R`, `3D`, and the statistical `F` in `F-stat`. Keep their casing.
2. **Proper product name** — `Brainana Viewer` (the brand). Not a label — leave it.
3. **Full-sentence prose is NOT a label** — help text, empty/error/status messages, and descriptive
   tooltips (e.g. "Surface on top, planes in a row", "No datasets yet.") stay normal sentence case.
   Lowercasing whole sentences reads as broken text.
4. **Info bottom panel** — its readout `dl` labels and the coordinate editor (`X (mm)`, `hemi`, …)
   are the deliberate lowercase/instrument style and are left as-is. Its column `h3`s
   (`Coordinates`, `Atlas`, `Surface`, `Func Map`, `Visual field`) are Title Case in source and
   CSS-uppercased like the other sub-headers.

## Notable specifics

- **Colormap display names are lowercased** — `viridis`, `plasma`, `turbo`, `gray`, `blue–red`,
  etc. — even though they're technically proper names. Their acronym variants stay (`BWR`, `RdBu`,
  `RdYlBu`, `HSV`). Source: [data/colormap.ts](../../apps/viewer/src/data/colormap.ts) (`label`
  fields + `prettifyLabel()`, which now lower-cases unknown maps instead of title-casing).
- **Section headers rendered ALL CAPS by CSS** (`.side-panel-head`, `.color-display-head`,
  `.info-col h3`, `.cmap-group`, …) — their `text-transform: uppercase` is a separate presentation
  layer and is unchanged. The lowercase source just feeds it; the header role still reads uppercase.
- **Colormap group names** (`Sequential`, `Diverging`, …) are `ColormapGroup` *type* values / keys,
  not display strings — left as-is (they're CSS-uppercased in the picker anyway).

## Where labels live

Labels are the string literals passed to `h()`, `field()` / `selectField()` (packages/ui/dom.ts),
and `createSlider()`. When adding a new control, write its label lowercase and apply the exceptions
above. A label that doubles as an internal key (e.g. a functional mode `label` feeding `choiceKey()`
in panels/function.ts) must stay internally consistent — relabel both sides together, or key off a
stable id.
