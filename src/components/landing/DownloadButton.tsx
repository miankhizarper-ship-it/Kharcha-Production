"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useLatestApkUrl } from "@/hooks/use-latest-apk-url";
import { APK_DIRECT_DOWNLOAD_URL } from "@/config/site";
import { cn } from "@/lib/utils";

type DownloadButtonProps = {
  size?: "default" | "sm" | "lg";
  variant?: "default" | "secondary" | "outline" | "ghost";
  className?: string;
  label?: string;
};

/**
 * The ONLY download action on the page.
 *
 * The href follows the release control file at RUNTIME: the
 * `useLatestApkUrl` hook reads GET /api/app-version (fed by the statically
 * imported public/app_version.json). If the endpoint cannot answer, the
 * button falls back to the build-time constant in src/config/site.ts, which
 * holds the same link — so a JS-less render or an API hiccup still downloads.
 *
 * The served URL is normalized server-side (Drive share pages → direct
 * endpoint, GitHub blob → raw host). `target="_blank"` is kept as a graceful
 * fallback: if a host ever returns HTML instead of the file, the landing
 * page stays open.
 */
export function DownloadButton({
  size = "default",
  variant = "default",
  className,
  label = "Download App",
}: DownloadButtonProps) {
  const { toast } = useToast();
  const liveApkUrl = useLatestApkUrl();
  const apkUrl = liveApkUrl ?? APK_DIRECT_DOWNLOAD_URL;

  if (apkUrl.trim().length > 0) {
    return (
      <Button
        size={size}
        variant={variant}
        className={cn("gap-2", className)}
        asChild
      >
        <a
          href={apkUrl}
          download
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Download the Kharcha Android app (APK)"
        >
          <Download className="size-4" aria-hidden="true" />
          {label}
        </a>
      </Button>
    );
  }

  return (
    <Button
      size={size}
      variant={variant}
      className={cn("gap-2", className)}
      onClick={() =>
        toast({
          title: "Download link coming soon",
          description:
            "The APK link is managed in public/app_version.json. Set apkUrl there and downloads start here automatically.",
        })
      }
    >
      <Download className="size-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
