import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { CheckCircle2, Cloud, Copy, ExternalLink, KeyRound, LoaderCircle, Play, Power, RefreshCw, Server, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'

type ServerConfig = {
  modelPath: string
  publicEndpoint: string
  cloudflareTunnelToken: string
  cloudflaredPath: string
  startWithWindows: boolean
  autoStart: boolean
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

const endpointClean = (value: string) => value.trim().replace(/\/+$/, '')

export function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [pairingKey, setPairingKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'start' | 'stop' | 'pair' | null>(null)
  const [message, setMessage] = useState('Loading server configuration…')

  const refresh = async () => {
    try {
      const [nextConfig, nextStatus] = await Promise.all([invoke<ServerConfig>('get_server_config'), invoke<ServerStatus>('get_server_status')])
      setConfig(nextConfig); setStatus(nextStatus); setMessage(nextStatus.statusText)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not load its configuration.') }
  }

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 6_000); return () => window.clearInterval(timer) }, [])
  const update = <K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) => setConfig((current) => current ? { ...current, [key]: value } : current)
  const save = async () => {
    if (!config) return
    setBusy('save')
    try { const next = await invoke<ServerConfig>('save_server_config', { config: { ...config, publicEndpoint: endpointClean(config.publicEndpoint) } }); setConfig(next); setMessage('Server setup saved.') }
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
    try { await save(); await invoke('start_server'); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not start.') }
    finally { setBusy(null) }
  }
  const stop = async () => {
    setBusy('stop')
    try { await invoke('stop_server'); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not stop.') }
    finally { setBusy(null) }
  }

  if (!config) return <main className="server-shell loading"><LoaderCircle className="spin" size={30} /><p>{message}</p></main>
  const running = Boolean(status?.modelRunning && (!config.cloudflareTunnelToken.trim() || status.cloudflareRunning))
  return <main className="server-shell">
    <header className="hero"><div><p className="eyebrow">SOFLO SERVER</p><h1>Your private AI, on your hardware.</h1><p>General AI runs on this PC. Cloudflare carries encrypted requests to it; only a paired SoFlo app can use it.</p></div><div className={running ? 'status live' : 'status'}><i />{running ? 'Online' : 'Not running'}</div></header>

    <section className="card"><div className="section-title"><Server size={19} /><div><h2>1. Choose the AI model</h2><p>One active General AI model is served at a time. The model remains loaded while the server is running, so there is no warm-up between requests.</p></div></div><div className="field-row"><label>Active GGUF model<input value={config.modelPath} onChange={(event) => update('modelPath', event.target.value)} placeholder="Choose a .gguf model file" /></label><button className="button soft" onClick={() => void choose('modelPath', [{ name: 'GGUF model', extensions: ['gguf'] }])}>Browse</button></div></section>

    <section className="card"><div className="section-title"><Cloud size={19} /><div><h2>2. Cloudflare Tunnel</h2><p>In Cloudflare, create a remotely-managed Tunnel, add a published application for your hostname, and set its service URL to <code>http://localhost:{status?.gatewayPort ?? 8321}</code>. Then paste its run token here.</p></div></div><div className="field-grid"><label>Public HTTPS endpoint<input value={config.publicEndpoint} inputMode="url" onChange={(event) => update('publicEndpoint', event.target.value)} placeholder="https://ai.mikeymele.com" /></label><label>Cloudflare Tunnel token<input value={config.cloudflareTunnelToken} type="password" autoComplete="off" onChange={(event) => update('cloudflareTunnelToken', event.target.value)} placeholder="eyJ… from Cloudflare" /></label></div><div className="field-row"><label>cloudflared.exe path<input value={config.cloudflaredPath} onChange={(event) => update('cloudflaredPath', event.target.value)} placeholder="Detected from PATH when left blank" /></label><button className="button soft" onClick={() => void choose('cloudflaredPath', [{ name: 'cloudflared', extensions: ['exe'] }])}>Browse</button></div><p className={status?.cloudflaredAvailable ? 'availability ok' : 'availability'}>{status?.cloudflaredAvailable ? 'cloudflared is available.' : 'cloudflared has not been found yet. Install it from Cloudflare or choose cloudflared.exe above.'}</p></section>

    <section className="card"><div className="section-title"><KeyRound size={19} /><div><h2>3. Pair your laptop once</h2><p>This is not your Cloudflare token. Generate it once, paste it into SoFlo → Settings → Use online AI, and it reconnects automatically from then on. Generating another key revokes the old one.</p></div></div><div className="pairing"><button className="button primary" disabled={busy !== null} onClick={() => void generatePairingKey()}>{busy === 'pair' ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{status?.pairingConfigured ? 'Rotate pairing key' : 'Generate pairing key'}</button>{pairingKey && <><code>{pairingKey}</code><button className="button soft" onClick={() => void copyPairingKey()}><Copy size={16} /> Copy</button></>}</div></section>

    <section className="card compact"><div className="section-title"><ShieldCheck size={19} /><div><h2>Keep it available</h2><p>Closing this dashboard hides it to the tray; the gateway, model, and Cloudflare connector keep running. Windows sleep still pauses all software, so keep this PC awake on AC.</p></div></div><label className="toggle-row"><input type="checkbox" checked={config.startWithWindows} onChange={(event) => update('startWithWindows', event.target.checked)} /><span>Start SoFlo Server when I sign in to Windows</span></label><label className="toggle-row"><input type="checkbox" checked={config.autoStart} onChange={(event) => update('autoStart', event.target.checked)} /><span>Load the model and Cloudflare Tunnel automatically</span></label></section>

    <footer className="actions"><div><strong>{message}</strong><span>Gateway: 127.0.0.1:{status?.gatewayPort ?? 8321} · Cloudflare route only · Bearer-paired</span></div><button className="button soft" disabled={busy !== null} onClick={() => void save()}><RefreshCw size={16} />{busy === 'save' ? 'Saving…' : 'Save setup'}</button>{running ? <button className="button danger" disabled={busy !== null} onClick={() => void stop()}><Power size={16} /> Stop server</button> : <button className="button primary" disabled={busy !== null} onClick={() => void start()}><Play size={16} /> Start server</button>}</footer>
    <a className="docs" href="https://developers.cloudflare.com/tunnel/setup/" target="_blank" rel="noreferrer"><ExternalLink size={15} /> Cloudflare Tunnel setup guide</a>
  </main>
}
