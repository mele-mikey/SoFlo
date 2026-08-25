import { open } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { AudioLines, ChevronLeft, ChevronRight, Clock3, Mic, Play, Settings2, Sparkles, Square, Upload, Waves } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import type { LectureAnalysis, LectureNoteSuggestion, LectureRecording, LectureTranscriptSegment } from '../../lib/types'

interface LectureRecordingPanelProps {
  lectureId: string
  aiEnabled: boolean
  voiceModelReady: boolean
  voiceModelPath: string
  onEnsureVoiceModel: () => Promise<string | null>
  microphoneId: string
  onMicrophoneChange: (deviceId: string) => void
  onNoteSuggestionsChange: (lectureId: string, suggestions: LectureNoteSuggestion[]) => void
  onToast: (message: string, type?: 'success' | 'error') => void
}

type InputDevice = { deviceId: string; label: string }
type PanelVisibility = 'visible' | 'hiding' | 'hidden' | 'revealing'

const emptyRecording = (lectureId: string): LectureRecording => ({
  lectureId, state: 'ready', sourceKind: 'microphone', audioPath: null, rawAudioPath: null,
  durationMs: 0, capturedMs: 0, transcribedMs: 0, pendingChunks: 0,
  statusMessage: 'Ready to record or import audio.', startedAt: null, stoppedAt: null, updatedAt: '',
})

function timeLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

function toBase64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function resampleToVoicePcm(input: Float32Array, fromRate: number) {
  const targetRate = 16_000
  const length = Math.max(1, Math.round(input.length * targetRate / fromRate))
  const output = new Int16Array(length)
  for (let index = 0; index < length; index += 1) {
    const position = index * fromRate / targetRate
    const left = Math.floor(position)
    const right = Math.min(left + 1, input.length - 1)
    const fraction = position - left
    const sample = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction
    output[index] = Math.max(-1, Math.min(1, sample)) * 0x7fff
  }
  return output
}

function combineSamples(parts: Int16Array[]) {
  const size = parts.reduce((total, part) => total + part.length, 0)
  const combined = new Int16Array(size)
  let offset = 0
  for (const part of parts) { combined.set(part, offset); offset += part.length }
  return combined
}

export function LectureRecordingPanel({ lectureId, aiEnabled, voiceModelReady, voiceModelPath, onEnsureVoiceModel, microphoneId, onMicrophoneChange, onNoteSuggestionsChange, onToast }: LectureRecordingPanelProps) {
  const [recording, setRecording] = useState<LectureRecording>(() => emptyRecording(lectureId))
  const [segments, setSegments] = useState<LectureTranscriptSegment[]>([])
  const [analysis, setAnalysis] = useState<LectureAnalysis | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [busy, setBusy] = useState(false)
  const [panelVisibility, setPanelVisibility] = useState<PanelVisibility>('visible')
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const silenceRef = useRef<GainNode | null>(null)
  const startedAtRef = useRef(0)
  const samplePartsRef = useRef<Int16Array[]>([])
  const uploadChainRef = useRef(Promise.resolve())
  const queuedSampleCountRef = useRef(0)
  const activeRef = useRef(false)
  const voiceModelPathRef = useRef(voiceModelPath)
  const panelVisibilityTimerRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextRecording, nextSegments, nextAnalysis] = await Promise.all([
        api.getLectureRecording(lectureId), api.listLectureTranscriptSegments(lectureId), api.getLectureAnalysis(lectureId),
      ])
      setRecording(nextRecording)
      setSegments(nextSegments)
      setAnalysis(nextAnalysis)
    } catch { /* The editor remains usable if a background refresh fails. */ }
  }, [lectureId])

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 1600); return () => window.clearInterval(timer) }, [refresh])
  useEffect(() => { voiceModelPathRef.current = voiceModelPath }, [voiceModelPath])
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void listen<LectureRecording>('lecture-recording-update', (event) => {
      if (event.payload.lectureId === lectureId) setRecording(event.payload)
    }).then((dispose) => { unlisten = dispose })
    return () => unlisten?.()
  }, [lectureId])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (activeRef.current) setElapsed(Math.max(0, performance.now() - startedAtRef.current))
    }, 250)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => () => { void stopCapture(false) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (panelVisibilityTimerRef.current !== null) window.clearTimeout(panelVisibilityTimerRef.current) }, [])
  useEffect(() => { onNoteSuggestionsChange(lectureId, analysis?.noteSuggestions ?? []) }, [analysis?.noteSuggestions, lectureId, onNoteSuggestionsChange])

  const listMicrophones = useCallback(async (askPermission: boolean) => {
    try {
      if (askPermission) {
        const permission = await navigator.mediaDevices.getUserMedia({ audio: true })
        permission.getTracks().forEach((track) => track.stop())
      }
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput')
      setDevices(inputs.map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` })))
    } catch { onToast('SoFlo could not read your microphones. Check Windows microphone permission.', 'error') }
  }, [onToast])

  const queueSamples = useCallback((samples: Int16Array) => {
    if (!samples.length) return
    const durationMs = Math.max(1, Math.round(samples.length / 16))
    uploadChainRef.current = uploadChainRef.current.then(async () => {
      const chunkIndex = await api.appendLectureAudioChunk(lectureId, toBase64(samples), durationMs)
      if (voiceModelReady || voiceModelPathRef.current) await api.queueLectureTranscription(lectureId, chunkIndex, voiceModelPathRef.current)
    }).catch((error) => onToast(error instanceof Error ? error.message : 'SoFlo could not save that audio chunk.', 'error'))
  }, [lectureId, onToast, voiceModelReady])

  const flushCapturedSamples = useCallback(() => {
    if (!samplePartsRef.current.length) return
    const samples = combineSamples(samplePartsRef.current)
    samplePartsRef.current = []
    queuedSampleCountRef.current = 0
    queueSamples(samples)
  }, [queueSamples])

  const stopCapture = useCallback(async (finalize: boolean) => {
    if (!activeRef.current && !finalize) return
    activeRef.current = false
    processorRef.current?.disconnect(); processorRef.current = null
    silenceRef.current?.disconnect(); silenceRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null
    if (contextRef.current) { await contextRef.current.close().catch(() => undefined); contextRef.current = null }
    flushCapturedSamples()
    setLevel(0)
    if (!finalize) return
    setBusy(true)
    try {
      await uploadChainRef.current
      await api.finishLectureRecording(lectureId, voiceModelPathRef.current)
      await refresh()
    } catch (error) { onToast(error instanceof Error ? error.message : 'SoFlo saved the audio, but could not begin final processing.', 'error') }
    finally { setBusy(false) }
  }, [flushCapturedSamples, lectureId, onToast, refresh])

  const startRecording = async () => {
    setBusy(true)
    try {
      const activeVoiceModelPath = voiceModelReady ? voiceModelPath : await onEnsureVoiceModel()
      if (!activeVoiceModelPath) return
      voiceModelPathRef.current = activeVoiceModelPath
      const constraints: MediaTrackConstraints = microphoneId ? { deviceId: { exact: microphoneId }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true }
      let stream: MediaStream
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: constraints }) }
      catch { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); if (microphoneId) onMicrophoneChange('') }
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const silence = context.createGain(); silence.gain.value = 0
      await api.startLectureRecording(lectureId)
      samplePartsRef.current = []; queuedSampleCountRef.current = 0; uploadChainRef.current = Promise.resolve()
      startedAtRef.current = performance.now() - recording.capturedMs; activeRef.current = true; setElapsed(recording.capturedMs)
      streamRef.current = stream; contextRef.current = context; processorRef.current = processor; silenceRef.current = silence
      processor.onaudioprocess = (event) => {
        if (!activeRef.current) return
        const input = event.inputBuffer.getChannelData(0)
        const rms = Math.sqrt(input.reduce((total, sample) => total + sample * sample, 0) / Math.max(1, input.length))
        setLevel(Math.min(1, rms * 7))
        const samples = resampleToVoicePcm(input, context.sampleRate)
        samplePartsRef.current.push(samples); queuedSampleCountRef.current += samples.length
        if (queuedSampleCountRef.current >= 16_000 * 20) flushCapturedSamples()
      }
      source.connect(processor); processor.connect(silence); silence.connect(context.destination)
      await listMicrophones(false)
      await refresh()
    } catch (error) { onToast(error instanceof Error ? error.message : 'SoFlo could not start the microphone. Check Windows microphone permission.', 'error') }
    finally { setBusy(false) }
  }

  const importAudio = async () => {
    if (!aiEnabled || !voiceModelReady) { onToast('Download the Voice Transcription model in Settings before importing audio.', 'error'); return }
    const path = await open({ title: 'Import lecture audio or video', multiple: false, directory: false, filters: [{ name: 'Audio and video', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'm4v', 'mov', 'mkv', 'webm'] }] })
    if (!path || Array.isArray(path)) return
    setBusy(true)
    setSettingsOpen(false)
    setRecording((current) => ({ ...current, state: 'importing', sourceKind: 'import', durationMs: 0, capturedMs: 0, transcribedMs: 0, pendingChunks: 0, statusMessage: 'Preparing imported audio…' }))
    try { await api.importLectureAudio(lectureId, path, voiceModelPath); void refresh() }
    catch (error) { onToast(error instanceof Error ? error.message : 'That audio or video file could not be imported.', 'error') }
    finally { setBusy(false) }
  }

  const finishRecoveredRecording = async () => {
    if (!voiceModelReady) { onToast('Download the Voice Transcription model in Settings before finishing recovered audio.', 'error'); return }
    setBusy(true)
    try { await api.finishLectureRecording(lectureId, voiceModelPath); await refresh() }
    catch (error) { onToast(error instanceof Error ? error.message : 'SoFlo could not finish the recovered recording.', 'error') }
    finally { setBusy(false) }
  }
  const retryAnalysis = async () => {
    setBusy(true)
    setSettingsOpen(false)
    try { await api.retryLectureAnalysis(lectureId); onToast('SoFlo is organizing the transcript and will append the structured notes to this lecture.', 'success'); await refresh() }
    catch (error) { onToast(error instanceof Error ? error.message : 'SoFlo could not retry the lecture analysis.', 'error') }
    finally { setBusy(false) }
  }
  const hidePanel = () => {
    if (panelVisibility === 'hidden' || panelVisibility === 'hiding') return
    setPanelVisibility('hiding')
    if (panelVisibilityTimerRef.current !== null) window.clearTimeout(panelVisibilityTimerRef.current)
    panelVisibilityTimerRef.current = window.setTimeout(() => setPanelVisibility('hidden'), 250)
  }
  const showPanel = () => {
    if (panelVisibilityTimerRef.current !== null) window.clearTimeout(panelVisibilityTimerRef.current)
    setPanelVisibility('revealing')
    window.requestAnimationFrame(() => setPanelVisibility('visible'))
  }
  const isRecording = recording.state === 'recording' && activeRef.current
  const progress = recording.capturedMs > 0 ? Math.min(100, Math.round(recording.transcribedMs / recording.capturedMs * 100)) : 0
  const isTranscriptionPhase = ['importing', 'queued', 'transcribing', 'transcription_failed'].includes(recording.state)
  const importPreparationLabel = recording.sourceKind === 'import' && recording.capturedMs > 0 && recording.transcribedMs === 0
    ? `Preparing ${timeLabel(recording.capturedMs)} of audio so far`
    : ''
  const processingHeading = recording.state === 'finalizing'
    ? 'Finalizing lecture audio'
    : recording.state === 'analyzing'
      ? 'Creating lecture analysis'
      : recording.state === 'queued'
        ? 'Waiting to transcribe'
        : recording.state === 'transcription_failed'
          ? 'Audio saved safely'
          : 'Processing lecture'
  const processingDetail = recording.state === 'finalizing'
    ? 'Transcript complete. Removing temporary audio.'
    : recording.state === 'analyzing'
      ? 'SoFlo is turning the full transcript into detailed study notes.'
      : importPreparationLabel || (isTranscriptionPhase && recording.capturedMs > 0 ? `${progress}% transcribed` : '')
  const canStart = recording.state === 'ready'
  const bars = Array.from({ length: 18 }, (_, index) => Math.max(12, Math.min(100, 14 + level * (34 + ((index * 17) % 48)))))

  if (panelVisibility === 'hidden') {
    return <button className="lecture-analysis-restore" type="button" onClick={showPanel} aria-label="Show lecture panel" title="Show lecture panel"><ChevronLeft size={17} /></button>
  }
  return <section className={`lecture-panel-shell panel-${panelVisibility}`}>
    <button className="lecture-panel-collapse" type="button" onClick={hidePanel} aria-label="Hide lecture panel" title="Hide lecture panel"><ChevronRight size={16} /></button>
    <div className={`lecture-recording-panel ${isRecording ? 'is-recording' : ''} panel-${panelVisibility}`}>
    <header>
      <div><p className="eyebrow">LIVE LECTURE</p><h2>Lecture Recording</h2></div>
      <div className="lecture-panel-header-actions">{isRecording && <span className="recording-live-dot">Live</span>}{recording.state === 'complete' && aiEnabled && <button className="icon-button tiny ai-action" disabled={busy} onClick={() => void retryAnalysis()} aria-label="Organize and append lecture notes" title="Organize and append lecture notes"><Sparkles size={16} /></button>}<button className="icon-button tiny" onClick={() => { setSettingsOpen((open) => !open); if (!settingsOpen) void listMicrophones(true) }} aria-label="Lecture recording settings"><Settings2 size={16} /></button></div>
    </header>
    {settingsOpen && <div className="lecture-recording-settings"><div><label htmlFor="lecture-microphone">Microphone</label><select id="lecture-microphone" value={microphoneId} onChange={(event) => { onMicrophoneChange(event.target.value); setSettingsOpen(false) }}><option value="">System default</option>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></div><button className="lecture-import-audio" disabled={busy || isRecording} onClick={() => void importAudio()}><Upload size={14} />Import Audio or Video</button></div>}
    {canStart && <div className="lecture-recording-ready"><div className="recording-orb"><Mic size={22} /></div><p>Capture the class and let SoFlo build your transcript as you write.</p><button className="lecture-record-button" disabled={busy} onClick={() => void startRecording()}><Play size={16} fill="currentColor" />{busy && !voiceModelReady ? 'Preparing voice transcription…' : 'Start recording'}</button>{!voiceModelReady && <small>Voice Transcription will install automatically when you start recording.</small>}{!aiEnabled && <small>Recording and transcription work without General AI; lecture analysis remains unavailable.</small>}</div>}
    {recording.state === 'interrupted' && <div className="lecture-recovery"><strong>{recording.sourceKind === 'import' ? 'Recovered audio import' : 'Recovered recording'}</strong><p>{recording.sourceKind === 'import' ? 'SoFlo kept the prepared audio before the interruption. Finish it to continue transcription.' : 'SoFlo kept the audio saved before the interruption. Continue capture or finish the audio that is already safe.'}</p><div>{recording.sourceKind !== 'import' && <button className="button button-quiet button-small" disabled={busy} onClick={() => void startRecording()}>Continue recording</button>}<button className="button button-primary button-small" disabled={busy} onClick={() => void finishRecoveredRecording()}>{recording.sourceKind === 'import' ? 'Finish import' : 'Finish saved audio'}</button></div></div>}
    {isRecording && <div className="lecture-recording-active"><div className="lecture-timer"><Clock3 size={15} /><strong>{timeLabel(elapsed)}</strong></div><div className="lecture-audio-bars" aria-label="Microphone level">{bars.map((height, index) => <i key={index} style={{ height: `${height}%`, opacity: 0.45 + (height / 180) }} />)}</div><div className="lecture-status"><Waves size={15} /><span>{recording.pendingChunks ? `${progress}% transcribed · ${recording.pendingChunks} chunk${recording.pendingChunks === 1 ? '' : 's'} catching up` : 'Transcript is up to date'}</span></div><button className="lecture-stop-button" disabled={busy} onClick={() => void stopCapture(true)}><Square size={14} fill="currentColor" />Stop & finish</button></div>}
    {!isRecording && !canStart && !['complete', 'analysis_failed', 'interrupted'].includes(recording.state) && <div className="lecture-processing"><AudioLines size={21} /><strong>{processingHeading}</strong><p>{recording.statusMessage}</p>{isTranscriptionPhase && <div className={`lecture-progress ${recording.capturedMs > 0 ? '' : 'is-indeterminate'}`}><i style={{ width: `${progress}%` }} /></div>}{recording.capturedMs > 0 && <small>{processingDetail}</small>}{recording.capturedMs === 0 && isTranscriptionPhase && <small>Preparing the audio for transcription…</small>}</div>}
    {segments.length > 0 && <details className="lecture-transcript"><summary>Transcript <span>{segments.length} segments</span></summary><div>{segments.slice(-18).map((segment) => <article key={segment.id}><small>{timeLabel(segment.startMs)}{segment.speaker !== 'Primary speaker' && ` · ${segment.speaker}`}</small><p>{segment.text}</p></article>)}</div></details>}
    </div>
  </section>
}

function AnalysisList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return <section className="lecture-analysis-list"><h3>{title}</h3><ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></section>
}

function DetailedLectureNotes({ notes }: { notes: string }) {
  return <section className="lecture-detailed-notes"><MarkdownLectureNotes notes={notes} /></section>
}

void AnalysisList
void DetailedLectureNotes

function MarkdownLectureNotes({ notes }: { notes: string }) {
  const lines = notes.split(/\r?\n/)
  if (!lines.some((line) => line.trim())) return null
  const plain = (value: string) => value.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/`/g, '')
  const blocks: ReactNode[] = []
  let code: string[] | null = null
  const flushCode = () => {
    if (!code?.some((line) => line.trim())) return
    blocks.push(<pre className="lecture-note-code" key={`code-${blocks.length}`}><code>{code.join('\n').trim()}</code></pre>)
    code = null
  }
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      if (code) flushCode()
      else code = []
      continue
    }
    if (code) { code.push(raw); continue }
    if (!line) continue
    if (/^\*\*[^*]+\*\*$/.test(line)) {
      blocks.push(<h4 key={`bold-heading-${index}`}>{plain(line)}</h4>)
      continue
    }
    if (line === '---') { blocks.push(<hr key={`divider-${index}`} />); continue }
    if (/^#{1,6}\s/.test(line)) { blocks.push(<h4 key={`heading-${index}`}>{plain(line)}</h4>); continue }
    if (/^>\s*/.test(line)) { blocks.push(<p className="lecture-note-connection" key={`connection-${index}`}>{plain(line.replace(/^>\s*/, ''))}</p>); continue }
    if (/^(?:[-*]|\d+\.)\s+/.test(line)) { blocks.push(<p className="lecture-note-bullet" key={`bullet-${index}`}>{plain(line.replace(/^(?:[-*]|\d+\.)\s+/, ''))}</p>); continue }
    blocks.push(<p key={`note-${index}`}>{plain(line)}</p>)
  }
  flushCode()
  return <div className="lecture-markdown-notes">{blocks}</div>
}
