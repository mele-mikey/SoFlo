import { Check, CircleAlert, Download, LockKeyhole, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import sofloMark from '../../../src-tauri/icons/128x128.png'
import { TitleBar } from '../../components/TitleBar'
import { api } from '../../lib/api'
import './installer.css'

type SetupState = 'welcome' | 'installing' | 'ready' | 'error'

export function InstallerApp() {
  const [state, setState] = useState<SetupState>('welcome')
  const [error, setError] = useState('')

  useEffect(() => {
    const close = () => void invoke('close_window')
    window.addEventListener('soflo:request-close', close)
    return () => window.removeEventListener('soflo:request-close', close)
  }, [])

  const install = async () => {
    setError('')
    setState('installing')
    try {
      await api.runInstallerWorker()
      setState('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'SoFlo could not finish installing. Please try again.')
      setState('error')
    }
  }

  const openSoflo = async () => {
    try {
      await api.launchInstalledSofloAndClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'SoFlo could not open after installation.')
      setState('error')
    }
  }

  return <div className="installer-app">
    <TitleBar />
    <main className="installer-main">
      <div className="installer-glow installer-glow-one" /><div className="installer-glow installer-glow-two" />
      <section className="installer-card" aria-live="polite">
        {state === 'welcome' && <>
          <img className="installer-mark" src={sofloMark} alt="SoFlo" />
          <p className="installer-eyebrow">SOFLO FOR WINDOWS</p>
          <h1>A quieter place<br />for the work ahead.</h1>
          <p className="installer-copy">Your papers, lectures, flashcards, and private study history stay together on this PC—without an account.</p>
          <div className="installer-points"><span><LockKeyhole size={15} /> Your library stays local</span><span><Sparkles size={15} /> AI stays optional</span></div>
          <button className="installer-primary" onClick={() => void install()}><Download size={17} /> Install SoFlo</button>
          <p className="installer-note">Installs just for this Windows account. No administrator access needed.</p>
        </>}

        {state === 'installing' && <>
          <div className="installer-spinner" aria-hidden="true"><i /></div>
          <p className="installer-eyebrow">SETTING UP SOFLO</p>
          <h1>Making room for<br />your study life.</h1>
          <p className="installer-copy">SoFlo is being installed privately for this Windows account. This usually takes only a moment.</p>
          <div className="installer-progress"><i /></div>
          <p className="installer-note">Keep this window open while installation finishes.</p>
        </>}

        {state === 'ready' && <>
          <div className="installer-ready"><Check size={28} strokeWidth={2.4} /></div>
          <p className="installer-eyebrow">YOU’RE ALL SET</p>
          <h1>Your space is ready<br />when you are.</h1>
          <p className="installer-copy">Open SoFlo to choose your name, your theme, and how you want to protect your private library.</p>
          <button className="installer-primary" onClick={() => void openSoflo()}>Open SoFlo <span>→</span></button>
          <p className="installer-note">Created by Mikey M. · © 2026</p>
        </>}

        {state === 'error' && <>
          <div className="installer-error"><CircleAlert size={28} /></div>
          <p className="installer-eyebrow">SETUP NEEDS ANOTHER TRY</p>
          <h1>That didn’t quite<br />finish.</h1>
          <p className="installer-copy">{error}</p>
          <button className="installer-primary" onClick={() => void install()}>Try again <span>→</span></button>
          <button className="installer-secondary" onClick={() => void invoke('close_window')}>Close setup</button>
        </>}
      </section>
    </main>
  </div>
}
