import React from "react";
import { IconButton } from "../ui/IconButton";
import {
  BrainIcon,
  MenuIcon,
  SunIcon,
  MoonIcon,
  TrashIcon,
} from "../ui/Icons";
import type { ConnectionStatus, Theme } from "../../types";

interface HeaderProps {
  status: ConnectionStatus;
  theme: Theme;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onClearHistory: () => void;
  showMenuButton?: boolean;
}

export function Header({
  status,
  theme,
  onToggleTheme,
  onToggleSidebar,
  onClearHistory,
  showMenuButton = true,
}: HeaderProps) {
  const statusText = {
    connected: "Connected",
    connecting: "Connecting...",
    disconnected: "Disconnected",
    error: "Error",
  }[status];

  return (
    <header className="header">
      <div className="header-left">
        {showMenuButton && (
          <IconButton
            variant="ghost"
            onClick={onToggleSidebar}
            tooltip="Menu (Ctrl+B)"
          >
            <MenuIcon size={20} />
          </IconButton>
        )}
        <div className="header-title">
          <BrainIcon size={24} />
          <span>Cobrain</span>
        </div>
      </div>

      <div className="header-actions">
        <div className="header-status">
          <span className={`status-dot ${status}`} />
          <span>{statusText}</span>
        </div>
        <IconButton
          onClick={onClearHistory}
          tooltip="Clear history"
        >
          <TrashIcon size={18} />
        </IconButton>
        <IconButton
          onClick={onToggleTheme}
          tooltip={theme === "dark" ? "Light theme" : "Dark theme"}
        >
          {theme === "dark" ? <SunIcon size={18} /> : <MoonIcon size={18} />}
        </IconButton>
      </div>
    </header>
  );
}
