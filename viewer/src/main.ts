// App bootstrap. Gate on WebGL2 (hard requirement), then mount the single-screen dashboard.
import { detectCapabilities, isSupported } from '../../core/client/browserCapabilities.ts'
import { RuntimeClient } from '../../core/client/runtimeClient.ts'
import { SourceManager } from '../../core/client/sourceManager.ts'
import { FilesystemClient } from '../../core/client/filesystemClient.ts'
import { mountDashboard } from './ui/dashboard.ts'
import './style.css'

function showUnsupported(root: HTMLElement, messages: string[]): void {
  root.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'gate'
  const heading = document.createElement('h1')
  heading.textContent = 'Browser not supported'
  box.appendChild(heading)
  for (const m of messages) {
    const p = document.createElement('p')
    p.textContent = m
    box.appendChild(p)
  }
  root.appendChild(box)
}

function main(): void {
  const root = document.querySelector<HTMLElement>('#app')
  if (!root) return

  const caps = detectCapabilities()
  if (!isSupported(caps)) {
    showUnsupported(root, caps.messages)
    return
  }

  const client = new RuntimeClient()
  const sources = new SourceManager(client)
  const files = new FilesystemClient(client)
  mountDashboard(root, { client, sources, files })
}

main()
