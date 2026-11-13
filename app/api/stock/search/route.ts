import { auth } from "@/auth"
import { loadStockConfig } from "@/lib/stock/config"
import { createFreesound } from "@/lib/stock/freesound"
import { createOpenverse } from "@/lib/stock/openverse"
import { createPexels } from "@/lib/stock/pexels"
import { createPixabay } from "@/lib/stock/pixabay"
import { searchStock } from "@/lib/stock/search"
import { parseSearchParams } from "@/lib/stock/search-params"

// GET /api/stock/search?q=&kind=&source=&cursors=<json>
// Searches the stock sources the admin has set up and answers
// { results, cursors, errors, unconfigured }. Read-only, so no same-origin
// check; a session is still required. GET handlers are dynamic by default in
// this Next version, and the session read keeps them so.

export const runtime = "nodejs"

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

export async function GET(request: Request) {
  const session = await auth()
  if (!session) return json({ error: "Sign in again to search." }, 401)
  if (session.user.mustResetPassword) return json({ error: "Change your password first." }, 403)

  const parsed = parseSearchParams(new URL(request.url).searchParams)
  if ("error" in parsed) return json({ error: parsed.error }, 400)

  const cfg = await loadStockConfig()
  const clients = [
    createOpenverse({ clientId: cfg.openverseClientId, clientSecret: cfg.openverseClientSecret }),
    createPixabay({ key: cfg.pixabayKey }),
    createPexels({ key: cfg.pexelsKey }),
    createFreesound({ key: cfg.freesoundKey }),
  ]
  return json(await searchStock(clients, parsed.value))
}
