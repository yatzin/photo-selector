# Photo Selector

Web app for sorting phone uploads on the NAS: browse `Mobile Upload`, keep what's
worth keeping, delete the rest, and move picks to `Sort Dropoff`. Runs in a
container on the NAS, next to the photos, so nothing large crosses the network.

Built with Next.js 16, Auth.js (credentials), Prisma + SQLite, Tailwind/shadcn.
Shell (auth, users, theme, settings layout) is adapted from HomeCenter.

## Folders

The container sees only two photo folders, mapped in `docker-compose.yml`:

| NAS share path                  | In container       | Env override          |
| ------------------------------- | ------------------ | --------------------- |
| `\ugreen\Photo\Mobile Upload`  | `/photos/upload`   | `PHOTOS_UPLOAD_DIR`   |
| `\ugreen\Photo\Sort Dropoff`   | `/photos/dropoff`  | `PHOTOS_DROPOFF_DIR`  |

App data (SQLite database) lives in `/data`. The container runs as `PUID:PGID`
so moved files keep normal ownership; use the IDs of a NAS user with read/write
access to the Photo share (`id <user>` over SSH).

**Settings → Storage** shows whether each folder is readable and writable.

## AI duplicate review

The **AI** tab scans one folder for bursts of near-identical photos (grouped
locally by capture time and visual similarity — no AI involved), then asks a
vision model which take is best: eyes open, looking at the camera, smiling,
sharp. Results are saved; start a scan, leave, and review later. Each group
has one button: move the picks to Sort Dropoff and trash the rest (undoable).

Set it up under **Settings → AI** (admins): any OpenAI-compatible server with
a vision model, e.g. Ollama on a PC with a GPU (`ollama pull qwen2.5vl:7b`,
base URL `http://<pc>:11434/v1`; start Ollama with `OLLAMA_HOST=0.0.0.0` so
the NAS can reach it). Thumbnails of each group are sent to that server.

## Deploy (UGOS Docker / Portainer)

1. Copy this repo to the NAS (or build and push the image elsewhere).
2. Edit `docker-compose.yml`: the left-hand volume paths, `PUID`/`PGID`,
   `AUTH_SECRET` (`openssl rand -base64 32`), and the admin account.
3. `docker compose up -d --build`, then browse to `http://<nas>:3200`.

## Local development

```sh
cp .env.example .env      # set AUTH_SECRET; photo dirs default to ./dev-photos
npm install
npm run dev               # http://localhost:3200; applies migrations and seeds the admin first
npm test                  # unit tests (pure logic only)
```

`PHOTOS_UPLOAD_DIR` can also point straight at `\ugreen\Photo\Mobile Upload`.
