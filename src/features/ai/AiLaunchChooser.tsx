import { BookOpenText, BrainCircuit, FilePenLine } from 'lucide-react'

export type AiLaunchMode = 'writing' | 'study' | 'browsing'

interface AiLaunchChooserProps {
  onChoose: (mode: AiLaunchMode) => void
  onNeverShowAgain: () => void
}

export function AiLaunchChooser({ onChoose, onNeverShowAgain }: AiLaunchChooserProps) {
  return <section className="ai-launch-chooser" role="dialog" aria-modal="true" aria-label="Choose your AI session">
    <div className="ai-launch-chooser-glow" />
    <main className="ai-launch-chooser-card">
      <p className="eyebrow">SOFLO AI</p>
      <h1>What are you working on?</h1>
      <div className="ai-launch-choices">
        <button className="ai-launch-choice" onClick={() => onChoose('writing')}>
          <strong>Making a lecture<br />or writing a paper</strong>
          <small>Lectures prepare General AI and transcription; papers use General AI</small>
          <i><FilePenLine size={30} strokeWidth={1.6} /></i>
        </button>
        <button className="ai-launch-choice" onClick={() => onChoose('study')}>
          <strong>Studying</strong>
          <small>Prepare flashcards and study tools</small>
          <i><BrainCircuit size={30} strokeWidth={1.6} /></i>
        </button>
        <button className="ai-launch-choice" onClick={() => onChoose('browsing')}>
          <strong>Just browsing</strong>
          <small>Keep local AI unloaded for now</small>
          <i><BookOpenText size={30} strokeWidth={1.6} /></i>
        </button>
      </div>
    </main>
    <button className="ai-launch-never-show" onClick={onNeverShowAgain}>Never show again</button>
  </section>
}
