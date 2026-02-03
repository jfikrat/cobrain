import React from "react";
import { cn } from "../../utils/helpers";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  variant?: "text" | "circular" | "rectangular";
}

export function Skeleton({
  width,
  height,
  className,
  variant = "text",
}: SkeletonProps) {
  return (
    <div
      className={cn(
        "skeleton",
        variant === "text" && "skeleton-text",
        variant === "circular" && "skeleton-circular",
        className
      )}
      style={{
        width: width,
        height: height,
        borderRadius: variant === "circular" ? "50%" : undefined,
      }}
    />
  );
}

interface SkeletonMessageProps {
  lines?: number;
}

export function SkeletonMessage({ lines = 3 }: SkeletonMessageProps) {
  return (
    <div className="message assistant" style={{ animation: "none" }}>
      <div className="message-avatar">
        <Skeleton variant="circular" width={32} height={32} />
      </div>
      <div className="message-content">
        <Skeleton width={80} height={14} className="skeleton-text" />
        <div style={{ marginTop: "var(--space-sm)" }}>
          {Array.from({ length: lines }).map((_, i) => (
            <Skeleton
              key={i}
              width={i === lines - 1 ? "60%" : "100%"}
              height={16}
              className="skeleton-text"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
