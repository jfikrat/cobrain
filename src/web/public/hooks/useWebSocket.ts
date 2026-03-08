import { useState, useEffect, useRef, useCallback } from "react";
import type { ConnectionStatus } from "../types";

interface UseWebSocketOptions {
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

interface UseWebSocketReturn {
  status: ConnectionStatus;
  error: string | null;
  sessionId: string | null;
  send: (type: string, payload?: unknown) => void;
  onMessage: (type: string, handler: (data: unknown) => void) => () => void;
  disconnect: () => void;
  reconnect: () => void;
}

/**
 * Hook for WebSocket connection management
 */
export function useWebSocket(
  token: string | null,
  options: UseWebSocketOptions = {}
): UseWebSocketReturn {
  const { reconnectInterval = 3000, maxReconnectAttempts = 5 } = options;

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const messageHandlersRef = useRef<Map<string, (data: unknown) => void>>(new Map());

  const connect = useCallback(() => {
    if (!token || wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus("connecting");
    setError(null);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${token}`);

    ws.onopen = () => {
      console.log("[WS] Connected");
      setStatus("connected");
      reconnectAttemptsRef.current = 0;
    };

    ws.onclose = (event) => {
      console.log("[WS] Disconnected", event.code, event.reason);
      setStatus("disconnected");
      wsRef.current = null;

      // Auto-reconnect if not a clean close
      if (event.code !== 1000 && reconnectAttemptsRef.current < maxReconnectAttempts) {
        reconnectAttemptsRef.current++;
        console.log(
          `[WS] Reconnecting in ${reconnectInterval}ms (attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts})`
        );
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, reconnectInterval);
      }
    };

    ws.onerror = (e) => {
      console.error("[WS] Error:", e);
      setStatus("error");
      setError("Connection error");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const handler = messageHandlersRef.current.get(data.type);
        if (handler) {
          handler(data.payload);
        }

        // Handle connected message
        if (data.type === "connected") {
          setSessionId(data.payload?.sessionId || null);
        }
      } catch (e) {
        console.error("[WS] Parse error:", e);
      }
    };

    wsRef.current = ws;
  }, [token, reconnectInterval, maxReconnectAttempts]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close(1000, "User disconnect");
      wsRef.current = null;
    }
    setStatus("disconnected");
  }, []);

  const reconnect = useCallback(() => {
    disconnect();
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect, disconnect]);

  const send = useCallback((type: string, payload?: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
      return true;
    }
    console.warn("[WS] Cannot send, not connected");
    return false;
  }, []);

  const onMessage = useCallback((type: string, handler: (data: unknown) => void) => {
    messageHandlersRef.current.set(type, handler);
    return () => {
      messageHandlersRef.current.delete(type);
    };
  }, []);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    if (token) {
      connect();
    }
    return () => {
      disconnect();
    };
  }, [token, connect, disconnect]);

  return {
    status,
    error,
    sessionId,
    send,
    onMessage,
    disconnect,
    reconnect,
  };
}
