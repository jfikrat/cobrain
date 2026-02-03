import React from "react";
import { cn } from "../../utils/helpers";

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "ghost";
  size?: "sm" | "md";
  tooltip?: string;
  children: React.ReactNode;
}

export function IconButton({
  variant = "default",
  size = "md",
  tooltip,
  disabled,
  className,
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      className={cn(
        "icon-button",
        variant === "ghost" && "icon-button--ghost",
        size === "sm" && "icon-button--sm",
        className
      )}
      disabled={disabled}
      title={tooltip}
      {...props}
    >
      {children}
    </button>
  );
}
