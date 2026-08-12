import { Activity, Crown, Grid3X3, Stethoscope, Swords } from 'lucide-react'

const TABS = [
  { id: 'home', label: 'HQ', icon: Activity },
  { id: 'ddx', label: 'Ddx', icon: Stethoscope },
  { id: 'fixtures', label: 'Fixtures', icon: Grid3X3 },
  { id: 'captain', label: 'Captain', icon: Crown },
  { id: 'rivals', label: 'Rivals', icon: Swords },
]

export default function TabBar({ tab, onChange }) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-panel/90 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto grid max-w-md grid-cols-5">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              aria-current={active ? 'page' : undefined}
              className={`relative flex flex-col items-center gap-0.5 py-2.5 ${
                active ? 'text-brand' : 'text-mute active:text-dim'
              }`}
            >
              {active && <span className="absolute top-0 h-[2px] w-8 rounded-full bg-brand" />}
              <Icon size={19} strokeWidth={active ? 2.2 : 1.8} />
              <span className="label !text-[0.58rem] !tracking-[0.12em] !text-current">{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
