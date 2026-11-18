# Kharcha — Landing Page

Marketing site for the **Kharcha** offline-first expense tracker Android app.

Pages: **/** (hero, live app preview, features, why-Kharcha, how-it-works,
download CTA), **/about**, **/contact** (developer details), **/privacy**,
**/terms**, a themed 404.

Fully self-contained: **no environment variables, no database, no admin
dashboard**. The only server-side endpoint is `GET /api/app-version`, which
serves the statically imported `public/app_version.json` control file.

## Quickstart (local dev)

Requires Node.js 20.9+ (or Bun).

```bash
npm install
npm run dev                 # http://localhost:3000
```

Production builds:

```bash
npm run build               # Cloudflare Worker bundle (.next + .open-next/)
npm run build:next          # plain Next.js build (other hosts)
```

## Light / dark theme

The site ships with a **light + dark theme and a toggle in the navbar**
(`next-themes`, class strategy, system preference by default, no flash on
load — the choice is persisted in localStorage). Both palettes live in
`src/app/globals.css` (`:root` for light, `.dark` for dark). The scrollbar is
themed to match in both modes.

## Deploy — Cloudflare Workers (recommended)

The site runs on a Worker via the OpenNext adapter (static assets + server
functions in one Worker). **No Worker variables or secrets are required** —
the release control file ships inside the bundle.

Option A — CLI:
```bash
npm install
npx opennextjs-cloudflare build
npx opennextjs-cloudflare deploy
```
(Wrangler prompts you to log in on first use; `npm run deploy` does both.)

Option B — dashboard Git integration (Workers Builds):
- **Build command:** `npm run build` (default) — this repo's `build` script
  runs `next build` and then the OpenNext Worker bundling, so `.open-next/`
  is produced. `npx opennextjs-cloudflare build` works too.
- **Deploy command:** `npx wrangler deploy` (auto-detects OpenNext; or
  `npx opennextjs-cloudflare deploy` — both are equivalent)

> ⚠️ **The one thing the build command must do is produce `.open-next/`.**
> A build command that only runs plain `next build` leaves `.open-next/`
> missing and the deploy step fails with *"Could not find compiled Open
> Next config, did you run the build command?"*. With THIS package.json,
> `npm run build` builds Next in standalone mode (that is what the
> OpenNext bundler consumes) and then compiles the Worker, so the
> dashboard default already produces the Worker bundle. (`build:next` is
> the plain Next build for other hosts, e.g. Netlify.) Two things NOT to
> do: never point the `build` script DIRECTLY at `opennextjs-cloudflare
> build` (it invokes `npm run build` internally → infinite recursion), and
> never drop the `NEXT_PRIVATE_STANDALONE=true` prefix (the bundler needs
> `.next/standalone/`). The env prefix needs a POSIX shell — fine on
> Cloudflare/Netlify/Linux/macOS; on Windows use WSL or run the two steps
> separately.

Deploy, then verify:

```bash
open https://<your-worker>.workers.dev/
curl -s https://<your-worker>.workers.dev/api/app-version | head -c 400
# → {"version":"1.0.0","versionCode":1,"apkUrl":"https://github.com/…", …}
```

## Deploy — Netlify

The Next runtime is auto-detected; `netlify.toml` sets the build command and
Node version. Just deploy — there are no environment variables to configure.

## In-app update system (GET /api/app-version)

The Android app checks this endpoint once per launch (on the Flutter app's
splash screen) and offers to install a newer APK when the server's
`versionCode` is higher than the installed one. It is fully independent of
the landing page's download buttons.

```json
{
  "version": "1.1.0",
  "versionCode": 2,
  "apkUrl": "https://…direct download link…",
  "releaseNotes": ["Added budgets"],
  "mandatory": false
}
```

- **404** = no release configured (`apkUrl` empty or `enabled: false`) —
  the app silently continues; this endpoint never blocks the app.
- **Configure a release — `public/app_version.json` (the control file)**:
  edit `version`, `versionCode`, `apkUrl`, `releaseNotes`, `mandatory` in
  that ONE file and push. It is statically imported by `/api/app-version`,
  so the whole pipeline (app splash checks + website download buttons)
  follows it after a redeploy. Set `"enabled": false` to pull a release.
- `apkUrl` should be a **direct HTTPS file link** (the app downloads it),
  e.g. a GitHub Releases asset URL
  (`github.com/<u>/<r>/releases/download/<tag>/<file>`). Known page-shaped
  links are auto-converted before serving (see `src/lib/apk-url.ts`):
  Google Drive share pages become the direct endpoint and every GitHub
  repo-file shape (`blob`, `raw`, raw.githubusercontent.com) collapses to
  the canonical `github.com/<u>/<r>/raw/refs/heads/<branch>/<file>` form —
  the one GitHub's own "View raw" button hands out (public repo, file ≤
  100 MiB). Do not host the APK on the Worker itself (25 MiB asset cap).
- All payloads pass strict validation (https URL, positive integer
  versionCode) before being served — see `src/lib/app-release.ts`.

### Release workflow (FlutLab → GitHub release → app_version.json)

1. Bump the version in the Flutter app: `pubspec.yaml` `version: X.Y.Z+N`
   AND `lib/core/app_config.dart` (`appVersion` / `appVersionCode`).
2. Build the APK in FlutLab (Build → Android APK).
3. Create a GitHub release on THIS repository and upload the .apk.
4. Edit `public/app_version.json`: set the new `version` / `versionCode` /
   `apkUrl` (the release-asset link) / `releaseNotes`, push.
5. Every install picks it up on the next splash screen; the website's
   download buttons follow the same value automatically.

Full app release process (signing, testing): see the app repo's
`RELEASE_PROCESS.md`.

## Change the APK download link

The link lives in ONE place: `apkUrl` in `public/app_version.json`.

- Every website download button reads `GET /api/app-version` on page load and
  follows that link; the mobile app's update checker uses the same value —
  one edit publishes everywhere, no variable to set.
- Drive share pages and GitHub `blob` links are auto-converted to the
  canonical `github.com/.../raw/refs/heads/...` download URL
  (`src/lib/apk-url.ts`), so pasting a share link still works.
- `src/config/site.ts` `APK_DOWNLOAD_URL` is the build-time fallback used by
  the buttons when the endpoint cannot answer — keep it in sync with
  `apkUrl` (it currently holds the same GitHub Releases link).

GitHub hosting tip: use a **public** repo (private repos 404 for visitors and
the app) and prefer a Releases asset link
(`github.com/<u>/<r>/releases/download/<tag>/<file>`); committed files are
capped at 100 MiB. Repo-file links are served in the `raw/refs/heads` form,
which redirects to `raw.githubusercontent.com` — if a network blocks that
host, host the APK on Releases or another CDN instead.

Developer identity (name, email, portfolio) is configured in
`src/config/site.ts` (`DEVELOPER_*` constants) and shown on /about, /contact
and in the footer.

## Project structure

```
src/
  app/
    layout.tsx            SEO/OG metadata, fonts, theme, navbar/footer shell
    page.tsx              home (hero + app preview + features + download CTA)
    about/ contact/ privacy/ terms/   inner pages (PageShell)
    not-found.tsx         themed 404
    api/app-version/      GET latest release (mobile in-app update system)
    globals.css           light/dark palettes, scrollbar theme
  components/
    theme-provider.tsx    light/dark provider (next-themes)
    landing/              Navbar, Hero, HeroPhone3D, DestinationPhone +
                          phoneHandoff.ts (the travelling-phone handoff),
                          PhoneMockup, PhoneCarousel (mobile swipe showcase),
                          AppPreview, Features, WhyUse, HowItWorks,
                          DownloadCTA, Footer, DownloadButton (the only
                          download action), Reveal, PageShell, ContactMethods,
                          ThemeToggle
    ui/                   button, toast, toaster (shadcn/ui, subset)
  config/site.ts          APK_DOWNLOAD_URL (build-time fallback for the
                          buttons), developer identity, SITE_URL — single
                          source of truth
  lib/apk-url.ts          APK link normalizer (Drive share → direct,
                          GitHub blob/raw/raw-host → canonical
                          github.com .../raw/refs/heads/... form)
  lib/app-release.ts      release registry for /api/app-version (reads the
                          statically imported control file, strict sanitising)
  hooks/use-toast.ts
  hooks/use-latest-apk-url.ts  runtime APK URL for the website buttons
                          (one shared fetch of /api/app-version per page)
  lib/utils.ts
public/
  app_version.json        the release control file — apkUrl, version,
                          versionCode, releaseNotes
  assets/                 app icon (logo, favicon, OpenGraph image)
wrangler.jsonc            Cloudflare Workers config (OpenNext)
open-next.config.ts       OpenNext adapter config
```

## Branding

- Brand green `#1E5D4B` (design tokens in `src/app/globals.css`)
- App icon: `public/assets/app-icon.png` — matches the Android app icon
- Font: Geist (loaded via `next/font`, no extra install)
