import { useState } from 'react'
import { Settings } from 'lucide-react'
import { SettingsProvider, useSettings } from './state/SettingsContext'
import TabBar from './components/TabBar'
import SettingsSheet from './components/SettingsSheet'
import Home from './pages/Home'
import Differentials from './pages/Differentials'
import Fixtures from './pages/Fixtures'
import Captain from './pages/Captain'
import Rivals from './pages/Rivals'

const PAGES = { home: Home, ddx: Differentials, fixtures: Fixtures, captain: Captain, rivals: Rivals }

function Shell() {
  const [tab, setTab] = useState(() => localStorage.getItem('fpl.tab') || 'home')
  const go = t => {
    setTab(t)
    try {
      localStorage.setItem('fpl.tab', t)
    } catch {
      /* fine */
    }
  }
  const Page = PAGES[tab] || Home
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header
        className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg/85 px-4 pb-2.5 backdrop-blur"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 10px)' }}
      >
        <div className="display text-lg tracking-[0.08em]">
          FPL <span className="text-pitch">Δ</span> DIFFERENTIAL
        </div>
        <SettingsButton />
      </header>
      <main className="flex-1 px-4 pb-28 pt-4">
        <Page key={tab} />
      </main>
      <TabBar tab={tab} onChange={go} />
      <SettingsSheet />
    </div>
  )
}

function SettingsButton() {
  const { openSheet } = useSettings()
  return (
    <button onClick={openSheet} aria-label="Settings" className="p-1 text-dim active:text-ink">
      <Settings size={19} />
    </button>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <Shell />
    </SettingsProvider>
  )
}
