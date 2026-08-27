import { invoke } from '@tauri-apps/api/core'
import { Maximize2, Minus, Square, X } from 'lucide-react'
import type { MouseEvent } from 'react'
import sofloMark from '../../../src-tauri/icons/128x128.png'

export function ServerTitleBar() {
  const beginDrag = (event: MouseEvent<HTMLElement>) => {
    if (event.button === 0) void invoke('server_start_window_dragging')
  }

  return <header className="server-titlebar">
    <div className="server-drag-region" onMouseDown={beginDrag} onDoubleClick={() => void invoke('server_toggle_maximize_window')}>
      <div className="server-titlebar-brand"><img src={sofloMark} alt="" /><span>SoFlo Server</span></div>
    </div>
    <div className="server-window-controls">
      <button aria-label="Minimize" onClick={() => void invoke('server_minimize_window')}><Minus size={16} /></button>
      <button aria-label="Maximize or restore" onClick={() => void invoke('server_toggle_maximize_window')}><Maximize2 className="server-maximize" size={15} /><Square className="server-restore" size={14} /></button>
      <button className="server-close" aria-label="Close" onClick={() => void invoke('server_close_window')}><X size={16} /></button>
    </div>
  </header>
}
