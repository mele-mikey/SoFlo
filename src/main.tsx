import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { InstallerApp } from './features/installer/InstallerApp'
import { UninstallerApp } from './features/installer/UninstallerApp'
import { api } from './lib/api'

function LaunchRouter() {
  const [launchMode, setLaunchMode] = useState<'app' | 'installer' | 'uninstaller' | null>(null)
  useEffect(() => {
    void Promise.all([api.isInstallerLaunch(), api.isUninstallerLaunch()])
      .then(([installer, uninstaller]) => setLaunchMode(uninstaller ? 'uninstaller' : installer ? 'installer' : 'app'))
      .catch(() => setLaunchMode('app'))
  }, [])
  if (launchMode === null) return <div className="installer-boot" aria-label="Opening SoFlo" />
  return launchMode === 'installer' ? <InstallerApp /> : launchMode === 'uninstaller' ? <UninstallerApp /> : <App />
}

createRoot(document.getElementById('root')!).render(<StrictMode><LaunchRouter /></StrictMode>)
