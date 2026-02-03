import { useState, useEffect, useCallback } from "react";

/**
 * Hook for syncing state with localStorage
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  // Get initial value from localStorage or use default
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  // Update localStorage when value changes
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      try {
        const valueToStore = value instanceof Function ? value(storedValue) : value;
        setStoredValue(valueToStore);
        localStorage.setItem(key, JSON.stringify(valueToStore));
      } catch (error) {
        console.error(`Error setting localStorage key "${key}":`, error);
      }
    },
    [key, storedValue]
  );

  // Remove from localStorage
  const removeValue = useCallback(() => {
    try {
      localStorage.removeItem(key);
      setStoredValue(initialValue);
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error);
    }
  }, [key, initialValue]);

  return [storedValue, setValue, removeValue];
}

// Storage keys
export const STORAGE_KEYS = {
  MESSAGES: "cobrain_messages",
  THEME: "cobrain_theme",
  CONVERSATIONS: "cobrain_conversations",
  ACTIVE_CONVERSATION: "cobrain_active_conversation",
  SIDEBAR_COLLAPSED: "cobrain_sidebar_collapsed",
} as const;

// Helper for message storage with limit
export function useMessageStorage(maxMessages = 50) {
  const [messages, setMessages, clearMessages] = useLocalStorage<
    Array<{ id: string; role: string; content: string; timestamp: number }>
  >(STORAGE_KEYS.MESSAGES, []);

  const addMessage = useCallback(
    (message: { id: string; role: string; content: string; timestamp: number }) => {
      setMessages((prev) => {
        const updated = [...prev, message];
        // Keep only last N messages
        return updated.slice(-maxMessages);
      });
    },
    [setMessages, maxMessages]
  );

  return { messages, setMessages, addMessage, clearMessages };
}
