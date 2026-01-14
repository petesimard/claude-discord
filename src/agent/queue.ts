/**
 * Queue management for handling concurrent @ mention requests.
 * Ensures requests are processed sequentially rather than concurrently.
 */

import type { Message } from 'discord.js';

export interface QueuedRequest {
  id: string;
  message: Message;
  prompt: string;
  timestamp: number;
}

// Queue of pending @ mention requests
const requestQueue: QueuedRequest[] = [];

// Currently processing request
let currentRequest: QueuedRequest | null = null;

/**
 * Generate a unique ID for a queued request
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

/**
 * Add a request to the queue
 * @returns The queued request object
 */
export function enqueueRequest(message: Message, prompt: string): QueuedRequest {
  const queuedRequest: QueuedRequest = {
    id: generateRequestId(),
    message,
    prompt,
    timestamp: Date.now()
  };

  requestQueue.push(queuedRequest);
  console.log(`[Queue] Added request ${queuedRequest.id} to queue (position: ${requestQueue.length})`);

  return queuedRequest;
}

/**
 * Remove a request from the queue by ID
 * @returns true if the request was found and removed
 */
export function dequeueRequestById(requestId: string): boolean {
  const index = requestQueue.findIndex(req => req.id === requestId);
  if (index !== -1) {
    requestQueue.splice(index, 1);
    console.log(`[Queue] Removed request ${requestId} from queue`);
    return true;
  }
  return false;
}

/**
 * Get the next request from the queue (FIFO)
 * @returns The next request or null if queue is empty
 */
export function getNextRequest(): QueuedRequest | null {
  const next = requestQueue.shift();
  if (next) {
    console.log(`[Queue] Retrieved next request ${next.id} from queue (${requestQueue.length} remaining)`);
  }
  return next || null;
}

/**
 * Get the current processing request
 */
export function getCurrentRequest(): QueuedRequest | null {
  return currentRequest;
}

/**
 * Set the current processing request
 */
export function setCurrentRequest(request: QueuedRequest | null): void {
  if (request) {
    console.log(`[Queue] Now processing request ${request.id}`);
  } else {
    console.log(`[Queue] Finished processing request`);
  }
  currentRequest = request;
}

/**
 * Check if a request is currently being processed
 */
export function isProcessing(): boolean {
  return currentRequest !== null;
}

/**
 * Get the queue position of a request (1-indexed, 0 if not found)
 */
export function getQueuePosition(requestId: string): number {
  const index = requestQueue.findIndex(req => req.id === requestId);
  return index === -1 ? 0 : index + 1;
}

/**
 * Get the total number of queued requests
 */
export function getQueueSize(): number {
  return requestQueue.length;
}

/**
 * Clear all queued requests
 */
export function clearQueue(): void {
  const count = requestQueue.length;
  requestQueue.length = 0;
  console.log(`[Queue] Cleared ${count} request(s) from queue`);
}
