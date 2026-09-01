import { AlertTriangle, Bot, Check, Database, Download, Info, KeyRound, LockKeyhole, Moon, Palette, ShieldAlert, ShieldCheck, SpellCheck2, Upload, X } from 'lucide-react'
import { open, save } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import { LocalModelManager } from './LocalModelManager'
import type { AppSettings, SecurityStatus } from '../../lib/types'

interface SettingsViewProps {
  settings: AppSettings
  dataLocation: string
  security: SecurityStatus | null
  wordAiModelReady: boolean
  voiceAiModelReady: boolean
  onModelsUpdated: () => void
  onSettingsChange: (settings: AppSettings) => void
  onSecurityChange: (security: SecurityStatus) => void
  onToast: (message: string, type?: 'success' | 'error') => void
  onStartWalkthrough: () => void
}

type BusyAction = 'export' | 'import' | 'wipe' | 'uninstall' | null

const MODEL_INFORMATION_URL = 'https://huggingface.co/Qwen/Qwen3-4B-GGUF'
const LEGACY_DEFAULT_AI_MODEL = 'qwen2.5-3b-instruct-q4_k_m.gguf'
const needsModelUpgrade = (path: string) => path.trim().toLocaleLowerCase().endsWith(LEGACY_DEFAULT_AI_MODEL)
const modelDownloadError = (error: unknown) => typeof error === 'string' && error.trim() ? error : error instanceof Error && error.message ? error.message : 'The local AI model could not be downloaded.'

export function SettingsView({ settings, dataLocation, security, wordAiModelReady, voiceAiModelReady, onModelsUpdated, onSettingsChange, onSecurityChange, onToast, onStartWalkthrough }: SettingsViewProps) {
  const [busy, setBusy] = useState<BusyAction>(null)
  const [clearTrashOpen, setClearTrashOpen] = useState(false)
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false)
  const [uninstallConfirmOpen, setUninstallConfirmOpen] = useState(false)
  const [deleteModelsOpen, setDeleteModelsOpen] = useState(false)
  const [downloadingModel, setDownloadingModel] = useState(false)
  const [securityDialog, setSecurityDialog] = useState<{ type: 'pin' | 'password'; remove: boolean } | null>(null)
  const [aiInfoOpen, setAiInfoOpen] = useState(false)
  const [modelManagerOpen, setModelManagerOpen] = useState(false)
  const modelUpgradeNeeded = needsModelUpgrade(settings.aiModelPath)
  const modelPackageUpdateNeeded = Boolean(settings.aiModelPath) && (!wordAiModelReady || !voiceAiModelReady)
  const modelUpdateNeeded = modelUpgradeNeeded || modelPackageUpdateNeeded
  const localModelsInstalled = Boolean(settings.aiModelPath) || wordAiModelReady || voiceAiModelReady

  const update = async (partial: Partial<AppSettings>) => {
    const next = { ...settings, ...partial, ...(partial.aiEnabled === false ? { aiGrammar: false, askForAiUse: false } : {}) }
    onSettingsChange(next)
    try {
      await api.updateSettings(next)
    } catch {
      onSettingsChange(settings)
      onToast('Settings could not be saved.', 'error')
    }
  }

  const exportData = async () => {
    try {
      const defaultPath = await api.defaultSofloExportPath()
      const target = await save({ title: 'Export SoFlo data', defaultPath, filters: [{ name: 'SoFlo data', extensions: ['soflo'] }] })
      if (!target) return
      setBusy('export')
      await api.exportSofloData(target)
      onToast('Your SoFlo data was exported successfully.')
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The data export could not be created.', 'error')
    } finally {
      setBusy(null)
    }
  }

  const importData = async () => {
    const source = await open({ title: 'Import SoFlo data', multiple: false, directory: false, filters: [{ name: 'SoFlo data', extensions: ['soflo'] }] })
    if (!source || Array.isArray(source)) return
    setBusy('import')
    try {
      // A successful import restarts the process. Protected exports then show LockView.
      await api.importSofloDataAndRestart(source)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'That file is not a valid SoFlo data export.', 'error')
      setBusy(null)
    }
  }

  const wipeData = async () => {
    setBusy('wipe')
    try {
      await api.wipeSofloDataAndRestart()
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'SoFlo could not wipe its local data.', 'error')
      setBusy(null)
    }
  }

  const uninstallApp = async () => {
    setBusy('uninstall')
    try {
      await api.launchUninstallerAndClose()
    } catch (error) {
      setBusy(null)
      onToast(error instanceof Error ? error.message : 'SoFlo could not open its uninstaller.', 'error')
    }
  }

  const downloadAiModel = async () => {
    setDownloadingModel(true)
    try {
      const models = await api.downloadDefaultAiModel()
      await update({ aiModelPath: models.generalPath, aiWritingModelPath: models.writingPath, aiVoiceModelPath: models.voicePath, aiGeneralModelTier: 'medium', aiWritingModelTier: 'medium', aiVoiceModelTier: 'medium' })
      onModelsUpdated()
    } catch (error) {
      onToast(modelDownloadError(error), 'error')
    } finally {
      setDownloadingModel(false)
    }
  }

  const deleteAiModels = async () => {
    try {
      await api.deleteLocalAiModels()
      onSettingsChange({ ...settings, aiModelPath: '', aiGrammar: false })
      onModelsUpdated()
      setDeleteModelsOpen(false)
      onToast('SoFlo local AI models were removed from this PC.')
    } catch (error) { onToast(error instanceof Error ? error.message : 'SoFlo could not remove its local AI models.', 'error') }
  }

  return <main className="settings-view content-view">
    <header className="view-intro"><p className="eyebrow">PREFERENCES</p><h1>Settings</h1><p>Thoughtful defaults, with just enough room to make SoFlo yours.</p></header>

    <section className="settings-section">
      <SectionHeading icon={<Moon size={18} />} title="Appearance" detail="SoFlo is intentionally dark and focused." />
      <SettingRow title="Reduced motion" detail="Limit non-essential movement throughout the interface."><Toggle checked={settings.reduceMotion} onChange={(reduceMotion) => void update({ reduceMotion })} /></SettingRow>
    </section>

    <section className="settings-section">
      <SectionHeading icon={<Info size={18} />} title="Personal" detail="Small details that make the workspace yours." />
      <SettingRow title="Your name" detail="Used in your home-screen greeting."><input className="settings-name-input" defaultValue={settings.userName} maxLength={48} onBlur={(event) => { const userName = event.target.value.trim(); if (userName !== settings.userName) void update({ userName }) }} placeholder="Your first name" aria-label="Your name" /></SettingRow>
      <div className="theme-setting"><div><h3><Palette size={15} /> Accent color</h3><p>Updates SoFlo's signature color everywhere.</p></div><ThemePicker value={settings.themeColor} onChange={(themeColor) => void update({ themeColor })} /></div>
    </section>

    <section className="settings-section">
      <SectionHeading icon={<SpellCheck2 size={18} />} title="Editor" detail="Google Docs-style paper defaults, with room to customize." />
      <SettingRow title="Spellcheck" detail="Use browser spelling checks as you write. With AI spellcheck on, SoFlo replaces the platform squiggle with its own interactive straight marks."><Toggle checked={settings.spellcheck} onChange={(spellcheck) => void update({ spellcheck })} /></SettingRow>
      <div className="reading-surface-setting"><div><h3>Reading surface</h3><p>Choose a page treatment that feels best for long study sessions.</p></div><ReadingSurfacePicker value={settings.editorCanvas} onChange={(editorCanvas) => void update({ editorCanvas })} /></div>
    </section>

    <section className="settings-section security-section">
      <SectionHeading icon={<ShieldCheck size={18} />} title="Security" detail={security?.configured ? 'Your library is encrypted at rest.' : 'Protect your entire library with encryption.'} />
      <div className="security-warning"><ShieldAlert size={16} /><p>If you forget every PIN and password you set, SoFlo cannot recover your encrypted papers, lectures, cards, or study history.</p></div>
      <SettingRow title="PIN" detail={security?.hasPin ? 'A PIN is required each time SoFlo opens.' : 'Use a 4- or 6-digit PIN for quick unlock.'}><button className="button button-soft button-small" onClick={() => setSecurityDialog({ type: 'pin', remove: false })}><KeyRound size={15} /> {security?.hasPin ? 'Change PIN' : 'Add PIN'}</button></SettingRow>
      {security?.hasPin && <SettingRow title="Remove PIN" detail="You will need your active credentials to confirm."><button className="button button-quiet button-small" onClick={() => setSecurityDialog({ type: 'pin', remove: true })}>Remove PIN</button></SettingRow>}
      <SettingRow title="Password" detail={security?.hasPassword ? 'A password is required each time SoFlo opens.' : 'Use a password for stronger protection.'}><button className="button button-soft button-small" onClick={() => setSecurityDialog({ type: 'password', remove: false })}><LockKeyhole size={15} /> {security?.hasPassword ? 'Change password' : 'Add password'}</button></SettingRow>
      {security?.hasPassword && <SettingRow title="Remove password" detail="You will need your active credentials to confirm."><button className="button button-quiet button-small" onClick={() => setSecurityDialog({ type: 'password', remove: true })}>Remove password</button></SettingRow>}
    </section>

    <section className="settings-section">
      <SectionHeading icon={<Database size={18} />} title="Library data" detail="Your papers and study history stay on this computer." />
      <SettingRow title="Data location" detail={dataLocation}><span className="location-badge">{security?.configured ? 'Encrypted' : 'Local SQLite'}</span></SettingRow>
      <SettingRow title="Clear trash" detail="Recently deleted papers and sets are removed after 30 days. Clear them permanently now."><button className="button button-quiet button-small" onClick={() => setClearTrashOpen(true)}>Clear trash</button></SettingRow>
      <SettingRow title="Guided Walkthrough" detail="Run the SoFlo introduction again without changing your library or preferences."><button className="button button-quiet button-small" onClick={onStartWalkthrough}>Start walkthrough</button></SettingRow>
    </section>

    <section className="settings-section ai-section">
      <SectionHeading icon={<Bot size={18} />} title="Artificial Intelligence" detail="Optional, private help for structuring imported documents." action={<button className="settings-info-button" onClick={() => setAiInfoOpen(true)} aria-label="About SoFlo AI"><Info size={15} /></button>} />
      <SettingRow title="Use AI" detail="When off, SoFlo hides AI actions and imports documents with the standard local converter."><Toggle checked={settings.aiEnabled} onChange={(aiEnabled) => void update({ aiEnabled })} /></SettingRow>
      <SettingRow title="Use online AI" detail="Send General AI work to your paired SoFlo Server through its HTTPS Cloudflare endpoint. Voice transcription stays local on this laptop."><Toggle checked={settings.aiEnabled && settings.onlineAiEnabled} disabled={!settings.aiEnabled} onChange={(onlineAiEnabled) => void update({ onlineAiEnabled })} /></SettingRow>
      {settings.aiEnabled && settings.onlineAiEnabled && <div className="online-ai-settings"><label>Server endpoint<input className="settings-name-input" defaultValue={settings.onlineAiEndpoint} inputMode="url" placeholder="https://ai.mikeymele.com" onBlur={(event) => { const onlineAiEndpoint = event.target.value.trim(); if (onlineAiEndpoint !== settings.onlineAiEndpoint) void update({ onlineAiEndpoint }) }} /></label><label>Device pairing key<input className="settings-name-input" defaultValue={settings.onlineAiAccessKey} type="password" autoComplete="off" placeholder="Paste the key generated by SoFlo Server" onBlur={(event) => { const onlineAiAccessKey = event.target.value.trim(); if (onlineAiAccessKey !== settings.onlineAiAccessKey) void update({ onlineAiAccessKey }) }} /></label><p>SoFlo sends this key with every request. It is not your Cloudflare tunnel token.</p></div>}
      <SettingRow title="AI spelling & grammar" detail="Use the selected General AI model for spelling, grammar, and deeper writing review. Enabled by default when AI is on."><Toggle checked={settings.aiEnabled && settings.aiGrammar} disabled={!settings.aiEnabled} onChange={(aiGrammar) => void update({ aiGrammar })} /></SettingRow>
      <SettingRow title="Ask for AI use" detail="Depending on the mode you select, SoFlo automatically loads that AI and keeps it active for the remainder of the app session."><Toggle checked={settings.aiEnabled && settings.askForAiUse} disabled={!settings.aiEnabled} onChange={(askForAiUse) => void update({ askForAiUse })} /></SettingRow>
      <SettingRow title={settings.onlineAiEnabled ? 'Server connection' : 'Local AI models'} detail={settings.onlineAiEnabled ? 'General AI uses your paired server. Keep a local Voice Transcription model only if you record lectures on this laptop.' : modelUpgradeNeeded ? "An earlier 3B default model is installed. Update SoFlo's AI package." : modelPackageUpdateNeeded ? "An AI model update is available: install the Voice Transcription companion." : localModelsInstalled ? "General AI and Voice Transcription are ready. Manage their performance level or remove downloaded files." : "Download SoFlo's General AI and Voice Transcription models now, or let the first AI action download them."}>{settings.onlineAiEnabled ? <span className="location-badge">HTTPS + paired</span> : <button className="button button-quiet button-small" disabled={downloadingModel} onClick={() => void (!localModelsInstalled || modelUpdateNeeded ? downloadAiModel() : setModelManagerOpen(true))}>{downloadingModel ? 'Downloading...' : modelUpdateNeeded ? 'Update models' : localModelsInstalled ? 'Manage models' : 'Download models'}</button>}</SettingRow>
      {settings.aiEnabled && !settings.onlineAiEnabled && (!settings.aiModelPath || modelUpdateNeeded) && <p className="ai-model-note">{modelPackageUpdateNeeded && !modelUpgradeNeeded ? 'The Writing AI and Voice Transcription companions are ready to add to your current setup.' : 'The General AI, Writing AI, and Voice Transcription models are not on this PC yet. Download them here, or wait until the first AI action.'}</p>}
    </section>

    <section className="settings-section about-section">
      <SectionHeading icon={<Info size={18} />} title="About SoFlo" detail="Version 1.1.44" />
      <SettingRow title="Update notifications" detail="Check GitHub Releases when SoFlo opens. This is the only automatic network request SoFlo makes."><Toggle checked={settings.checkForUpdates} onChange={(checkForUpdates) => void update({ checkForUpdates })} /></SettingRow>
      <SettingRow title="Credits" detail="Created by Mikey M. · me@mikeymele.com" />
      <SettingRow title="Copyright & license" detail="© 2026 Mikey M. · PolyForm Noncommercial 1.0.0. Non-commercial sharing and modifications are welcome with credit; commercial use requires permission." />
    </section>

    <section className="settings-section danger-zone">
      <SectionHeading icon={<AlertTriangle size={18} />} title="Danger zone" detail="Manage your local library or remove SoFlo from this computer." />
      <SettingRow title="Export SoFlo data" detail="Save your entire library as one portable .soflo file in Downloads."><button className="button button-soft button-small" disabled={busy !== null} onClick={() => void exportData()}><Download size={15} /> {busy === 'export' ? 'Exporting...' : 'Export data'}</button></SettingRow>
      <SettingRow title="Import SoFlo data" detail="Replace this computer's library with a .soflo file."><button className="button button-quiet button-small" disabled={busy !== null} onClick={() => void importData()}><Upload size={15} /> {busy === 'import' ? 'Importing...' : 'Import data'}</button></SettingRow>
      <SettingRow title="Wipe local data" detail="Permanently erase every class, paper, lecture, card, and setting from this computer."><button className="button button-danger button-small" disabled={busy !== null} onClick={() => setWipeConfirmOpen(true)}><AlertTriangle size={15} /> Wipe data</button></SettingRow>
      <SettingRow title="Uninstall SoFlo" detail="Remove the app from this Windows account. Your library stays unless you choose to erase it in SoFlo’s uninstaller."><button className="button button-danger button-small" disabled={busy !== null} onClick={() => setUninstallConfirmOpen(true)}><AlertTriangle size={15} /> Uninstall app</button></SettingRow>
    </section>

    {clearTrashOpen && <ConfirmDialog title="Clear the entire trash?" copy="This permanently deletes every paper and flashcard set in Recently deleted. This cannot be undone." confirmLabel="Clear trash" onClose={() => setClearTrashOpen(false)} onConfirm={() => void api.emptyTrash().then(() => { setClearTrashOpen(false); onToast('Trash cleared.') }).catch(() => onToast('Trash could not be cleared.', 'error'))} />}
    {wipeConfirmOpen && <ConfirmDialog eyebrow="IRREVERSIBLE ACTION" title="Wipe all local data?" copy="This permanently removes every class, paper, lecture, flashcard, schedule, setting, and saved credential on this computer. Export a .soflo file first if you may need anything later." confirmLabel="Wipe everything" busy={busy === 'wipe'} onClose={() => setWipeConfirmOpen(false)} onConfirm={() => void wipeData()} />}
    {uninstallConfirmOpen && <ConfirmDialog eyebrow="UNINSTALL SOFLO" title="Open SoFlo’s uninstaller?" copy="SoFlo will close, then open its own uninstaller. Your data is kept by default; the next screen lets you choose whether to erase it." confirmLabel="Continue" busy={busy === 'uninstall'} onClose={() => setUninstallConfirmOpen(false)} onConfirm={() => void uninstallApp()} />}
    {deleteModelsOpen && <ConfirmDialog eyebrow="LOCAL AI" title="Delete local AI models?" copy="This removes SoFlo's downloaded local models from this PC. AI actions stay disabled until you turn AI back on and download models again." confirmLabel="Delete models" onClose={() => setDeleteModelsOpen(false)} onConfirm={() => void deleteAiModels()} />}
    {securityDialog && <SecurityDialog security={security} type={securityDialog.type} remove={securityDialog.remove} onClose={() => setSecurityDialog(null)} onUpdated={(next) => { onSecurityChange(next); setSecurityDialog(null); onToast(next.configured ? 'Library security updated.' : 'Library encryption removed.') }} />}
    {aiInfoOpen && <AiInfoDialog modelPath={settings.aiModelPath} onClose={() => setAiInfoOpen(false)} />}
    {false && <ModelManagerDialog settings={settings} onClose={() => setModelManagerOpen(false)} onSettingsChange={onSettingsChange} onModelsUpdated={onModelsUpdated} onToast={onToast} />}
    {modelManagerOpen && <LocalModelManager settings={settings} onClose={() => setModelManagerOpen(false)} onSettingsChange={onSettingsChange} onModelsUpdated={onModelsUpdated} onToast={onToast} />}
  </main>
}

type ModelTier = 'low' | 'medium' | 'high'
type ModelRole = 'general' | 'writing' | 'voice'
const modelTiers: { value: ModelTier; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]
function expectedModelMemory(role: ModelRole, tier: ModelTier) { if (role === 'general') return ({ low: 'about 2–4 GB RAM', medium: 'about 5–8 GB RAM', high: 'about 9–14 GB RAM' }[tier]); if (role === 'writing') return ({ low: 'about 1–2 GB RAM', medium: 'about 3–5 GB RAM', high: 'about 5–8 GB RAM' }[tier]); return ({ low: 'about 1 GB RAM', medium: 'about 2–3 GB RAM', high: 'about 3–5 GB RAM' }[tier]) }

function ModelManagerDialog({ settings, onClose, onSettingsChange, onModelsUpdated, onToast }: { settings: AppSettings; onClose: () => void; onSettingsChange: (settings: AppSettings) => void; onModelsUpdated: () => void; onToast: (message: string, type?: 'success' | 'error') => void }) {
  const [general, setGeneral] = useState<ModelTier>(settings.aiGeneralModelTier || 'medium')
  const [writing, setWriting] = useState<ModelTier>(settings.aiWritingModelTier || 'medium')
  const [voice] = useState<ModelTier>(settings.aiVoiceModelTier || 'medium')
  const [working, setWorking] = useState<'apply' | 'cleanup' | null>(null)
  const [deleteAllOpen, setDeleteAllOpen] = useState(false)
  const applyModels = async () => {
    setWorking('apply')
    try {
      const aiModelPath = await api.installAiModel('general', general)
      const aiWritingModelPath = await api.installAiModel('writing', writing)
      const aiVoiceModelPath = await api.installAiModel('voice', voice)
      const next = { ...settings, aiModelPath, aiWritingModelPath, aiVoiceModelPath, aiGeneralModelTier: general, aiWritingModelTier: writing, aiVoiceModelTier: voice }
      await api.updateSettings(next)
      onSettingsChange(next)
      onModelsUpdated()
      onToast('Your AI model choices were applied.')
    } catch (error) { onToast(error instanceof Error ? error.message : 'SoFlo could not download those models.', 'error') } finally { setWorking(null) }
  }
  const deleteUnused = async () => {
    setWorking('cleanup')
    try { await api.deleteUnusedAiModels(settings.aiModelPath, settings.aiWritingModelPath, settings.aiVoiceModelPath); onToast('Unused local models were removed.') } catch (error) { onToast(error instanceof Error ? error.message : 'Unused models could not be removed.', 'error') } finally { setWorking(null) }
  }
  const selected = (role: ModelRole) => role === 'general' ? general : role === 'writing' ? writing : voice
  return <>
    <div className="paper-dialog-backdrop" role="presentation"><section className="paper-dialog model-manager-dialog" role="dialog" aria-modal="true" aria-label="Manage local AI models"><header><div><p className="eyebrow">LOCAL AI MODELS</p><h2>Manage models</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header><div className="paper-dialog-content model-manager-content"><p>Choose each AI model separately. Medium is SoFlo’s default balanced setup.</p>{(['general', 'writing'] as ModelRole[]).map((role) => { const tier = selected(role); return <section className="model-manager-role" key={role}><div><strong>{role === 'general' ? 'General AI' : 'Writing AI'}</strong><span>{role === 'general' ? 'Imports, flashcards, reviews, and study webs' : 'Fast grammar checks, word reference, and thesaurus'}</span></div><div className="model-tier-slider"><input aria-label={`${role} model performance`} type="range" min="0" max="2" step="1" list={`${role}-model-tiers`} value={modelTiers.findIndex((item) => item.value === tier)} onChange={(event) => { const next = modelTiers[Number(event.target.value)].value; role === 'general' ? setGeneral(next) : setWriting(next) }} /><datalist id={`${role}-model-tiers`}>{modelTiers.map((item) => <option value={modelTiers.findIndex((candidate) => candidate.value === item.value)} key={item.value} />)}</datalist><div className="model-tier-labels" aria-hidden="true">{modelTiers.map((item) => <span className={tier === item.value ? 'active' : ''} key={item.value}>{item.label}</span>)}</div></div><p className="model-tier-detail">Expected total memory use: {expectedModelMemory(role, tier)}.</p></section>})}</div><footer><button className="button button-danger" disabled={working !== null} onClick={() => setDeleteAllOpen(true)}>Delete all models</button><button className="button button-quiet" disabled={working !== null} onClick={() => void deleteUnused()}>{working === 'cleanup' ? 'Removing...' : 'Delete unused models'}</button><button className="button button-primary" disabled={working !== null} onClick={() => void applyModels()}>{working === 'apply' ? 'Applying...' : 'Apply'}</button></footer></section></div>
    {deleteAllOpen && <ConfirmDialog eyebrow="LOCAL AI" title="Delete every local AI model?" copy="This removes all downloaded SoFlo AI models from this PC. You can download a new package later." confirmLabel="Delete all models" onClose={() => setDeleteAllOpen(false)} onConfirm={() => void api.deleteLocalAiModels().then(() => { const next = { ...settings, aiModelPath: '', aiWritingModelPath: '', aiGrammar: false, aiGeneralModelTier: 'medium' as const, aiWritingModelTier: 'medium' as const }; onSettingsChange(next); onModelsUpdated(); setDeleteAllOpen(false); onClose(); onToast('SoFlo local AI models were removed from this PC.') }).catch(() => onToast('SoFlo could not remove its local AI models.', 'error'))} />}
  </>
}

function SectionHeading({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) { return <div className="settings-section-heading">{icon}<div><h2>{title}</h2><p>{detail}</p></div>{action}</div> }
function SettingRow({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) { return <div className="setting-row"><div><h3>{title}</h3><p title={detail}>{detail}</p></div>{children}</div> }
function Toggle({ checked, disabled = false, onChange }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) { return <button role="switch" disabled={disabled} aria-checked={checked} className={checked ? 'toggle checked' : 'toggle'} onClick={() => onChange(!checked)}><span /></button> }

function ThemePicker({ value, onChange }: { value: AppSettings['themeColor']; onChange: (value: AppSettings['themeColor']) => void }) {
  return <div className="theme-control"><div className="theme-picker" role="radiogroup" aria-label="Accent color">{(['purple', 'red', 'blue', 'yellow'] as const).map((color) => <button key={color} type="button" role="radio" aria-checked={value === color} className={value === color ? `theme-chip selected ${color}` : `theme-chip ${color}`} onClick={() => onChange(color)}><i /><span>{color}</span>{value === color && <Check size={13} />}</button>)}</div><div className={`theme-live-preview ${value}`} aria-label={`${value} accent preview`}><i /><span /><span /><b /></div></div>
}

function ReadingSurfacePicker({ value, onChange }: { value: AppSettings['editorCanvas']; onChange: (value: AppSettings['editorCanvas']) => void }) {
  const surfaces: { value: AppSettings['editorCanvas']; label: string; detail: string }[] = [{ value: 'paper', label: 'Paper', detail: 'Bright and familiar' }, { value: 'midnight', label: 'Midnight', detail: 'Low-light reading' }, { value: 'slate', label: 'Slate', detail: 'Soft dark contrast' }, { value: 'sepia', label: 'Sepia', detail: 'Warm and gentle' }]
  return <div className="reading-surface-picker" role="radiogroup" aria-label="Reading surface">{surfaces.map((surface) => <button key={surface.value} type="button" role="radio" aria-checked={value === surface.value} className={value === surface.value ? `reading-surface-option selected ${surface.value}` : `reading-surface-option ${surface.value}`} onClick={() => onChange(surface.value)}><span className="reading-preview"><i /><i /><i /></span><strong>{surface.label}</strong><small>{surface.detail}</small></button>)}</div>
}

function ConfirmDialog({ eyebrow, title, copy, confirmLabel, busy = false, onClose, onConfirm }: { eyebrow?: string; title: string; copy: string; confirmLabel: string; busy?: boolean; onClose: () => void; onConfirm: () => void }) {
  return <div className="paper-dialog-backdrop" role="presentation"><section className="paper-dialog" role="dialog" aria-modal="true" aria-label={title}><header><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header><div className="paper-dialog-content"><p>{copy}</p></div><footer><button className="button button-quiet" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-danger" disabled={busy} onClick={onConfirm}>{busy ? 'Working...' : confirmLabel}</button></footer></section></div>
}

function AiInfoDialog({ modelPath, onClose }: { modelPath: string; onClose: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [confirmModelLinkOpen, setConfirmModelLinkOpen] = useState(false)

  const openModelInformation = () => {
    setConfirmModelLinkOpen(false)
    void openUrl(MODEL_INFORMATION_URL).catch(() => {
      globalThis.open(MODEL_INFORMATION_URL, '_blank', 'noopener,noreferrer')
    })
  }

  return <>
    <div className="paper-dialog-backdrop" role="presentation">
      <section className="paper-dialog ai-info-dialog" role="dialog" aria-modal="true" aria-label="About SoFlo AI">
        <header><div><p className="eyebrow">LOCAL ARTIFICIAL INTELLIGENCE</p><h2>About SoFlo AI</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header>
        <div className="paper-dialog-content">
          <div className="ai-info-copy"><strong>Runs locally</strong><p>SoFlo runs its AI prompts through llama.cpp on this computer at 127.0.0.1. Regular AI actions do not send your papers or study material to SoFlo servers or Hugging Face for inference.</p></div>
          <div className="ai-info-copy"><strong>Three local AI models</strong><p>The general model handles imports, flashcards, AI Review, Research & Grade, and lecture analysis. The writing model handles custom spelling checks, definitions, and formal related words. Voice Transcription turns live and imported lecture audio into timestamped text. All three stay on this computer, and Manage models lets you choose Low, Medium, or High for each.</p></div>
          <div className="ai-info-copy"><strong>Online research is different</strong><p>AI Research & Grade first creates a short topic query locally, then sends that query — not your paper — to Crossref for scholarly metadata. Open and evaluate each suggested source before citing it.</p></div>
          <div className="ai-info-copy"><strong>Model download</strong><p>A fresh default download installs all three models together. An update keeps any general model you chose and adds the Writing AI and Voice Transcription companions. Downloads need an internet connection; once installed, local inference stays on your computer.</p></div>
          <div className="ai-info-copy"><strong>Disable AI</strong><p>You can disable AI at any time above. Papers, lectures, manual flashcards, and study modes continue to work.</p></div>
          <button type="button" className="text-button ai-model-link" onClick={() => setConfirmModelLinkOpen(true)}>Model information</button>
          <button className="text-button ai-details-toggle" onClick={() => setDetailsOpen((value) => !value)}>{detailsOpen ? 'Hide technical details' : 'Technical details'}</button>
          {detailsOpen && <dl className="ai-technical-details"><div><dt>General SoFlo model</dt><dd>Qwen3-4B, Q4_K_M GGUF — imports, flashcards, AI Review, and Research & Grade</dd></div><div><dt>Writing model</dt><dd>Qwen3-1.7B, Q4_K_M GGUF — passive spelling checks, definitions, and related words</dd></div><div><dt>Online research index</dt><dd>Crossref — topic-query metadata only</dd></div><div><dt>Runtime</dt><dd>llama.cpp (llama-server)</dd></div><div><dt>Execution</dt><dd>Local loopback server</dd></div><div><dt>Storage</dt><dd>{modelPath || 'SoFlo app data folder after download'}</dd></div></dl>}
        </div>
        <footer><button className="button button-primary" onClick={onClose}>Done</button></footer>
      </section>
    </div>
    {confirmModelLinkOpen && <ExternalLinkConfirmDialog onClose={() => setConfirmModelLinkOpen(false)} onConfirm={openModelInformation} />}
  </>
}

function ExternalLinkConfirmDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return <div className="paper-dialog-backdrop ai-link-confirm-backdrop" role="presentation">
    <section className="paper-dialog ai-link-confirm-dialog" role="dialog" aria-modal="true" aria-label="Open model information">
      <header><div><p className="eyebrow">LEAVING SOFLO</p><h2>Open model information?</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header>
      <div className="paper-dialog-content"><p>This will open the model page in your default browser.</p><p className="external-link-url">huggingface.co/Qwen/Qwen3-4B-GGUF</p></div>
      <footer><button className="button button-quiet" onClick={onClose}>Stay in SoFlo</button><button className="button button-primary" onClick={onConfirm}>Open browser</button></footer>
    </section>
  </div>
}

function SecurityDialog({ security, type, remove, onClose, onUpdated }: { security: SecurityStatus | null; type: 'pin' | 'password'; remove: boolean; onClose: () => void; onUpdated: (status: SecurityStatus) => void }) {
  const [pinDigits, setPinDigits] = useState<4 | 6>(security?.pinDigits ?? 6)
  const [currentPin, setCurrentPin] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [value, setValue] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const changingPin = type === 'pin'
  const hasCurrentCredentials = (!security?.hasPin || currentPin.length > 0) && (!security?.hasPassword || currentPassword.length > 0)
  const valid = hasCurrentCredentials && (remove || (changingPin ? value.length === pinDigits && value === confirmation : value.length >= 8 && value === confirmation))
  const submit = async () => {
    if (!valid) return
    setError('')
    setSaving(true)
    try {
      const status = await api.updateLibrarySecurity({ currentPin: security?.hasPin ? currentPin : undefined, currentPassword: security?.hasPassword ? currentPassword : undefined, newPin: !remove && changingPin ? value : undefined, newPassword: !remove && !changingPin ? value : undefined, removePin: remove && changingPin, removePassword: remove && !changingPin })
      onUpdated(status)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'SoFlo could not update security.')
    } finally {
      setSaving(false)
    }
  }
  const label = type === 'pin' ? 'PIN' : 'password'
  return <div className="security-dialog-backdrop" role="presentation"><section className="security-dialog" role="dialog" aria-modal="true" aria-label={remove ? `Remove ${label}` : `Set ${label}`}><header><div><p className="eyebrow">LIBRARY SECURITY</p><h2>{remove ? `Remove ${label}?` : `${security?.[type === 'pin' ? 'hasPin' : 'hasPassword'] ? 'Change' : 'Add'} ${label}`}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close security dialog"><X size={18} /></button></header><div className="security-dialog-content">{remove && <p className="security-dialog-warning">Removing the last credential decrypts your library. Confirm your active credentials below.</p>}{security?.hasPin && <label>Current PIN<input inputMode="numeric" pattern="[0-9]*" type="password" maxLength={security.pinDigits ?? 6} value={currentPin} onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, ''))} /></label>}{security?.hasPassword && <label>Current password<input type="password" maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>}{!remove && <>{changingPin && <div className="pin-length-toggle"><button type="button" className={pinDigits === 4 ? 'active' : ''} onClick={() => setPinDigits(4)}>4 digits</button><button type="button" className={pinDigits === 6 ? 'active' : ''} onClick={() => setPinDigits(6)}>6 digits</button></div>}<label>New {label}<input autoFocus inputMode={changingPin ? 'numeric' : undefined} pattern={changingPin ? '[0-9]*' : undefined} type="password" maxLength={changingPin ? pinDigits : 128} value={value} onChange={(event) => setValue(changingPin ? event.target.value.replace(/\D/g, '') : event.target.value)} /></label><label>Confirm new {label}<input inputMode={changingPin ? 'numeric' : undefined} pattern={changingPin ? '[0-9]*' : undefined} type="password" maxLength={changingPin ? pinDigits : 128} value={confirmation} onChange={(event) => setConfirmation(changingPin ? event.target.value.replace(/\D/g, '') : event.target.value)} /></label></>}{error && <p className="security-form-error">{error}</p>}<div className="security-dialog-actions"><button className="button button-quiet" onClick={onClose}>Cancel</button><button className={remove ? 'button button-danger' : 'button button-primary'} disabled={!valid || saving} onClick={() => void submit()}>{saving ? 'Saving...' : remove ? `Remove ${label}` : `Save ${label}`}</button></div></div></section></div>
}
