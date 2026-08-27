import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import './styles.css'
import { App } from './App'
import { ServerInstallerApp } from './ServerInstallerApp'

async function render() {
  const installer = await invoke<boolean>('is_server_installer_launch').catch(() => false)
  createRoot(document.getElementById('root')!).render(<StrictMode>{installer ? <ServerInstallerApp /> : <App />}</StrictMode>)
}

void render()
