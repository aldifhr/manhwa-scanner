"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

interface WebSocketMessage {
  topic: string;
  data: unknown;
  timestamp: string;
}

type MessageHandler = (msg: WebSocketMessage) => void;

export function useWebSocket(topics: string[]) {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Map<string, Set<MessageHandler>>>(new Map());
  const queryClient = useQueryClient();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      setConnected(true);
      // Subscribe to topics
      ws.send(JSON.stringify({ action: "subscribe", topics }));
    };

    ws.onclose = () => {
      setConnected(false);
      // Reconnect after 3s
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const msg: WebSocketMessage = JSON.parse(event.data);
        setLastMessage(msg);

        // Notify handlers
        const handlers = handlersRef.current.get(msg.topic);
        handlers?.forEach((h) => h(msg));

        // Auto-invalidate queries based on topic
        if (msg.topic === "dispatch") {
          queryClient.invalidateQueries({ queryKey: ["dispatch-history"] });
          queryClient.invalidateQueries({ queryKey: ["queue-depth"] });
        } else if (msg.topic === "health") {
          queryClient.invalidateQueries({ queryKey: ["health-detailed"] });
        } else if (msg.topic === "audit") {
          queryClient.invalidateQueries({ queryKey: ["audit-log"] });
        }
      } catch {
        // Ignore invalid messages
      }
    };

    wsRef.current = ws;
  }, [topics, queryClient]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const subscribe = useCallback((topic: string, handler: MessageHandler) => {
    if (!handlersRef.current.has(topic)) {
      handlersRef.current.set(topic, new Set());
    }
    handlersRef.current.get(topic)!.add(handler);

    return () => {
      handlersRef.current.get(topic)?.delete(handler);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return { connected, lastMessage, subscribe };
}
