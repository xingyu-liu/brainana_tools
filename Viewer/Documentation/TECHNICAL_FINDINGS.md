# Technical findings

## v1.2.22

The threshold slider had static 0–120 bounds even though the selected F-statistic frame can have a different range. The viewer now scans the selected 4D frame only, ignoring non-finite samples, and assigns its exact finite extrema to the slider.

The volume somatotopy LUT was already reversed, but the separately generated categorical surface LUT reused the eccentricity direction. Surface LUT sampling is now reversed only for somatotopy, yielding blue at 0 and red at 100.

# v1.2.20 technical note

The side-label clipping was caused by a fixed plot radius that did not reserve canvas space for the measured text width of the longer Right label. The renderer now measures both labels with the active canvas font and derives the maximum safe horizontal radius before drawing.

# Technical findings for v1.2.16

The previous bottom report combined numerical retinotopy and somatotopy values with the visual-field canvas. Adding somatotopy increased the report height and displaced the graph. v1.2.15 separated those responsibilities into independent grid panels. The Function panel owns scrollable text, while the Visual field panel owns the neighborhood selector, square canvas, and empty-state overlay.

Functional surface brightness is applied only to the categorical surface LUT. Values, thresholds, volume colors, projection results, and exported data are not modified. Brightness above 100% blends RGB channels toward white, which visibly brightens saturated primary colors even after mesh lighting.

Retinotopy and somatotopy are now appended as independent surface layers. Their insertion order is controlled by the Top layer selector. Neither visibility checkbox disables the other.

Atlas volume and surface visibility are reset to false whenever a monkey is loaded. Curvature remains the initial surface appearance.

The ROI transform module is byte-for-byte identical to v1.2.14.

## v1.2.16 layout refinement

The bottom information grid now allocates additional width to Anatomy and less width to Visual field at each responsive breakpoint. The plot remains square and height-limited, but its maximum size is reduced so it does not dominate the row. No retinotopy sampling, thresholding, or plotting calculations were changed.

## v1.2.17

This release changes only report-panel CSS and visual-field canvas drawing weights and marker radii. Retinotopy sampling, thresholding, neighborhood membership, covariance, and ellipse calculations are unchanged.

## v1.2.18

Refined bottom-panel proportions and visual-field graph legibility without changing retinotopy calculations.

## v1.2.25 Function scrolling and surface marker

The Function title previously remained sticky while the report body scrolled, allowing report rows to move underneath it. A final CSS override now makes the Function heading part of the same scrolling flow as its content.

The yellow marker now has two explicit coordinate modes. The 3D mode uses the selected T1w world coordinate directly. The nearest-node mode finds the nearest vertex on the pial reference, then uses that vertex index on the currently displayed surface geometry, preserving vertex correspondence across Pial, SmoothWM, Inflated, Very Inflated, and Sphere.

## Inflated and very-inflated surface source correction

The 2.2.0 server generated both display modes from `lh.inflated` and `rh.inflated`, applying a 13% radial expansion for the Very Inflated option. This could make the modes appear nearly identical and did not reflect subjects that contain actual `lh.veryinflated` and `rh.veryinflated` files. Version 2.2.2 treats the two surface pairs as independent inputs, removes synthetic radial scaling, and uses a new derived-cache version.

## Lifecycle finding

The earlier Viewer lifecycle made the browser tab responsible for server termination through EventSource and kept a launcher Terminal process alive. That coupling caused awkward relaunch behavior and browser-specific lifecycle risk. Version 2.4.0 adopts detached local server ownership and explicit active-instance state, while preserving local-only SSH workstation access.
