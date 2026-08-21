import { X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import type { AppSettings } from '../../lib/types'

type ModelTier = 'low' | 'medium' | 'high'
type ModelRole = 'general' | 'voice'

const tiers: { value: ModelTier; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const modelDetail: Record<ModelRole, { title: string; copy: string; memory: Record<ModelTier, string> }> = {
  general: { title: 'General AI', copy: 'Imports, flashcards, reviews, and Study Webs', memory: { low: 'about 2–4 GB RAM', medium: 'about 5–8 GB RAM', high: 'about 9–14 GB RAM' } },
  voice: { title: 'Voice Transcription', copy: 'Lecture recordings and imported class audio', memory: { low: 'about 1 GB RAM', medium: 'about 2–3 GB RAM', high: 'about 3–5 GB RAM' } },
}

export function LocalModelManager({ settings, onClose, onSettingsChange, onModelsUpdated, onToast }: { settings: AppSettings; onClose: () => void; onSettingsChange: (settings: AppSettings) => void; onModelsUpdated: () => void; onToast: (message: string, type?: 'success' | 'error') => void }) {
  const [selection, setSelection] = useState<Record<ModelRole, ModelTier>>({
    general: settings.aiGeneralModelTier || 'medium',
    voice: settings.aiVoiceModelTier || 'medium',
  })
  const [working, setWorking] = useState<'apply' | 'cleanup' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const errorText = (error: unknown) => typeof error === 'string' && error.trim() ? error : error instanceof Error && error.message ? error.message : 'SoFlo could not update the local AI models.'
  const apply = async () => {
    setWorking('apply')
    try {
      const aiModelPath = await api.installAiModel('general', selection.general)
      const aiVoiceModelPath = await api.installAiModel('voice', selection.voice)
      const next = { ...settings, aiModelPath, aiWritingModelPath: aiModelPath, aiVoiceModelPath, aiGeneralModelTier: selection.general, aiWritingModelTier: selection.general, aiVoiceModelTier: selection.voice }
      await api.updateSettings(next)
      onSettingsChange(next)
      onModelsUpdated()
      onToast('Your local AI models are ready.')
      onClose()
    } catch (error) { onToast(errorText(error), 'error') }
    finally { setWorking(null) }
  }
  const cleanup = async () => {
    setWorking('cleanup')
    try { await api.deleteUnusedAiModels(settings.aiModelPath, settings.aiModelPath, settings.aiVoiceModelPath); onToast('Unused local models were removed.') }
    catch (error) { onToast(errorText(error), 'error') }
    finally { setWorking(null) }
  }
  const deleteAll = async () => {
    setWorking('cleanup')
    try {
      await api.deleteLocalAiModels()
      onSettingsChange({ ...settings, aiModelPath: '', aiWritingModelPath: '', aiVoiceModelPath: '', aiGrammar: false, aiGeneralModelTier: 'medium', aiWritingModelTier: 'medium', aiVoiceModelTier: 'medium' })
      onModelsUpdated()
      onToast('All local AI models were removed from this PC.')
      onClose()
    } catch (error) { onToast(errorText(error), 'error') }
    finally { setWorking(null); setConfirmDelete(false) }
  }
  return <div className="paper-dialog-backdrop" role="presentation"><section className="paper-dialog model-manager-dialog enhanced-model-manager" role="dialog" aria-modal="true" aria-label="Manage local AI models"><header><div><p className="eyebrow">LOCAL AI MODELS</p><h2>Manage models</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></header><div className="paper-dialog-content model-manager-content"><p>Choose one General AI level for every text feature in SoFlo. Voice transcription stays separate.</p>{(Object.keys(modelDetail) as ModelRole[]).map((role) => { const selected = selection[role]; const detail = modelDetail[role]; return <section className="model-manager-role" key={role}><div><strong>{detail.title}</strong><span>{detail.copy}</span></div><div className="model-tier-slider"><input type="range" min="0" max="2" step="1" aria-label={`${detail.title} performance`} value={tiers.findIndex((tier) => tier.value === selected)} onChange={(event) => setSelection((current) => ({ ...current, [role]: tiers[Number(event.target.value)].value }))} /><div className="model-tier-labels" aria-hidden="true">{tiers.map((tier) => <span className={selected === tier.value ? 'active' : ''} key={tier.value}>{tier.label}</span>)}</div></div><p className="model-tier-detail">Expected total memory use: {detail.memory[selected]}.</p></section>})}</div><footer><button className="button button-danger" disabled={working !== null} onClick={() => setConfirmDelete(true)}>Delete all models</button><button className="button button-quiet" disabled={working !== null} onClick={() => void cleanup()}>{working === 'cleanup' ? 'Removing…' : 'Delete unused models'}</button><button className="button button-primary" disabled={working !== null} onClick={() => void apply()}>{working === 'apply' ? 'Applying…' : 'Apply'}</button></footer>{confirmDelete && <div className="model-delete-confirm"><strong>Delete every local AI model?</strong><p>AI actions will stay unavailable until models are downloaded again.</p><div><button className="button button-quiet button-small" disabled={working !== null} onClick={() => setConfirmDelete(false)}>Cancel</button><button className="button button-danger button-small" disabled={working !== null} onClick={() => void deleteAll()}>Delete models</button></div></div>}</section></div>
}
