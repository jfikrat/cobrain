import { useEffect, useCallback, useRef } from "react";
import type { KeyboardShortcut } from "../types";

type ShortcutHandler = () => void;

interface ShortcutConfig {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/**
 * Hook for managing keyboard shortcuts
 */
export function useKeyboardShortcuts(
  shortcuts: Map<string, { config: ShortcutConfig; handler: ShortcutHandler }> | null
) {
  useEffect(() => {
    if (!shortcuts || shortcuts.size === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        // Allow Escape in inputs
        if (e.key !== "Escape") return;
      }

      for (const [, { config, handler }] of shortcuts) {
        const ctrlMatch = config.ctrl ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.metaKey;
        const shiftMatch = config.shift ? e.shiftKey : !e.shiftKey;
        const altMatch = config.alt ? e.altKey : !e.altKey;
        const keyMatch = e.key.toLowerCase() === config.key.toLowerCase();

        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          e.preventDefault();
          handler();
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
}

/**
 * Hook for registering a single keyboard shortcut
 */
export function useKeyboardShortcut(
  config: ShortcutConfig,
  handler: ShortcutHandler,
  deps: React.DependencyList = []
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs (except Escape)
      if (
        (e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement) &&
        e.key !== "Escape"
      ) {
        return;
      }

      const ctrlMatch = config.ctrl ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.metaKey;
      const shiftMatch = config.shift ? e.shiftKey : !e.shiftKey;
      const altMatch = config.alt ? e.altKey : !e.altKey;
      const keyMatch = e.key.toLowerCase() === config.key.toLowerCase();

      if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
        e.preventDefault();
        handlerRef.current();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [config.key, config.ctrl, config.shift, config.alt, ...deps]);
}

/**
 * Common keyboard shortcuts
 */
export const SHORTCUTS = {
  SEARCH: { key: "k", ctrl: true },
  NEW_CONVERSATION: { key: "n", ctrl: true },
  EXPORT: { key: "e", ctrl: true },
  TOGGLE_SIDEBAR: { key: "b", ctrl: true },
  CLOSE_MODAL: { key: "Escape" },
} as const;
