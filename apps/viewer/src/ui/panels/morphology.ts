// Docked "morphology" picker (top of the side panel): choose the surface shading metric (curvature /
// sulcal depth / thickness / none) and the curvature style (binary FreeSurfer vs continuous gray)
// from dropdowns. Color controls (colormap, display range, clip, legend) live in the shared "Color
// display" section at the bottom of the side panel. The yellow-marker mode moved to the toolbar's
// Marker / Crosshair section.
import { h, selectField, type SelectOption } from '@brainana/ui/dom.ts'
import type { MorphologyDisplayMetric, CurvatureStyle } from '../../niivue/multiView.ts'

// Marker placement mode (used by the toolbar Marker / Crosshair section + the dashboard).
export type MarkerMode = 'crosshair3d' | 'nearestNode'

export interface MorphologyPanelCallbacks {
  onDisplay: (m: MorphologyDisplayMetric) => void
  onCurvatureStyle: (s: CurvatureStyle) => void
}

export interface MorphologyPanel {
  element: HTMLElement
}

// Restored shading state carried across a monkey switch, so the pickers reflect the preserved
// metric/style instead of resetting to curvature · binary.
export interface MorphologyPanelInitial {
  metric?: MorphologyDisplayMetric
  style?: CurvatureStyle
}

export function createMorphologyPanel(cb: MorphologyPanelCallbacks, initial: MorphologyPanelInitial = {}): MorphologyPanel {
  const metricOptions: SelectOption[] = [
    { value: 'curvature', label: 'curvature' },
    { value: 'sulc', label: 'sulcal depth' },
    { value: 'thickness', label: 'thickness' },
    { value: 'none', label: 'none' },
  ]
  const styleField = { element: null as unknown as HTMLElement }

  const metricPicker = selectField('display', metricOptions, (value) => {
    styleField.element.hidden = value !== 'curvature'
    cb.onDisplay(value as MorphologyDisplayMetric)
  })

  const stylePicker = selectField('curvature style', [
    { value: 'binary', label: 'binary' },
    { value: 'continuous', label: 'continuous' },
  ], (value) => cb.onCurvatureStyle(value as CurvatureStyle))
  styleField.element = stylePicker.element

  const element = h('div', { class: 'side-panel', hidden: true }, [
    h('div', { class: 'side-panel-head' }, ['morphology']),
    metricPicker.element,
    stylePicker.element,
  ])

  // Initial active states (curvature · binary by default; overridden by a restored snapshot).
  const metric = initial.metric ?? 'curvature'
  const style = initial.style ?? 'binary'
  metricPicker.setValue(metric)
  stylePicker.setValue(style)
  styleField.element.hidden = metric !== 'curvature'

  return {
    element,
  }
}
