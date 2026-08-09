import { invoke } from '@tauri-apps/api/core'
import { Maximize2, Minus, Square } from 'lucide-react'
import type { MouseEvent } from 'react'
import sofloMark from '../../src-tauri/icons/128x128.png'

export function TitleBar() {
  const minimize = () => void invoke('minimize_window')
  const maximize = () => void invoke('toggle_maximize_window')
  const close = () => window.dispatchEvent(new Event('soflo:request-close'))
  const beginDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button === 0) void invoke('start_window_dragging')
  }
  return <header className="titlebar">
    <div className="titlebar-drag-region" onMouseDown={beginDrag} onDoubleClick={maximize}><div className="titlebar-brand"><img className="brand-mark" src={sofloMark} alt="" /><span>SoFlo</span></div></div>
    <div className="window-controls">
      <button onMouseDown={(event) => event.stopPropagation()} onClick={minimize} aria-label="Minimize"><Minus size={15} strokeWidth={1.8} /></button>
      <button onMouseDown={(event) => event.stopPropagation()} onClick={maximize} aria-label="Maximize or restore"><Maximize2 className="maximize-icon" size={13} strokeWidth={1.8} /><Square className="restore-icon" size={12} strokeWidth={1.8} /></button>
      <button className="window-close" onMouseDown={(event) => event.stopPropagation()} onClick={close} aria-label="Close"><span>×</span></button>
    </div>
  </header>
}
