import { ArrowLeft, ArrowRight, Check, KeyRound, LockKeyhole } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import type { AppSettings } from '../../lib/types'
import sofloMark from '../../../src-tauri/icons/128x128.png'

type ThemeColor = AppSettings['themeColor']
interface WelcomeViewProps { onComplete: (input: { name: string; themeColor: ThemeColor; pin?: string; password?: string }) => Promise<void> }

export function WelcomeView({ onComplete }: WelcomeViewProps) {
  const [step, setStep] = useState<'name' | 'security' | 'theme'>('name')
  const [name, setName] = useState('')
  const [themeColor, setThemeColor] = useState<ThemeColor>('purple')
  const [pin, setPin] = useState<string | undefined>()
  const [password, setPassword] = useState<string | undefined>()
  const [setup, setSetup] = useState<'pin' | 'password' | null>(null)
  const [pinDigits, setPinDigits] = useState<4 | 6>(6)
  const [first, setFirst] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  const saveCredential = () => {
    if (setup === 'pin' && first.length === pinDigits && first === confirmation) { setPin(first); setSetup(null); setFirst(''); setConfirmation('') }
    if (setup === 'password' && first.length >= 8 && first === confirmation) { setPassword(first); setSetup(null); setFirst(''); setConfirmation('') }
  }
  const finish = async () => { setSaving(true); try { await onComplete({ name: name.trim(), themeColor, pin, password }) } finally { setSaving(false) } }
  const submitName = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (name.trim()) setStep('security') }
  return <div className={`welcome-view onboarding-theme-${themeColor}`}><div className="welcome-glow" /><section className="welcome-card onboarding-card"><img className="welcome-mark" src={sofloMark} alt="SoFlo" /><div className="onboarding-progress" aria-label={`Step ${step === 'name' ? 1 : step === 'security' ? 2 : 3} of 3`}><i className={step === 'name' ? 'active' : 'done'} /><i className={step === 'security' ? 'active' : step === 'theme' ? 'done' : ''} /><i className={step === 'theme' ? 'active' : ''} /></div>
    {step === 'name' && <><p className="eyebrow">WELCOME TO SOFLO</p><h1>Let’s make this<br />feel like yours.</h1><p className="welcome-copy">What should SoFlo call you? Your name stays on this computer and can be changed anytime in Settings.</p><form onSubmit={submitName}><label>Your name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Your first name" maxLength={48} required /></label><button className="button button-primary" type="submit" disabled={!name.trim()}>Next <ArrowRight size={16} /></button></form></>}
    {step === 'security' && <><p className="eyebrow">OPTIONAL SECURITY</p><h1>Keep your work<br />private.</h1><p className="welcome-copy">Add a quick PIN, a stronger password, or both. When enabled, SoFlo encrypts your library on this computer.</p>{setup ? <CredentialSetup type={setup} pinDigits={pinDigits} onPinDigits={setPinDigits} first={first} confirmation={confirmation} onFirst={setFirst} onConfirmation={setConfirmation} onSave={saveCredential} onCancel={() => { setSetup(null); setFirst(''); setConfirmation('') }} /> : <div className="security-choices"><button type="button" onClick={() => setSetup('pin')}><KeyRound size={17} /><span><strong>{pin ? 'PIN added' : 'Set a PIN'}</strong><small>{pin ? 'Quick unlock is ready' : '4 or 6 digits'}</small></span>{pin && <Check size={16} />}</button><button type="button" onClick={() => setSetup('password')}><LockKeyhole size={17} /><span><strong>{password ? 'Password added' : 'Set a password'}</strong><small>{password ? 'Password unlock is ready' : 'At least 8 characters'}</small></span>{password && <Check size={16} />}</button></div>}<div className="onboarding-actions"><button className="button button-quiet" type="button" onClick={() => setStep('name')}><ArrowLeft size={15} /> Back</button><button className="button button-primary" type="button" onClick={() => setStep('theme')}> {pin || password ? 'Continue' : 'Skip for now'} <ArrowRight size={16} /></button></div><small className="security-onboarding-note">If you forget every PIN and password you set, your encrypted data cannot be recovered.</small></>}
    {step === 'theme' && <><p className="eyebrow">YOUR ACCENT COLOR</p><h1>A little color,<br />everywhere.</h1><p className="welcome-copy">Purple is the default. Your choice updates the accent color across SoFlo and can be changed anytime in Settings.</p><div className="theme-choice-grid">{(['purple', 'red', 'blue', 'yellow'] as ThemeColor[]).map((color) => <button type="button" key={color} className={themeColor === color ? `theme-choice selected ${color}` : `theme-choice ${color}`} onClick={() => setThemeColor(color)}><i /><span>{color}</span>{themeColor === color && <Check size={14} />}</button>)}</div><div className="onboarding-actions"><button className="button button-quiet" type="button" onClick={() => setStep('security')}><ArrowLeft size={15} /> Back</button><button className="button button-primary" type="button" disabled={saving} onClick={() => void finish()}>{saving ? 'Finishing…' : <>Finish <ArrowRight size={16} /></>}</button></div></>}
  </section></div>
}

function CredentialSetup({ type, pinDigits, onPinDigits, first, confirmation, onFirst, onConfirmation, onSave, onCancel }: { type: 'pin' | 'password'; pinDigits: 4 | 6; onPinDigits: (digits: 4 | 6) => void; first: string; confirmation: string; onFirst: (value: string) => void; onConfirmation: (value: string) => void; onSave: () => void; onCancel: () => void }) {
  const valid = type === 'pin' ? first.length === pinDigits && first === confirmation : first.length >= 8 && first === confirmation
  return <div className="credential-setup"><div className="credential-setup-heading"><strong>{type === 'pin' ? 'Create a PIN' : 'Create a password'}</strong><button type="button" onClick={onCancel}>Cancel</button></div>{type === 'pin' && <div className="pin-length-toggle"><button className={pinDigits === 4 ? 'active' : ''} onClick={() => onPinDigits(4)} type="button">4 digits</button><button className={pinDigits === 6 ? 'active' : ''} onClick={() => onPinDigits(6)} type="button">6 digits</button></div>}<label>{type === 'pin' ? 'PIN' : 'Password'}<input autoFocus inputMode={type === 'pin' ? 'numeric' : undefined} pattern={type === 'pin' ? '[0-9]*' : undefined} type="password" maxLength={type === 'pin' ? pinDigits : 128} value={first} onChange={(event) => onFirst(type === 'pin' ? event.target.value.replace(/\D/g, '') : event.target.value)} /></label><label>Confirm {type === 'pin' ? 'PIN' : 'password'}<input inputMode={type === 'pin' ? 'numeric' : undefined} pattern={type === 'pin' ? '[0-9]*' : undefined} type="password" maxLength={type === 'pin' ? pinDigits : 128} value={confirmation} onChange={(event) => onConfirmation(type === 'pin' ? event.target.value.replace(/\D/g, '') : event.target.value)} /></label><button className="button button-primary" type="button" disabled={!valid} onClick={onSave}>Save {type === 'pin' ? 'PIN' : 'password'}</button></div>
}
