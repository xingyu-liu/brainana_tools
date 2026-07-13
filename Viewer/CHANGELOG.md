# Brainana Viewer v1.2.25

- Added direct dragging of the yellow surface marker.
- A drag beginning on the marker performs depth picking on the displayed cortical mesh and continuously updates the linked T1w volume crosshair.
- Surface drags that begin away from the marker continue to rotate the surface normally.
- Display-only surfaces map the selected vertex back to the corresponding pial/T1w coordinate.
- The existing 3D crosshair and nearest-surface-node marker modes are preserved.

# Changelog

## v1.2.25

- Made the bottom Function report title scroll with Retinotopy and Somatotopy content, matching the Anatomy and Surface panels.
- Added a Yellow marker mode control in Morphology with 3D crosshair position and Nearest surface node options.
- Nearest surface node changes only the yellow marker position and leaves the volume crosshair unchanged.

## v1.2.23

- Replaced the hard-coded somatotopy F-threshold slider range with the actual finite range of frame 1 in the active monkey's somatotopy NIfTI.
- Refreshes the range whenever somatotopy is loaded or reselected.
- Clamps the current threshold into the detected range and derives an appropriate slider step.


## v1.2.22

- Retinotopy F-threshold sliders now use the actual finite minimum and maximum of the selected threshold-map frame.
- Slider bounds update when switching between Polar-angle F and Eccentricity F.
- The active threshold is clamped into the newly selected map range and the slider step adapts to that range.
- Corrected the somatotopy surface color direction so 0 is blue and 100 is red, matching the volume display and legend.
- Retinotopy calculations, projection geometry, ROI transforms, and import transforms are unchanged.

## v1.2.21

- Enlarged the visual-field plot by relaxing conservative responsive size caps.
- Preserved the label-aware canvas margins that keep Left and Right fully visible.
- Did not change retinotopy sampling, neighborhood selection, plotting coordinates, or statistics.

# Brainana Viewer v1.2.20

## v1.2.20

- Prevented the visual-field Right label from being clipped at responsive panel widths.
- The plot radius is now calculated from the measured Left and Right label widths and the actual canvas width.
- Added a small adaptive center offset so both side labels retain comparable margins.
- Retinotopy sampling, thresholds, plotted values, and ellipse calculations are unchanged.

# Brainana Viewer v1.2.19

## v1.2.19

- Enlarged visual-field direction and eccentricity labels.
- Added more plot margin so Left and Right labels remain fully visible.
- Preserved retinotopy sampling and neighborhood calculations.

# Brainana Viewer v1.2.18

## v1.2.18

- Rebalanced Anatomy and Visual field panel widths.
- Kept Visual field title and neighborhood controls on one line.
- Restored main panel title prominence.
- Reduced only Retinotopy and Somatotopy subsection headings.
- Increased visual-field axes, rings, ellipse, markers, and label sizes for legibility.

# Brainana Viewer v1.2.17

## v1.2.17

- Widened the Anatomy report panel and narrowed the Visual field panel.
- Reduced Retinotopy and Somatotopy subsection heading sizes.
- Increased visual-field grid, axis, ellipse, and connector line weights.
- Increased neighborhood, median, and crosshair marker sizes.
- Retinotopy calculations and data selection are unchanged.

# Brainana Viewer v1.2.16

## v1.2.16

- Increased the width allocated to the bottom Anatomy panel.
- Reduced the width allocated to the Visual field panel.
- Reduced the maximum responsive visual-field plot size so it remains balanced inside the narrower panel.
- Preserved the Function and Visual field panel separation, scrolling, retinotopy calculations, and surface behavior from v1.2.15.

## v1.2.15

- Split the bottom Function report and Visual field plot into separate panels.
- Added independently scrollable retinotopy and somatotopy value reporting.
- Added independent surface-brightness controls for retinotopy and somatotopy.
- Retinotopy and somatotopy can now remain visible on the surface simultaneously.
- Added a top-layer selector for overlapping functional surface maps.
- Monkeys now load with no atlas selected by default.
- Existing volume colors, transforms, ROI export, imports, and functional sampling are unchanged.
