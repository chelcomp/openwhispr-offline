import React, { useEffect, useState } from "react";
import { GIT_COMMIT_HASH, formatVersionBadgeLabel } from "../utils/buildInfo";

interface VersionBadgeProps {
  variant: "controlPanel" | "overlay";
  visible?: boolean;
}

export default function VersionBadge({ variant, visible = true }: VersionBadgeProps) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getAppVersion?.()
      .then((result) => {
        if (!cancelled && result?.version) setVersion(result.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const label = formatVersionBadgeLabel(version, GIT_COMMIT_HASH);

  if (!label) return null;
  if (variant === "overlay" && !visible) return null;

  const wrapperClassName =
    variant === "overlay"
      ? "fixed bottom-1 left-1 z-0 pointer-events-none opacity-30 hover:opacity-90 transition-opacity duration-150"
      : "fixed bottom-2 left-3 z-[60] pointer-events-none";

  return (
    <div className={wrapperClassName}>
      <span className="text-[11px] text-muted-foreground/70 select-text" title={label}>
        {label}
      </span>
    </div>
  );
}
