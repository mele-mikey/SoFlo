import { KeyRound, LockKeyhole, X } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { PinKeypad } from '../../components/PinInput'
import type { SecurityStatus } from '../../lib/types'
import sofloMark from '../../../src-tauri/icons/128x128.png'

export function LockView({ security, onUnlock }: { security: SecurityStatus; onUnlock: (input: { pin?: string; password?: string }) => Promise<void> }) {
  const [pin, setPin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const [manualEntry, setManualEntry] = useState(false)
  const pinLimit = security.pinDigits ?? 6
  const pinDots = security.pinDigits ?? (pin.length > 4 ? 6 : 4)
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setError(''); setUnlocking(true); try { await onUnlock({ pin, password }) } catch (reason) { setError(reason instanceof Error ? reason.message : 'SoFlo could not unlock your library.') } finally { setUnlocking(false) } }
  const addPinDigit = (digit: string) => setPin((current) => current.length < pinLimit ? `${current}${digit}` : current)
  return <div className="welcome-view lock-view"><div className="welcome-glow" /><section className="welcome-card lock-card"><button className="lock-close-button" type="button" aria-label="Close SoFlo" onClick={() => window.dispatchEvent(new Event('soflo:request-close'))}><X size={18} /></button><img className="welcome-mark" src={sofloMark} alt="SoFlo" /><p className="eyebrow">SOFLO IS LOCKED</p><h1>Your library is<br />encrypted.</h1><p className="welcome-copy">Enter your {security.hasPin && security.hasPassword ? 'PIN, then password' : security.hasPin ? 'PIN' : 'password'} to unlock it on this computer.</p><form onSubmit={submit}>{security.hasPin && <section className="lock-pin-unlock"><button type="button" className="lock-pin-display" onClick={() => setManualEntry(true)} aria-label={`${pin.length} PIN digits entered. Use keyboard entry.`}>{Array.from({ length: pinDots }, (_, index) => <i key={index} className={index < pin.length ? 'filled' : ''} />)}</button><PinKeypad className="lock-pin-keypad" onDigit={addPinDigit} onDelete={() => setPin((current) => current.slice(0, -1))} />{manualEntry ? <label className="lock-manual-entry"><span><KeyRound size={14} /> Keyboard entry</span><input autoFocus inputMode="numeric" pattern="[0-9]*" type="password" value={pin} maxLength={pinLimit} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, pinLimit))} /></label> : <button className="lock-keyboard-button" type="button" onClick={() => setManualEntry(true)}>Use keyboard instead</button>}</section>}{security.hasPassword && <label><span><LockKeyhole size={14} /> Password</span><input autoFocus={!security.hasPin} type="password" value={password} maxLength={128} onChange={(event) => setPassword(event.target.value)} required /></label>} {error && <p className="unlock-error">{error}</p>}<button className="button button-primary" type="submit" disabled={unlocking}>{unlocking ? 'Unlocking…' : 'Unlock SoFlo'}</button></form><small>Your encrypted library cannot be recovered without your credentials.</small></section></div>
}
