import { normalizeApkUrl } from "./apk-url";
import versionFile from "../../public/app_version.json";
/**
 * App release registry — server-side source of truth for the mobile app's
 * in-app update checker (GET /api/app-version).
 *
 * WHY THIS EXISTS: the Kharcha Android app asks the backend for the latest
 * available release on launch and compares Android versionCodes. The latest
 * release must be configurable WITHOUT shipping a new mobile build, so the
 * value lives in `public/app_version.json` — the release CONTROL FILE. Edit
 * it per release (version / versionCode / apkUrl / releaseNotes / mandatory),
 * push, done: it is statically imported, so it ships inside the bundle and
 * works on Workers with zero runtime filesystem access. There are no
 * environment variables and no database — the file is the only source.
 *
 * Everything passes through the SAME sanitizer before anything is served,
 * and every failure is contained: this module NEVER throws for "data is
 * bad/unavailable" — it degrades to `null` (the endpoint answers 404 and
 * the app silently continues).
 */

export interface AppRelease {
  version: string;
  versionCode: number;
  apkUrl: string;
  releaseNotes: string[];
  mandatory: boolean;
}

export type ReleaseSource = "file" | "none";

export interface AppReleaseResolution {
  release: AppRelease | null;
  source: ReleaseSource;
}

// ── sanitizer ────────────────────────────────────────────────────────────────

const MAX_VERSION_LENGTH = 32;
const MAX_APK_URL_LENGTH = 2048;
const MAX_NOTES = 10;
const MAX_NOTE_LENGTH = 200;
/** Android versionCode is a signed 32-bit int; Play caps it at 2100000000. */
const MAX_ANDROID_VERSION_CODE = 2_100_000_000;

function safeVersionCode(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value <= 0 || value > MAX_ANDROID_VERSION_CODE) return null;
  return value;
}

/**
 * Validate a release candidate and return it, or null when any hard field
 * fails the behavioral contract (version string, positive integer
 * versionCode, HTTPS apkUrl). `releaseNotes` is cosmetic, so it is
 * sanitized leniently (non-strings dropped, trimmed, capped) instead of
 * rejecting the whole release. Extra/unknown fields are ignored — the API
 * can grow without breaking old clients.
 */
function sanitizeRelease(candidate: unknown): AppRelease | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const raw = candidate as Record<string, unknown>;

  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!version || version.length > MAX_VERSION_LENGTH) return null;

  const versionCode = safeVersionCode(raw.versionCode);
  if (versionCode === null) return null;

  const apkUrl = typeof raw.apkUrl === "string" ? raw.apkUrl.trim() : "";
  if (!apkUrl || apkUrl.length > MAX_APK_URL_LENGTH) return null;
  try {
    if (new URL(apkUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }

  let releaseNotes: string[] = [];
  if (Array.isArray(raw.releaseNotes)) {
    releaseNotes = raw.releaseNotes
      .filter((note): note is string => typeof note === "string")
      .map((note) => note.trim())
      .filter(Boolean)
      .slice(0, MAX_NOTES)
      .map((note) => note.slice(0, MAX_NOTE_LENGTH));
  }

  return {
    version,
    versionCode,
    apkUrl,
    releaseNotes,
    mandatory: raw.mandatory === true,
  };
}

// ── the release control file ────────────────────────────────────────────────

interface VersionFileShape {
  enabled?: boolean;
  version?: unknown;
  versionCode?: unknown;
  apkUrl?: unknown;
  releaseNotes?: unknown;
  mandatory?: unknown;
}

/**
 * The JSON file is statically imported (bundled — no fs at runtime). It is
 * the operator's ONE edit point per release. When disabled or incomplete
 * (empty apkUrl before the APK is uploaded) it yields null, so this file
 * can ship before the first APK exists.
 */
function releaseFromFile(): AppRelease | null {
  try {
    const file = versionFile as VersionFileShape;
    if (!file || file.enabled === false) return null;
    return sanitizeRelease({
      version: typeof file.version === "string" ? file.version : "",
      versionCode:
        typeof file.versionCode === "number" ? file.versionCode : Number.NaN,
      apkUrl:
        typeof file.apkUrl === "string" ? normalizeApkUrl(file.apkUrl) : "",
      releaseNotes: Array.isArray(file.releaseNotes) ? file.releaseNotes : [],
      mandatory: file.mandatory === true,
    });
  } catch {
    return null;
  }
}

// ── resolution ───────────────────────────────────────────────────────────────

/**
 * Kept async so the API route's launch-time failure containment (try/catch,
 * 503) stays structurally identical if more sources are ever added.
 */
export async function resolveLatestAndroidRelease(): Promise<AppReleaseResolution> {
  const release = releaseFromFile();
  return { release, source: release ? "file" : "none" };
}
