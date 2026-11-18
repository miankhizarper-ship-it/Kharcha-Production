import { withAnalyticsDb } from "./analytics/mongo";
import {
  APP_RELEASE_BINDING_KEYS,
  resolveBinding,
  type BindingSource,
} from "./analytics/env";
import { normalizeApkUrl } from "./apk-url";
import versionFile from "../../public/app_version.json";
/**
 * App release registry — server-side source of truth for the mobile app's
 * in-app update checker (GET /api/app-version).
 *
 * WHY THIS EXISTS: the Kharcha Android app asks the backend for the latest
 * available release on launch and compares Android versionCodes. The latest
 * release must be configurable WITHOUT shipping a new mobile build, so the
 * value can live in THREE places, in this order:
 *
 * 1. `public/app_version.json` — the release CONTROL FILE. Edit it per
 *    release (version / versionCode / apkUrl / releaseNotes / mandatory),
 *    push, done: it is statically imported, so it ships inside the bundle
 *    and works on Workers with zero runtime filesystem access. While
 *    `apkUrl` is empty or `enabled` is false it yields null and the next
 *    source takes over.
 * 2. Environment bindings (explicit ops override — set in the Cloudflare
 *    dashboard like every other secret). When a full env release is present
 *    it keeps working even while MongoDB is unhealthy (the update check is
 *    a launch-time dependency of every app user).
 * 3. MongoDB `app_releases` (default store — insert one document per
 *    release, highest `versionCode` with `enabled: true` wins).
 *
 * `APP_RELEASE_SOURCE` forces a mode: `file` | `environment` skips the
 * lower sources entirely, `database` skips file + env.
 *
 * All sources pass through the SAME sanitizer before anything is served,
 * and every failure is contained: this module NEVER throws for "data is
 * bad/unavailable" — it degrades to the next source or to `null`.
 */

export interface AppRelease {
  version: string;
  versionCode: number;
  apkUrl: string;
  releaseNotes: string[];
  mandatory: boolean;
}

export type ReleaseSource = "file" | "environment" | "database" | "none";

export interface AppReleaseResolution {
  release: AppRelease | null;
  source: ReleaseSource;
}

/** MongoDB collection holding one document per release (default store). */
export const APP_RELEASES_COLLECTION = "app_releases";

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
 * Validate an untrusted release candidate (DB document fields or env values).
 * Returns the release plus value-free `issues` describing EVERY violation of
 * the behavioral contract (version string, positive integer versionCode,
 * HTTPS apkUrl). `releaseNotes` is cosmetic, so it is sanitized leniently
 * (non-strings dropped, trimmed, capped) instead of rejecting the whole
 * release. Extra/unknown fields are ignored — the API can grow without
 * breaking old clients. `release` is null when any hard field fails; the
 * issues are what the env-check diagnostic surfaces to the operator.
 */
function validateRelease(candidate: unknown): {
  release: AppRelease | null;
  issues: string[];
} {
  const issues: string[] = [];
  if (typeof candidate !== "object" || candidate === null) {
    return { release: null, issues: ["payload is not an object"] };
  }
  const raw = candidate as Record<string, unknown>;

  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (!version) issues.push("version: missing or empty");
  else if (version.length > MAX_VERSION_LENGTH)
    issues.push(`version: longer than ${MAX_VERSION_LENGTH} characters`);

  const versionCode = safeVersionCode(raw.versionCode);
  if (versionCode === null)
    issues.push(
      "versionCode: not a positive integer (send the bare number, e.g. 2)",
    );

  const apkRaw = typeof raw.apkUrl === "string" ? raw.apkUrl.trim() : "";
  if (!apkRaw) {
    issues.push("apkUrl: missing or empty");
  } else if (apkRaw.length > MAX_APK_URL_LENGTH) {
    issues.push(`apkUrl: longer than ${MAX_APK_URL_LENGTH} characters`);
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(apkRaw);
    } catch {
      issues.push("apkUrl: not a valid URL");
    }
    if (parsed && parsed.protocol !== "https:")
      issues.push("apkUrl: must start with https://");
  }
  const apkUrl = apkRaw;

  const valid = issues.length === 0;
  let releaseNotes: string[] = [];
  if (Array.isArray(raw.releaseNotes)) {
    releaseNotes = raw.releaseNotes
      .filter((note): note is string => typeof note === "string")
      .map((note) => note.trim())
      .filter(Boolean)
      .slice(0, MAX_NOTES)
      .map((note) => note.slice(0, MAX_NOTE_LENGTH));
  }

  if (!valid) return { release: null, issues };
  return {
    release: {
      version,
      versionCode: versionCode as number,
      apkUrl,
      releaseNotes,
      mandatory: raw.mandatory === true,
    },
    issues,
  };
}

function sanitizeRelease(candidate: unknown): AppRelease | null {
  return validateRelease(candidate).release;
}

// ── source 0: public/app_version.json (the release control file) ─────────

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
 * (empty apkUrl before the APK is uploaded) it yields null and the next
 * source takes over, so this file can ship before the first APK exists.
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

// ── source 1: environment bindings ───────────────────────────────────────────

/**
 * Env names (all optional; the release is only served when the three
 * behavioral ones validate):
 *   APP_LATEST_VERSION      e.g. "1.1.0"
 *   APP_LATEST_VERSION_CODE e.g. "2"
 *   APP_LATEST_APK_URL      direct HTTPS download URL for the APK (known
 *                           page-shaped links — Drive share pages, GitHub
 *                           blob/raw — are auto-converted to direct URLs,
 *                           so pasting a share link still works)
 *   APP_RELEASE_NOTES       JSON array string, or one note per line
 *   APP_UPDATE_MANDATORY    "true" forces the update dialog
 *   APP_RELEASE_SOURCE      "environment" | "database" — forces a mode
 */
function releaseFromEnvironment(): AppRelease | null {
  const notesRaw = resolveBinding("APP_RELEASE_NOTES").value;
  let notes: unknown;
  if (notesRaw) {
    try {
      const parsed: unknown = JSON.parse(notesRaw);
      notes = Array.isArray(parsed) ? parsed : [String(parsed)];
    } catch {
      notes = notesRaw.split(/\r?\n/);
    }
  }

  const codeRaw = resolveBinding("APP_LATEST_VERSION_CODE").value;
  return sanitizeRelease({
    version: resolveBinding("APP_LATEST_VERSION").value,
    versionCode: codeRaw ? Number(codeRaw) : Number.NaN,
    apkUrl: normalizeApkUrl(resolveBinding("APP_LATEST_APK_URL").value),
    releaseNotes: notes,
    mandatory:
      resolveBinding("APP_UPDATE_MANDATORY").value.trim().toLowerCase() ===
      "true",
  });
}

// ── source 2: MongoDB app_releases ───────────────────────────────────────────

/**
 * Document shape:
 * {
 *   platform: "android",     // reserved for future targets
 *   version: "1.1.0",
 *   versionCode: 2,          // authoritative comparison value
 *   apkUrl: "https://...",   // DIRECT download URL (https)
 *   releaseNotes: ["..."],
 *   mandatory: false,
 *   enabled: true,           // false = never serve this doc
 *   createdAt / updatedAt: Date
 * }
 */
async function releaseFromDatabase(): Promise<AppRelease | null> {
  const doc = await withAnalyticsDb(
    (db) =>
      db
        .collection(APP_RELEASES_COLLECTION)
        .findOne({ platform: "android", enabled: true }, { sort: { versionCode: -1 } }),
    "release-lookup",
  );
  if (!doc) return null;
  return sanitizeRelease({
    version: doc.version,
    versionCode: doc.versionCode,
    apkUrl: normalizeApkUrl(doc.apkUrl),
    releaseNotes: doc.releaseNotes,
    mandatory: doc.mandatory,
  });
}

/**
 * Bounded database attempt. A database that is slow, misconfigured or
 * unreachable must never hang the update check: the lookup is raced against
 * a timeout and ANY rejection resolves to null (→ next source takes over).
 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

const DB_LOOKUP_TIMEOUT_MS = 6_000;

// ── resolution order ─────────────────────────────────────────────────────────

export async function resolveLatestAndroidRelease(): Promise<AppReleaseResolution> {
  const forced = resolveBinding("APP_RELEASE_SOURCE").value.trim().toLowerCase();

  // Forced modes never touch the lower sources (escape hatch while a
  // specific source is broken).
  if (forced === "file") {
    return { release: releaseFromFile(), source: "file" };
  }
  if (forced === "environment") {
    return { release: releaseFromEnvironment(), source: "environment" };
  }

  // 1. The release control file — the operator's per-release edit point.
  const fileRelease = forced === "database" ? null : releaseFromFile();
  if (fileRelease) {
    return { release: fileRelease, source: "file" };
  }

  // 2. An env release, when fully configured, is the explicit ops override
  //    and keeps serving even if the database below fails or times out.
  const envRelease = forced === "database" ? null : releaseFromEnvironment();
  if (envRelease) {
    return { release: envRelease, source: "environment" };
  }

  // 3. Default store: latest enabled android release from MongoDB.
  const dbRelease = await withTimeout(
    releaseFromDatabase(),
    DB_LOOKUP_TIMEOUT_MS,
  );
  if (dbRelease) {
    return { release: dbRelease, source: "database" };
  }

  return { release: null, source: "none" };
}

// ── diagnostics (for GET /api/admin/env-check) ──────────────────────────────

export interface ReleaseDiagnosis {
  /** Presence/source of every APP_* binding, as the RUNNING deployment sees them. */
  bindings: Record<string, { present: boolean; source: BindingSource }>;
  /** APP_RELEASE_SOURCE value, if the operator forced a mode. */
  forcedSource: string;
  /** The app_version.json control-file candidate (value-free). */
  fileRelease: {
    valid: boolean;
    enabled: boolean;
    issues: string[];
  };
  /** Whether the env-only candidate passes validation + value-free issues. */
  envRelease: { valid: boolean; issues: string[] };
  /** What /api/app-version actually serves right now (its public payload). */
  resolved: {
    source: ReleaseSource;
    release:
      | {
          version: string;
          versionCode: number;
          apkUrl: string;
          releaseNotes: string[];
          mandatory: boolean;
        }
      | null;
  };
}

/**
 * Full diagnostic picture of the release system for the env-check endpoint.
 * Binding VALUES are never reported — only presence/source, validation
 * issues (field-level, value-free) and, when a release actually resolves,
 * the SAME public payload /api/app-version serves to every app user.
 * Never throws: every part is individually contained.
 */
export async function diagnoseAndroidRelease(): Promise<ReleaseDiagnosis> {
  const bindings: ReleaseDiagnosis["bindings"] = {};
  for (const key of APP_RELEASE_BINDING_KEYS) {
    const { source } = resolveBinding(key);
    bindings[key] = { present: source !== "missing", source };
  }

  // Validate the file candidate exactly the way releaseFromFile does, so the
  // operator sees WHY the control file is (not) being served.
  const file = versionFile as VersionFileShape | undefined;
  const fileCheck = validateRelease({
    version: typeof file?.version === "string" ? file.version : "",
    versionCode:
      typeof file?.versionCode === "number" ? file.versionCode : Number.NaN,
    apkUrl: typeof file?.apkUrl === "string" ? normalizeApkUrl(file.apkUrl) : "",
    releaseNotes: Array.isArray(file?.releaseNotes) ? file.releaseNotes : [],
    mandatory: false,
  });

  // Validate the env candidate exactly the way releaseFromEnvironment does
  // (cosmetic fields omitted — they can never produce issues anyway).
  const codeRaw = resolveBinding("APP_LATEST_VERSION_CODE").value;
  const envCheck = validateRelease({
    version: resolveBinding("APP_LATEST_VERSION").value,
    versionCode: codeRaw ? Number(codeRaw) : Number.NaN,
    apkUrl: normalizeApkUrl(resolveBinding("APP_LATEST_APK_URL").value),
    releaseNotes: [],
    mandatory: false,
  });

  const { release, source } = await resolveLatestAndroidRelease();

  return {
    bindings,
    forcedSource: resolveBinding("APP_RELEASE_SOURCE").value.trim().toLowerCase(),
    fileRelease: {
      valid: fileCheck.release !== null,
      enabled: file?.enabled !== false,
      issues: fileCheck.issues,
    },
    envRelease: { valid: envCheck.release !== null, issues: envCheck.issues },
    resolved: {
      source,
      release: release
        ? {
            version: release.version,
            versionCode: release.versionCode,
            apkUrl: release.apkUrl,
            releaseNotes: release.releaseNotes,
            mandatory: release.mandatory,
          }
        : null,
    },
  };
}
