// EventBus — lightweight pub/sub for cross-component communication

class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on(event, handler) {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event once. Auto-removed after first call.
   */
  once(event, handler) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      handler(data);
    };
    wrapper._original = handler;
    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe a handler from an event.
   */
  off(event, handler) {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    handlers.delete(handler);
    // Also check for once-wrappers that wrap this handler
    for (const h of handlers) {
      if (h._original === handler) {
        handlers.delete(h);
      }
    }
    if (handlers.size === 0) {
      this._handlers.delete(event);
    }
  }

  /**
   * Emit an event with optional data. Handler exceptions are caught
   * and logged — they never prevent other handlers from running.
   */
  emit(event, data) {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[EventBus] Handler error for "${event}":`, err);
      }
    }
  }

  /**
   * Remove all handlers for a specific event, or all handlers if no event given.
   */
  removeAll(event) {
    if (event !== undefined) {
      this._handlers.delete(event);
    } else {
      this._handlers.clear();
    }
  }
}

export const eventBus = new EventBus();
export { EventBus };
