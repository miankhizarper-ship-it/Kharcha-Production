/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  SITE CONFIG — SINGLE SOURCE OF TRUTH
 * ─────────────────────────────────────────────────────────────────────────────
 *  APK download link.
 *
 *  The release lives in public/app_version.json (version / versionCode /
 *  apkUrl / releaseNotes). GET /api/app-version serves that file to the
 *  mobile app's update checker, and every download button fetches the same
 *  endpoint on page load — one edit publishes everywhere.
 *
 *  This constant is the BUILD-TIME FALLBACK for the rare case the endpoint
 *  cannot answer. Keep it in sync with apkUrl in app_version.json: it holds
 *  the same direct GitHub release-asset link, so the button works even
 *  without JavaScript or while the API route is unhealthy.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { normalizeApkUrl } from "@/lib/apk-url";

export const APK_DOWNLOAD_URL =
  "https://github.com/miankhizarper-ship-it/Kharcha-Production/releases/download/v1.0.0/kharcha.apk";

/**
 * Direct-download derivation of the build-time fallback via the one shared
 * normalizer (Drive share → direct endpoint, GitHub blob/raw → raw host).
 * The runtime link from /api/app-version is already normalized server-side
 * and never passes here.
 */
export const APK_DIRECT_DOWNLOAD_URL = normalizeApkUrl(APK_DOWNLOAD_URL);

/** Product identity used across the landing page. */
export const APP_NAME = "Kharcha";
export const APP_TAGLINE = "Simple personal finance tracking";
export const APP_DESCRIPTION =
  "Kharcha is a fast, offline-first expense tracker for Android. Record expenses and income, review every transaction, and understand where your money goes — no account, no cloud, completely private.";

/**
 * Developer / maintainer identity. Used on the Contact and About pages and in
 * the footer — change it here once, it updates everywhere.
 */
export const DEVELOPER_NAME = "Mian Khizar";
export const DEVELOPER_EMAIL = "miiankhiizar@gmail.com";
export const DEVELOPER_PORTFOLIO_URL = "https://khizar.pro";
export const DEVELOPER_PORTFOLIO_LABEL = "khizar.pro";

/**
 * Canonical site URL — used as metadataBase so OpenGraph/Twitter images and
 * canonical URLs resolve to absolute addresses (silences the Next.js
 * metadataBase warning). Update after connecting a custom domain.
 */
export const SITE_URL = "https://kharcha-web.pages.dev";
