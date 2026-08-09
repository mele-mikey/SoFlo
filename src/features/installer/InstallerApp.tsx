import { Check, CircleAlert, Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import sofloMark from '../../../src-tauri/icons/128x128.png'
import { TitleBar } from '../../components/TitleBar'
import { api } from '../../lib/api'
import './installer.css'

type SetupState = 'welcome' | 'installing' | 'ready' | 'error'

function compareVersions(left: string, right: string) {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference) return difference > 0 ? 1 : -1
  }
  return 0
}

export function InstallerApp() {
  const [state, setState] = useState<SetupState>('welcome')
  const [error, setError] = useState('')
  const [version, setVersion] = useState({ currentVersion: '', targetVersion: '' })
  const [versionLoaded, setVersionLoaded] = useState(false)

  useEffect(() => {
    const close = () => void invoke('close_window')
    window.addEventListener('soflo:request-close', close)
    return () => window.removeEventListener('soflo:request-close', close)
  }, [])
  useEffect(() => { void api.installerVersionInfo().then(setVersion).catch(() => undefined).finally(() => setVersionLoaded(true)) }, [])

  const installedVersionComparison = version.currentVersion && version.targetVersion ? compareVersions(version.currentVersion, version.targetVersion) : -1
  const installationBlocked = versionLoaded && Boolean(version.currentVersion) && installedVersionComparison >= 0

  const install = async () => {
    if (!versionLoaded || installationBlocked) return
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
          {installationBlocked ? <><p className="installer-eyebrow">{installedVersionComparison === 0 ? 'SOFLO IS UP TO DATE' : 'DOWNGRADE BLOCKED'}</p><h1>{installedVersionComparison === 0 ? <>You already have<br />this version.</> : <>A newer version<br />is already installed.</>}</h1><p className="installer-copy">SoFlo v{version.currentVersion} is installed, while this setup is v{version.targetVersion}. To protect your library and settings, SoFlo only installs newer versions.</p><button className="installer-secondary" onClick={() => void invoke('close_window')}>Close setup</button></> : <><p className="installer-eyebrow">{version.currentVersion ? 'SOFLO UPDATE' : 'SOFLO FOR WINDOWS'}</p><h1>{version.currentVersion ? <>Ready to update<br />your workspace.</> : <>A quieter place<br />for the work ahead.</>}</h1><p className="installer-copy">{version.currentVersion ? <>SoFlo v{version.currentVersion} is already installed. This will upgrade it to v{version.targetVersion || 'the latest version'} while keeping your library, settings, and local model in place.</> : 'Everything for class, from your first lecture to your final exam.'}</p><button className="installer-primary" disabled={!versionLoaded} onClick={() => void install()}><Download size={17} /> {versionLoaded ? version.currentVersion ? `Upgrade to v${version.targetVersion || 'latest'}` : 'Install SoFlo' : 'Checking version...'}</button><p className="installer-note">{version.currentVersion ? 'Your existing SoFlo data will not be changed.' : 'Installs just for this Windows account.'}</p></>}
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
