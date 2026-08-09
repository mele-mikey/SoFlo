import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { InstallerApp } from './features/installer/InstallerApp'
import { api } from './lib/api'

function LaunchRouter() {
  const [installer, setInstaller] = useState<boolean | null>(null)
  useEffect(() => { void api.isInstallerLaunch().then(setInstaller).catch(() => setInstaller(false)) }, [])
  if (installer === null) return <div className="installer-boot" aria-label="Opening SoFlo" />
  return installer ? <InstallerApp /> : <App />
}

createRoot(document.getElementById('root')!).render(<StrictMode><LaunchRouter /></StrictMode>)
