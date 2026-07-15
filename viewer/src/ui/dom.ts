// Minimal hyperscript helpers shared by the panels — declarative DOM without a framework.

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  const { class: className, ...rest } = props
  if (className) el.className = className
  Object.assign(el, rest)
  for (const child of children) el.append(child)
  return el
}

export function field(labelText: string, input: HTMLElement): HTMLLabelElement {
  return h('label', { class: 'field' }, [h('span', {}, [labelText]), input])
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
