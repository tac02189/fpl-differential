// Public identifiers only — safe to commit.
export const VAPID_PUBLIC_KEY =
  'BDydFJTfk1QfJCURta5Etr22IKmfxZiRl_9ZRuJ3hTpaUXqzbW-YYq5MOmEKCHXkkNacZA_5UdpZ-kjaVq9TTwE'

// The Cloudflare Worker doubles as FPL proxy and push-subscription store.
// Dev stays on the Vite proxy (and push stays off — no service worker in dev).
const PROD_WORKER = 'https://fpl-proxy.tac02189.workers.dev'
export const WORKER_URL = import.meta.env.VITE_FPL_PROXY || (import.meta.env.PROD ? PROD_WORKER : '')
