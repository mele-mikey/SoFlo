import { Check, CircleAlert, Download } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import sofloMark from '../../src-tauri/icons/128x128.png'
import { ServerTitleBar } from './components/ServerTitleBar'

type SetupState = 'welcome' | 'installing' | 'ready' | 'error'
type VersionInfo = { currentVersion: string; targetVersion: string }

function compareVersions(left: string, right: string) {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference) return difference > 0 ? 1 : -1
  }
  return 0
}

export function ServerInstallerApp() {
  const [state, setState] = useState<SetupState>('welcome')
  const [error, setError] = useState('')
  const [version, setVersion] = useState<VersionInfo>({ currentVersion: '', targetVersion: '' })
  const [versionLoaded, setVersionLoaded] = useState(false)

  useEffect(() => {
    void invoke<VersionInfo>('server_installer_version_info').then(setVersion).catch(() => undefined).finally(() => setVersionLoaded(true))
  }, [])

  const installedVersionComparison = version.currentVersion && version.targetVersion ? compareVersions(version.currentVersion, version.targetVersion) : -1
  const installationBlocked = versionLoaded && Boolean(version.currentVersion) && installedVersionComparison >= 0
  const install = async () => {
    if (!versionLoaded || installationBlocked) return
    setError(''); setState('installing')
    try { await invoke('run_server_installer_worker'); setState('ready') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'SoFlo Server could not finish installing. Please try again.'); setState('error') }
  }
  const openServer = async () => {
    try { await invoke('launch_installed_server_and_close') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'SoFlo Server could not open after installation.'); setState('error') }
  }

  return <div className="server-installer-app">
    <ServerTitleBar />
    <main className="server-installer-main">
      <div className="server-installer-glow one" /><div className="server-installer-glow two" />
      <section className="server-installer-card" aria-live="polite">
        {state === 'welcome' && <>
          <img className="server-installer-mark" src={sofloMark} alt="SoFlo" />
          {installationBlocked ? <>
            <p className="server-installer-eyebrow">{installedVersionComparison === 0 ? 'SOFLO SERVER IS UP TO DATE' : 'DOWNGRADE BLOCKED'}</p>
            <h1>{installedVersionComparison === 0 ? <>You already have<br />this version.</> : <>A newer version<br />is already installed.</>}</h1>
            <p className="server-installer-copy">SoFlo Server v{version.currentVersion} is installed, while this setup is v{version.targetVersion}. To protect your configuration and models, only newer versions can install.</p>
            <button className="server-installer-secondary" onClick={() => void invoke('server_close_window')}>Close setup</button>
          </> : <>
            <p className="server-installer-eyebrow">{version.currentVersion ? 'SOFLO SERVER UPDATE' : 'SOFLO SERVER FOR WINDOWS'}</p>
            <h1>{version.currentVersion ? <>Ready to update<br />your AI server.</> : <>Your AI, ready<br />at home.</>}</h1>
            <p className="server-installer-copy">{version.currentVersion ? <>This upgrades SoFlo Server from v{version.currentVersion} to v{version.targetVersion || 'the latest version'} and keeps its model, pairing, and Cloudflare setup.</> : 'Run General AI on this PC and keep it available to your paired SoFlo laptop.'}</p>
            <button className="server-installer-primary" disabled={!versionLoaded} onClick={() => void install()}><Download size={17} /> {versionLoaded ? version.currentVersion ? `Upgrade to v${version.targetVersion || 'latest'}` : 'Install SoFlo Server' : 'Checking version...'}</button>
            <p className="server-installer-note">Installs just for this Windows account. Your screen can sleep; Windows itself must stay awake.</p>
          </>}
        </>}
        {state === 'installing' && <>
          <div className="server-installer-spinner"><i /></div><p className="server-installer-eyebrow">SETTING UP SOFLO SERVER</p>
          <h1>Preparing your<br />private AI server.</h1><p className="server-installer-copy">SoFlo Server is being installed for this Windows account. The model is chosen after setup.</p>
          <div className="server-installer-progress"><i /></div><p className="server-installer-note">Keep this window open while installation finishes.</p>
        </>}
        {state === 'ready' && <>
          <div className="server-installer-ready"><Check size={28} strokeWidth={2.4} /></div><p className="server-installer-eyebrow">YOU'RE ALL SET</p>
          <h1>Your server is ready<br />when you are.</h1><p className="server-installer-copy">Open SoFlo Server to download a model, finish its Cloudflare setup, and pair your laptop once.</p>
          <button className="server-installer-primary" onClick={() => void openServer()}>Open SoFlo Server <span>→</span></button><p className="server-installer-note">Created by Mikey M. · © 2026</p>
        </>}
        {state === 'error' && <>
          <div className="server-installer-error"><CircleAlert size={28} /></div><p className="server-installer-eyebrow">SETUP NEEDS ANOTHER TRY</p>
          <h1>That didn't quite<br />finish.</h1><p className="server-installer-copy">{error}</p>
          <button className="server-installer-primary" onClick={() => void install()}>Try again <span>→</span></button><button className="server-installer-secondary" onClick={() => void invoke('server_close_window')}>Close setup</button>
        </>}
      </section>
    </main>
  </div>
}
