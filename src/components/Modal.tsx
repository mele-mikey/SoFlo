import { type FormEvent, type ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  title: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  wide?: boolean
}

export function Modal({ title, children, onClose, footer, wide = false }: ModalProps) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></header>
        <div className="modal-content">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  )
}

interface FormModalProps extends Omit<ModalProps, 'footer'> {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  submitLabel: string
  saving?: boolean
}

export function FormModal({ onSubmit, submitLabel, saving = false, children, ...modal }: FormModalProps) {
  return <Modal {...modal} footer={<><button className="button button-quiet" type="button" onClick={modal.onClose}>Cancel</button><button className="button button-primary" type="submit" form="soflo-modal-form" disabled={saving}>{saving ? 'Working…' : submitLabel}</button></>}>
    <form id="soflo-modal-form" className="form-stack" onSubmit={onSubmit}>{children}</form>
  </Modal>
}
