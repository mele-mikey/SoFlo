import { Check, CircleAlert, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import sofloMark from '../../../src-tauri/icons/128x128.png'
import { TitleBar } from '../../components/TitleBar'
import { api } from '../../lib/api'
import './installer.css'

type UninstallState = 'confirm' | 'removing' | 'complete' | 'error'

export function UninstallerApp() {
  const [state, setState] = useState<UninstallState>('confirm')
  const [eraseData, setEraseData] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const close = () => void invoke('close_window')
    window.addEventListener('soflo:request-close', close)
    return () => window.removeEventListener('soflo:request-close', close)
  }, [])

  const uninstall = async () => {
    setError('')
    setState('removing')
    try {
      await api.runUninstallerWorker(eraseData)
      setState('complete')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'SoFlo could not finish uninstalling.')
      setState('error')
    }
  }

  return <div className="installer-app">
    <TitleBar />
    <main className="installer-main">
      <div className="installer-glow installer-glow-one" /><div className="installer-glow installer-glow-two" />
      <section className="installer-card uninstaller-card" aria-live="polite">
        {state === 'confirm' && <>
          <img className="installer-mark" src={sofloMark} alt="SoFlo" />
          <p className="installer-eyebrow installer-danger-eyebrow">UNINSTALL SOFLO</p>
          <h1>Remove the app,<br />keep your work.</h1>
          <p className="installer-copy">Your SoFlo library, settings, and downloaded AI models stay on this PC unless you explicitly choose to remove them below.</p>
          <label className="installer-data-choice"><input type="checkbox" checked={eraseData} onChange={(event) => setEraseData(event.target.checked)} /><span><strong>Also erase my local SoFlo data</strong><small>Deletes your library, settings, and downloaded models permanently.</small></span></label>
          <div className="installer-actions"><button className="installer-secondary" onClick={() => void invoke('close_window')}>Keep SoFlo</button><button className="installer-danger" onClick={() => void uninstall()}><Trash2 size={16} /> Uninstall SoFlo</button></div>
        </>}
        {state === 'removing' && <>
          <div className="installer-spinner" aria-hidden="true"><i /></div><p className="installer-eyebrow installer-danger-eyebrow">REMOVING SOFLO</p><h1>Closing things out<br />carefully.</h1><p className="installer-copy">Your selection is being applied now. This only takes a moment.</p><div className="installer-progress"><i /></div>
        </>}
        {state === 'complete' && <>
          <div className="installer-ready"><Check size={28} strokeWidth={2.4} /></div><p className="installer-eyebrow">SOFLO REMOVED</p><h1>You’re all set.</h1><p className="installer-copy">{eraseData ? 'SoFlo and the local data you selected were removed from this PC.' : 'SoFlo was removed. Your local library is still safely on this PC if you return.'}</p><button className="installer-primary" onClick={() => void invoke('close_window')}>Close <span>→</span></button>
        </>}
        {state === 'error' && <>
          <div className="installer-error"><CircleAlert size={28} /></div><p className="installer-eyebrow installer-danger-eyebrow">UNINSTALL NEEDS ANOTHER TRY</p><h1>That didn’t quite<br />finish.</h1><p className="installer-copy">{error}</p><button className="installer-danger" onClick={() => void uninstall()}>Try again <span>→</span></button><button className="installer-secondary" onClick={() => void invoke('close_window')}>Close</button>
        </>}
      </section>
    </main>
  </div>
}
