/**
 * Notification Queue Service
 * Queues notifications for offline mobile clients, delivers on reconnect.
 */

import { sendNotificationToClients, hasConnectedClients } from "../web/websocket.ts";

interface QueuedNotification {
  id: string;
  title: string;
  body: string;
  notifType: "summary" | "goal_followup" | "memory_followup" | "mood_check" | "nudge" | "reminder";
  priority: "low" | "medium" | "high" | "urgent";
  data?: Record<string, unknown>;
  queuedAt: number;
}

// In-memory queue per user (persists until server restart)
const queues = new Map<number, QueuedNotification[]>();

// Max queued notifications per user
const MAX_QUEUE_SIZE = 50;

// Max age for queued notifications (24 hours)
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Send a notification to connected clients, or queue if offline.
 */
export function sendOrQueueNotification(
  userId: number,
  notification: Omit<QueuedNotification, "queuedAt">
): void {
  // Try sending to connected clients first
  const sent = sendNotificationToClients(userId, notification);

  if (!sent) {
    // Queue for later delivery
    if (!queues.has(userId)) {
      queues.set(userId, []);
    }

    const queue = queues.get(userId)!;
    queue.push({ ...notification, queuedAt: Date.now() });

    // Trim to max size (remove oldest)
    if (queue.length > MAX_QUEUE_SIZE) {
      queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    }

    console.log(`[NotifQueue] Queued notification for user ${userId}: ${notification.title} (${queue.length} in queue)`);
  }
}

/**
 * Flush queued notifications to connected clients.
 * Call this when a client reconnects.
 */
export function flushQueue(userId: number): number {
  const queue = queues.get(userId);
  if (!queue || queue.length === 0) return 0;

  if (!hasConnectedClients(userId)) return 0;

  const now = Date.now();
  let delivered = 0;

  for (const notif of queue) {
    // Skip expired notifications
    if (now - notif.queuedAt > MAX_AGE_MS) continue;

    const { queuedAt, ...payload } = notif;
    sendNotificationToClients(userId, payload);
    delivered++;
  }

  queues.delete(userId);
  console.log(`[NotifQueue] Flushed ${delivered} notifications for user ${userId}`);
  return delivered;
}

/**
 * Get queue size for a user
 */
export function getQueueSize(userId: number): number {
  return queues.get(userId)?.length ?? 0;
}

/**
 * Clear queue for a user
 */
export function clearQueue(userId: number): void {
  queues.delete(userId);
}
