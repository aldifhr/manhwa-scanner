"""WebSocket — real-time updates for dispatch, health, and queue."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.logger import get_logger

logger = get_logger("api:websocket")
router = APIRouter()

# ── Connection Manager ──

class ConnectionManager:
    """Manage WebSocket connections with topic-based subscriptions."""
    
    def __init__(self):
        # topic -> set of websockets
        self._subscriptions: dict[str, set[WebSocket]] = {}
        # websocket -> set of topics
        self._connections: dict[WebSocket, set[str]] = {}
    
    async def connect(self, websocket: WebSocket, topics: list[str]):
        """Accept connection and subscribe to topics."""
        await websocket.accept()
        self._connections[websocket] = set(topics)
        for topic in topics:
            if topic not in self._subscriptions:
                self._subscriptions[topic] = set()
            self._subscriptions[topic].add(websocket)
        logger.info("websocket connected", topics=topics)
    
    def disconnect(self, websocket: WebSocket):
        """Remove connection from all subscriptions."""
        topics = self._connections.pop(websocket, set())
        for topic in topics:
            if topic in self._subscriptions:
                self._subscriptions[topic].discard(websocket)
                if not self._subscriptions[topic]:
                    del self._subscriptions[topic]
        logger.info("websocket disconnected", topics=list(topics))
    
    async def broadcast(self, topic: str, data: Any):
        """Broadcast message to all subscribers of a topic."""
        if topic not in self._subscriptions:
            return
        
        message = json.dumps({
            "topic": topic,
            "data": data,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        
        disconnected = []
        for ws in self._subscriptions[topic]:
            try:
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.send_text(message)
            except Exception:
                disconnected.append(ws)
        
        # Clean up disconnected clients
        for ws in disconnected:
            self.disconnect(ws)
    
    async def send_personal(self, websocket: WebSocket, data: Any):
        """Send message to a specific client."""
        try:
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_text(json.dumps(data))
        except Exception:
            self.disconnect(websocket)


manager = ConnectionManager()


# ── WebSocket Endpoint ──

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time updates.
    
    Client subscribes to topics via JSON message:
    {"action": "subscribe", "topics": ["dispatch", "health", "queue"]}
    
    Available topics:
    - dispatch: new dispatch events
    - health: source health changes
    - queue: queue depth updates
    - audit: audit log entries
    """
    # Wait for subscription message
    try:
        data = await websocket.receive_text()
        msg = json.loads(data)
        topics = msg.get("topics", ["dispatch"])
    except Exception:
        topics = ["dispatch"]
    
    await manager.connect(websocket, topics)
    
    try:
        while True:
            # Keep connection alive and handle client messages
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                action = msg.get("action")
                
                if action == "subscribe":
                    new_topics = msg.get("topics", [])
                    for topic in new_topics:
                        if topic not in manager._subscriptions:
                            manager._subscriptions[topic] = set()
                        manager._subscriptions[topic].add(websocket)
                        manager._connections[websocket].add(topic)
                    await manager.send_personal(websocket, {"status": "subscribed", "topics": new_topics})
                
                elif action == "unsubscribe":
                    remove_topics = msg.get("topics", [])
                    for topic in remove_topics:
                        if topic in manager._subscriptions:
                            manager._subscriptions[topic].discard(websocket)
                        manager._connections[websocket].discard(topic)
                    await manager.send_personal(websocket, {"status": "unsubscribed", "topics": remove_topics})
                
                elif action == "ping":
                    await manager.send_personal(websocket, {"pong": True})
            
            except json.JSONDecodeError:
                await manager.send_personal(websocket, {"error": "invalid JSON"})
    
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.warn("websocket error", err=str(e)[:100])
        manager.disconnect(websocket)


# ── Broadcast Helpers ──

async def broadcast_dispatch_event(dispatch_data: dict):
    """Broadcast a new dispatch event."""
    await manager.broadcast("dispatch", dispatch_data)


async def broadcast_health_update(health_data: dict):
    """Broadcast a health status update."""
    await manager.broadcast("health", health_data)


async def broadcast_queue_update(queue_data: dict):
    """Broadcast a queue depth update."""
    await manager.broadcast("queue", queue_data)


async def broadcast_audit_event(audit_data: dict):
    """Broadcast an audit log entry."""
    await manager.broadcast("audit", audit_data)
