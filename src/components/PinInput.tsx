import { Delete } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface PinInputProps {
  value: string
  onChange: (value: string) => void
  maxLength?: number
  autoFocus?: boolean
  ariaLabel?: string
}

const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0']

export function PinKeypad({ onDigit, onDelete, className = '' }: { onDigit: (digit: string) => void; onDelete: () => void; className?: string }) {
  return <div className={`pin-keypad ${className}`.trim()} aria-label="PIN keypad">{digits.map((digit, index) => digit ? <button key={digit} type="button" className="pin-key" onMouseDown={(event) => event.preventDefault()} onClick={() => onDigit(digit)} aria-label={digit}>{digit}</button> : <span key={`space-${index}`} />)}<button type="button" className="pin-key pin-key-delete" onMouseDown={(event) => event.preventDefault()} onClick={onDelete} aria-label="Delete last digit"><Delete size={16} /></button></div>
}

export function PinInput({ value, onChange, maxLength = 6, autoFocus = false, ariaLabel = 'PIN' }: PinInputProps) {
  const [keypadOpen, setKeypadOpen] = useState(autoFocus)
  const closeTimer = useRef<number | null>(null)
  const openKeypad = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    setKeypadOpen(true)
  }
  const closeKeypad = () => { closeTimer.current = window.setTimeout(() => setKeypadOpen(false), 120) }
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current) }, [])
  const enter = (digit: string) => { if (value.length < maxLength) onChange(`${value}${digit}`) }

  return <div className="pin-entry"><input autoFocus={autoFocus} inputMode="numeric" pattern="[0-9]*" type="password" value={value} maxLength={maxLength} aria-label={ariaLabel} onFocus={openKeypad} onBlur={closeKeypad} onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, maxLength))} />
    {keypadOpen && <PinKeypad onDigit={enter} onDelete={() => onChange(value.slice(0, -1))} />}
  </div>
}
