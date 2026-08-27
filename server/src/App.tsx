import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { Check, CircleAlert, Cloud, Copy, Download, KeyRound, LoaderCircle, Play, Power, RefreshCw, Server, ShieldCheck, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ServerTitleBar } from './components/ServerTitleBar'

type ServerConfig = { modelPath: string; publicEndpoint: string; cloudflareTunnelToken: string; cloudflaredPath: string; startWithWindows: boolean; autoStart: boolean; checkForUpdates: boolean }
type ServerStatus = { gatewayPort: number; gatewayRunning: boolean; modelRunning: boolean; cloudflareRunning: boolean; cloudflaredAvailable: boolean; pairingConfigured: boolean; statusText: string }
type UpdateInfo = { version: string; downloadUrl: string }
type UpdateDownloadProgress = { downloadedBytes: number; totalBytes: number | null; percent: number | null; attempt: number; message: string }
type ModelProgress = { modelId: string; downloadedBytes: number; totalBytes: number | null; percent: number | null; message: string }
type Hardware = { cpuName: string; totalMemoryGb: number; availableMemoryGb: number; gpus: { name: string; vramGb: number }[] }
type Model = { id: string; title: string; summary: string; parameters: string; downloadGb: number; expectedRamGb: number; expectedVramGb: number; downloaded: boolean; localPath: string; recommended: boolean; recommendation: string }
type ModelCatalog = { hardware: Hardware; models: Model[] }

const endpointClean = (value: string) => value.trim().replace(/\/+$/, '')
const giga = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(1)} GB`

export function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [pairingKey, setPairingKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'start' | 'stop' | 'pair' | null>(null)
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null)
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null)
  const [message, setMessage] = useState('Loading server configuration...')
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null)
  const updateCheckStarted = useRef(false)

  const refresh = async () => {
    try {
      const [nextConfig, nextStatus, nextCatalog] = await Promise.all([invoke<ServerConfig>('get_server_config'), invoke<ServerStatus>('get_server_status'), invoke<ModelCatalog>('get_server_model_catalog')])
      setConfig(nextConfig); setStatus(nextStatus); setCatalog(nextCatalog); setMessage(nextStatus.statusText)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not load its configuration.') }
  }
  const refreshStatus = async () => {
    try { const nextStatus = await invoke<ServerStatus>('get_server_status'); setStatus(nextStatus); setMessage(nextStatus.statusText) }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not read its status.') }
  }

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refreshStatus(), 6_000); return () => window.clearInterval(timer) }, [])
  useEffect(() => {
    let removeUpdate: (() => void) | undefined; let removeModel: (() => void) | undefined
    void listen<UpdateDownloadProgress>('server-update-download-progress', (event) => setUpdateProgress(event.payload)).then((dispose) => { removeUpdate = dispose })
    void listen<ModelProgress>('server-model-download-progress', (event) => setModelProgress(event.payload)).then((dispose) => { removeModel = dispose })
    return () => { removeUpdate?.(); removeModel?.() }
  }, [])
  useEffect(() => {
    if (!config?.checkForUpdates || updateCheckStarted.current) return
    updateCheckStarted.current = true
    void invoke<UpdateInfo | null>('check_for_server_update').then((next) => { if (next) setAvailableUpdate(next) }).catch(() => undefined)
  }, [config?.checkForUpdates])

  const update = <K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) => setConfig((current) => current ? { ...current, [key]: value } : current)
  const persist = async (current: ServerConfig) => invoke<ServerConfig>('save_server_config', { config: { ...current, publicEndpoint: endpointClean(current.publicEndpoint) } })
  const save = async () => { if (!config) return; setBusy('save'); try { const next = await persist(config); setConfig(next); setMessage('Server setup saved.') } catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not save this setup.') } finally { setBusy(null) } }
  const choose = async (key: 'modelPath' | 'cloudflaredPath', filters: { name: string; extensions: string[] }[]) => { const picked = await open({ multiple: false, directory: false, filters }); if (typeof picked === 'string') update(key, picked) }
  const generatePairingKey = async () => { setBusy('pair'); try { const key = await invoke<string>('generate_pairing_key'); setPairingKey(key); setMessage('New pairing key created. Copy it into SoFlo on your laptop once.'); await refresh() } catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not create a pairing key.') } finally { setBusy(null) } }
  const copyPairingKey = async () => { await navigator.clipboard.writeText(pairingKey); setMessage('Pairing key copied. It is stored on your laptop after you paste it into SoFlo Settings.') }
  const selectModel = async (modelPath: string) => { if (!config) return; const next = await persist({ ...config, modelPath }); setConfig(next); setMessage('Active model selected. Start the server when you are ready.') }
  const downloadModel = async (model: Model) => {
    if (!config || downloadingModelId) return
    if (model.downloaded) { await selectModel(model.localPath); return }
    setDownloadingModelId(model.id); setModelProgress(null)
    try { const modelPath = await invoke<string>('download_server_model', { modelId: model.id }); await selectModel(modelPath); await refresh() }
    catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not download that model.') }
    finally { setDownloadingModelId(null) }
  }
  const start = async () => { if (!config) return; setBusy('start'); try { const next = await persist(config); setConfig(next); await invoke('start_server'); await refresh() } catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not start.') } finally { setBusy(null) } }
  const stop = async () => { setBusy('stop'); try { await invoke('stop_server'); await refresh() } catch (error) { setMessage(error instanceof Error ? error.message : 'SoFlo Server could not stop.') } finally { setBusy(null) } }
  const downloadUpdate = async () => { if (!availableUpdate) return; setDownloadingUpdate(true); setUpdateProgress(null); try { await invoke('download_and_launch_server_update', { version: availableUpdate.version, downloadUrl: availableUpdate.downloadUrl }) } catch (error) { setDownloadingUpdate(false); setMessage(error instanceof Error ? error.message : 'SoFlo Server could not download that update.') } }

  if (!config) return <div className="server-app"><ServerTitleBar /><main className="server-shell loading"><LoaderCircle className="spin" size={30} /><p>{message}</p></main></div>
  const running = Boolean(status?.modelRunning && (!config.cloudflareTunnelToken.trim() || status.cloudflareRunning))
  const hardware = catalog?.hardware
  const hardwareSummary = hardware ? `${hardware.totalMemoryGb} GB RAM · ${hardware.gpus.length ? hardware.gpus.map((gpu) => `${gpu.name} (${gpu.vramGb} GB)`).join(', ') : 'no supported GPU detected'}` : 'Detecting this PC…'
  return <div className="server-app"><ServerTitleBar /><main className="server-shell">
    <header className="hero"><div><p className="eyebrow">SOFLO SERVER</p><h1>Your private AI, on your hardware.</h1><p>General AI runs on this PC. Cloudflare carries encrypted requests to it; only a paired SoFlo app can use it.</p></div><div className={running ? 'status live' : 'status'}><i />{running ? 'Online' : 'Not running'}</div></header>
    <section className="card model-catalog"><div className="section-title"><Server size={19} /><div><h2>1. Choose the AI model</h2><p>Download one of these general models directly, or use a GGUF you already have. Estimates include practical working headroom; long contexts and multiple requests need more.</p></div></div><div className="hardware-line"><ShieldCheck size={16} /><strong>This PC:</strong> {hardwareSummary}</div><div className="model-grid">{catalog?.models.map((model) => { const active = config.modelPath === model.localPath; const downloading = downloadingModelId === model.id; const progress = downloading && modelProgress?.modelId === model.id ? modelProgress : null; return <article className={`model-option ${active ? 'active' : ''}`} key={model.id}><div className="model-option-top"><div><strong>{model.title}</strong><span>{model.parameters} · {model.downloadGb.toFixed(1)} GB download</span><span>≈{model.expectedRamGb} GB RAM · ≈{model.expectedVramGb} GB GPU</span></div><span className={model.recommended ? 'fit recommended' : 'fit'}>{model.recommended ? <Check size={13} /> : <CircleAlert size={13} />}{model.recommended ? 'Recommended' : 'Heavy'}</span></div><p>{model.summary}</p><small>{model.recommendation}</small>{progress && <div className="model-download"><div><i style={{ width: `${progress.percent ?? 7}%` }} /></div><span>{progress.percent !== null && progress.percent !== undefined ? `${progress.percent}% · ` : ''}{progress.downloadedBytes ? `${giga(progress.downloadedBytes)} downloaded` : progress.message}</span></div>}<button className={`button ${active ? 'soft' : 'primary'}`} disabled={Boolean(downloadingModelId && !downloading)} onClick={() => void downloadModel(model)}>{downloading ? <LoaderCircle className="spin" size={15} /> : model.downloaded ? <Check size={15} /> : <Download size={15} />}{downloading ? 'Downloading…' : active ? 'Active model' : model.downloaded ? 'Use downloaded model' : 'Download model'}</button></article> })}</div><div className="field-row manual-model"><label>Active GGUF model<input value={config.modelPath} onChange={(event) => update('modelPath', event.target.value)} placeholder="Choose a .gguf model file" /></label><button className="button soft" onClick={() => void choose('modelPath', [{ name: 'GGUF model', extensions: ['gguf'] }])}>Browse</button></div></section>
    <section className="card"><div className="section-title"><Cloud size={19} /><div><h2>2. Connect your Cloudflare Tunnel</h2><p>Paste the hostname and tunnel token Cloudflare gives this PC. The gateway stays local; Cloudflare is the only public route.</p></div></div><div className="field-grid"><label>Public HTTPS endpoint<input value={config.publicEndpoint} onChange={(event) => update('publicEndpoint', event.target.value)} placeholder="https://ai.example.com" /></label><label>Cloudflare Tunnel token<input type="password" value={config.cloudflareTunnelToken} onChange={(event) => update('cloudflareTunnelToken', event.target.value)} placeholder="eyJh..." /></label></div><div className="field-row"><label>cloudflared.exe (optional if it is already bundled)<input value={config.cloudflaredPath} onChange={(event) => update('cloudflaredPath', event.target.value)} placeholder="Bundled cloudflared.exe is used by default" /></label><button className="button soft" onClick={() => void choose('cloudflaredPath', [{ name: 'cloudflared executable', extensions: ['exe'] }])}>Browse</button></div><p className={status?.cloudflaredAvailable ? 'availability ok' : 'availability'}>{status?.cloudflaredAvailable ? 'cloudflared is available.' : 'cloudflared is unavailable until the bundled runtime or chosen executable can be found.'}</p></section>
    <section className="card"><div className="section-title"><KeyRound size={19} /><div><h2>3. Pair this Server once</h2><p>Generate a private key, then paste it into the online-AI area in SoFlo on your laptop. It is stored only as a hash here.</p></div></div><div className="pairing"><button className="button soft" disabled={busy === 'pair'} onClick={() => void generatePairingKey()}>{busy === 'pair' ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{status?.pairingConfigured ? 'Replace pairing key' : 'Generate pairing key'}</button>{pairingKey && <><code>{pairingKey}</code><button className="button soft" onClick={() => void copyPairingKey()}><Copy size={15} />Copy</button></>}</div></section>
    <section className="card compact"><div className="section-title"><Power size={19} /><div><h2>Keep the server available</h2><p>The tray keeps it running when the window closes. Monitors can turn off normally; Windows sleep or hibernation pauses the server.</p></div></div><label className="toggle-row"><input type="checkbox" checked={config.startWithWindows} onChange={(event) => update('startWithWindows', event.target.checked)} />Start SoFlo Server when I sign in to Windows</label><label className="toggle-row"><input type="checkbox" checked={config.autoStart} onChange={(event) => update('autoStart', event.target.checked)} />Start the selected model automatically</label><label className="toggle-row"><input type="checkbox" checked={config.checkForUpdates} onChange={(event) => update('checkForUpdates', event.target.checked)} />Check for Server updates when the dashboard opens</label><div className="actions"><div><strong>{message}</strong><span>Local gateway: http://127.0.0.1:{status?.gatewayPort ?? 8321}</span></div><button className="button soft" disabled={busy === 'save'} onClick={() => void save()}><RefreshCw className={busy === 'save' ? 'spin' : ''} size={15} />Save setup</button>{running ? <button className="button danger" disabled={busy === 'stop'} onClick={() => void stop()}><Power size={15} />Stop server</button> : <button className="button primary" disabled={busy === 'start'} onClick={() => void start()}>{busy === 'start' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}Start server</button>}</div></section>
    {availableUpdate && <div className="update-backdrop"><section className="update-dialog"><header><div><p className="eyebrow">SERVER UPDATE</p><h2>SoFlo Server v{availableUpdate.version} is ready.</h2></div><button className="update-close" disabled={downloadingUpdate} onClick={() => setAvailableUpdate(null)}><X size={18} /></button></header><p>The installer downloads with resume support, verifies it is a Windows executable, and only then restarts SoFlo Server.</p>{downloadingUpdate && <div className="update-progress"><strong>{updateProgress?.message ?? 'Starting update download…'}</strong><div><i style={{ width: `${updateProgress?.percent ?? 7}%` }} /></div><span>{updateProgress?.downloadedBytes ? `${(updateProgress.downloadedBytes / 1_048_576).toFixed(1)} MB downloaded` : 'Keep SoFlo Server open while this finishes.'}</span></div>}<footer><button className="button soft" disabled={downloadingUpdate} onClick={() => setAvailableUpdate(null)}>Not now</button><button className="button primary" disabled={downloadingUpdate} onClick={() => void downloadUpdate()}><Download size={16} />{downloadingUpdate ? updateProgress?.percent !== null && updateProgress?.percent !== undefined ? `Downloading ${updateProgress.percent}%` : 'Downloading…' : 'Download and restart'}</button></footer></section></div>}
  </main></div>
}
