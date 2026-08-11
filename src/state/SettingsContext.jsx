import { createContext, useContext, useState } from 'react'

const KEY = 'fpl.settings.v1'
const Ctx = createContext(null)

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => {
    try {
      return { teamId: '', leagueId: '', ...JSON.parse(localStorage.getItem(KEY) || '{}') }
    } catch {
      return { teamId: '', leagueId: '' }
    }
  })
  const [sheetOpen, setSheetOpen] = useState(false)

  const update = patch =>
    setSettings(s => {
      const next = { ...s, ...patch }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* private mode — settings just won't persist */
      }
      return next
    })

  return (
    <Ctx.Provider
      value={{
        settings,
        update,
        sheetOpen,
        openSheet: () => setSheetOpen(true),
        closeSheet: () => setSheetOpen(false),
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export const useSettings = () => useContext(Ctx)
