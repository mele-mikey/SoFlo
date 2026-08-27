import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { Cloud, Copy, Download, ExternalLink, KeyRound, LoaderCircle, Play, Power, RefreshCw, Server, ShieldCheck, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type ServerConfig = {
  modelPath: string
  publicEndpoint: string
  cloudflareTunnelToken: string
  cloudflaredPath: string
  startWithWindows: boolean
  autoStart: boolean
  checkForUpdates: boolean
}

type ServerStatus = {
  gatewayPort: number
  gatewayRunning: boolean
  modelRunning: boolean
  cloudflareRunning: boolean
  cloudflaredAvailable: boolean
  pairingConfigured: boolean
  statusText: string
}

type UpdateInfo = { version: string; downloadUrl: string }
type UpdateDownloadProgress = { downloadedBytes: number; totalBytes: number | null; percent: number | null; attempt: number; message: string }

const endpointClean = (value: string) => value.trim().replace(/\/+$/, '')

export function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [pairingKey, setPairingKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'start' | 'stop' | 'pair' | null>(null)
  const [message, setMessage] = useState('Loading server configuration...')
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null)
  const updateCheckStarted = useRef(false)

  const refresh = async () => {
    try {
      const [nextConfig, nextStatus] = await Promise.all([invoke<ServerConfig>('get_server_config'), invoke<ServerStatus>('get_server_status')])
      setConfig(nextConfig); setStatus(nextStatus); setMessage(nextStatus.statusText)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not load its configuration.') }
  }
  const refreshStatus = async () => {
    try { const nextStatus = await invoke<ServerStatus>('get_server_status'); setStatus(nextStatus); setMessage(nextStatus.statusText) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not read its status.') }
  }

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refreshStatus(), 6_000); return () => window.clearInterval(timer) }, [])
  useEffect(() => { let unlisten: (() => void) | undefined; void listen<UpdateDownloadProgress>('server-update-download-progress', (event) => setUpdateProgress(event.payload)).then((dispose) => { unlisten = dispose }); return () => unlisten?.() }, [])
  useEffect(() => {
    if (!config?.checkForUpdates || updateCheckStarted.current) return
    updateCheckStarted.current = true
    void invoke<UpdateInfo | null>('check_for_server_update').then((next) => { if (next) setAvailableUpdate(next) }).catch(() => undefined)
  }, [config?.checkForUpdates])

  const update = <K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) => setConfig((current) => current ? { ...current, [key]: value } : current)
  const persist = async (current: ServerConfig) => invoke<ServerConfig>('save_server_config', { config: { ...current, publicEndpoint: endpointClean(current.publicEndpoint) } })
  const save = async () => {
    if (!config) return
    setBusy('save')
    try { const next = await persist(config); setConfig(next); setMessage('Server setup saved.') }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not save this setup.') }
    finally { setBusy(null) }
  }
  const choose = async (key: 'modelPath' | 'cloudflaredPath', filters: { name: string; extensions: string[] }[]) => {
    const picked = await open({ multiple: false, directory: false, filters })
    if (typeof picked === 'string') update(key, picked)
  }
  const generatePairingKey = async () => {
    setBusy('pair')
    try { const key = await invoke<string>('generate_pairing_key'); setPairingKey(key); setMessage('New pairing key created. Copy it into SoFlo on your laptop once.'); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not create a pairing key.') }
    finally { setBusy(null) }
  }
  const copyPairingKey = async () => { await navigator.clipboard.writeText(pairingKey); setMessage('Pairing key copied. It is stored on your laptop after you paste it into SoFlo Settings.') }
  const start = async () => {
    if (!config) return
    setBusy('start')
    try { const next = await persist(config); setConfig(next); await invoke('start_server'); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not start.') }
    finally { setBusy(null) }
  }
  const stop = async () => {
    setBusy('stop')
    try { await invoke('stop_server'); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not stop.') }
    finally { setBusy(null) }
  }
  const downloadUpdate = async () => {
    if (!availableUpdate) return
    setDownloadingUpdate(true); setUpdateProgress(null)
    try { await invoke('download_and_launch_server_update', { version: availableUpdate.version, downloadUrl: availableUpdate.downloadUrl }) }
    catch (error) { setDownloadingUpdate(false); setMessage(error instanceof Error ? error.message : 'SoFlo Server could not download that update.') }
  }

  if (!config) return <main className="server-shell loading"><LoaderCircle className="spin" size={30} /><p>{message}</p></main>
  const running = Boolean(status?.modelRunning && (!config.cloudflareTunnelToken.trim() || status.cloudflareRunning))
  return <main className="server-shell">
    <header className="hero"><div><p className="eyebrow">SOFLO SERVER</p><h1>Your private AI, on your hardware.</h1><p>General AI runs on this PC. Cloudflare carries encrypted requests to it; only a paired SoFlo app can use it.</p></div><div className={running ? 'status live' : 'status'}><i />{running ? 'Online' : 'Not running'}</div></header>

    <section className="card"><div className="section-title"><Server size={19} /><div><h2>1. Choose the AI model</h2><p>One active General AI model is served at a time. The model remains loaded while the server is running, so there is no warm-up between requests.</p></div></div><div className="field-row"><label>Active GGUF model<input value={config.modelPath} onChange={(event) => update('modelPath', event.target.value)} placeholder="Choose a .gguf model file" /></label><button className="button soft" onClick={() => void choose('modelPath', [{ name: 'GGUF model', extensions: ['gguf'] }])}>Browse</button></div></section>

    <section className="card"><div className="section-title"><Cloud size={19} /><div><h2>2. Cloudflare Tunnel</h2><p>In Cloudflare, create a remotely-managed Tunnel, add a published application for your hostname, and set its service URL to <code>http://localhost:{status?.gatewayPort ?? 8321}</code>. Then paste its run token here.</p></div></div><div className="field-grid"><label>Public HTTPS endpoint<input value={config.publicEndpoint} inputMode="url" onChange={(event) => update('publicEndpoint', event.target.value)} placeholder="https://ai.mikeymele.com" /></label><label>Cloudflare Tunnel token<input value={config.cloudflareTunnelToken} type="password" autoComplete="off" onChange={(event) => update('cloudflareTunnelToken', event.target.value)} placeholder="eyJ... from Cloudflare" /></label></div><div className="field-row"><label>cloudflared.exe path<input value={config.cloudflaredPath} onChange={(event) => update('cloudflaredPath', event.target.value)} placeholder="Detected from PATH when left blank" /></label><button className="button soft" onClick={() => void choose('cloudflaredPath', [{ name: 'cloudflared', extensions: ['exe'] }])}>Browse</button></div><p className={status?.cloudflaredAvailable ? 'availability ok' : 'availability'}>{status?.cloudflaredAvailable ? 'cloudflared is available.' : 'cloudflared has not been found yet. Install it from Cloudflare or choose cloudflared.exe above.'}</p></section>

    <section className="card"><div className="section-title"><KeyRound size={19} /><div><h2>3. Pair your laptop once</h2><p>This is not your Cloudflare token. Generate it once, paste it into SoFlo -&gt; Settings -&gt; Use online AI, and it reconnects automatically from then on. Generating another key revokes the old one.</p></div></div><div className="pairing"><button className="button primary" disabled={busy !== null} onClick={() => void generatePairingKey()}>{busy === 'pair' ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{status?.pairingConfigured ? 'Rotate pairing key' : 'Generate pairing key'}</button>{pairingKey && <><code>{pairingKey}</code><button className="button soft" onClick={() => void copyPairingKey()}><Copy size={16} /> Copy</button></>}</div></section>

    <section className="card compact"><div className="section-title"><ShieldCheck size={19} /><div><h2>Keep it available</h2><p>Closing this dashboard hides it to the tray; the gateway, model, and Cloudflare connector keep running. Windows sleep still pauses all software, so keep this PC awake on AC.</p></div></div><label className="toggle-row"><input type="checkbox" checked={config.startWithWindows} onChange={(event) => update('startWithWindows', event.target.checked)} /><span>Start SoFlo Server when I sign in to Windows</span></label><label className="toggle-row"><input type="checkbox" checked={config.autoStart} onChange={(event) => update('autoStart', event.target.checked)} /><span>Load the model and Cloudflare Tunnel automatically</span></label><label className="toggle-row"><input type="checkbox" checked={config.checkForUpdates} onChange={(event) => update('checkForUpdates', event.target.checked)} /><span>Check for Server updates when it opens</span></label></section>

    <footer className="actions"><div><strong>{message}</strong><span>Gateway: 127.0.0.1:{status?.gatewayPort ?? 8321} - Cloudflare route only - Bearer-paired</span></div><button className="button soft" disabled={busy !== null} onClick={() => void save()}><RefreshCw size={16} />{busy === 'save' ? 'Saving...' : 'Save setup'}</button>{running ? <button className="button danger" disabled={busy !== null} onClick={() => void stop()}><Power size={16} /> Stop server</button> : <button className="button primary" disabled={busy !== null} onClick={() => void start()}><Play size={16} /> Start server</button>}</footer>
    <a className="docs" href="https://developers.cloudflare.com/tunnel/setup/" target="_blank" rel="noreferrer"><ExternalLink size={15} /> Cloudflare Tunnel setup guide</a>
    {availableUpdate && <div className="update-backdrop" role="presentation"><section className="update-dialog" role="dialog" aria-modal="true" aria-label="SoFlo Server update available"><header><div><p className="eyebrow">SOFLO SERVER UPDATE</p><h2>Version {availableUpdate.version} is ready</h2></div><button className="update-close" disabled={downloadingUpdate} onClick={() => setAvailableUpdate(null)} aria-label="Close"><X size={17} /></button></header><p>SoFlo Server downloads the complete custom installer before restarting. Interrupted downloads resume when you try again.</p>{downloadingUpdate && <div className="update-progress"><strong>{updateProgress?.message ?? 'Preparing update...'}</strong><div><i style={{ width: `${updateProgress?.percent ?? 4}%` }} /></div><span>{updateProgress?.totalBytes ? `${updateProgress.percent ?? 0}% - ${(updateProgress.downloadedBytes / 1_048_576).toFixed(1)} MB of ${(updateProgress.totalBytes / 1_048_576).toFixed(1)} MB` : updateProgress?.downloadedBytes ? `${(updateProgress.downloadedBytes / 1_048_576).toFixed(1)} MB downloaded` : 'Keep SoFlo Server open while this finishes.'}</span></div>}<footer><button className="button soft" disabled={downloadingUpdate} onClick={() => setAvailableUpdate(null)}>Not now</button><button className="button primary" disabled={downloadingUpdate} onClick={() => void downloadUpdate()}><Download size={16} />{downloadingUpdate ? updateProgress?.percent !== null && updateProgress?.percent !== undefined ? `Downloading ${updateProgress.percent}%` : 'Downloading...' : 'Download and restart'}</button></footer></section></div>}
  </main>
}
