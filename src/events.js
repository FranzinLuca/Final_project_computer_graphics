/**
  events.js — a minimal publish/subscribe bus.

  This is the piece that keeps modules from ever importing each
  other. The scheduler emits e.g. `pad:hit` and does not know or care whether
  anything is listening
*/

function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  return {
    /** Subscribe. Returns an unsubscribe function. */
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => this.off(event, fn);
    },

    /** Subscribe for exactly one emission. */
    once(event, fn) {
      const off = this.on(event, (payload) => {
        off();
        fn(payload);
      });
      return off;
    },

    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },

    /**
      Publish. A throwing listener is logged and skipped so one bad
      subscriber cannot kill the render loop.
    */
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[bus] listener for "${event}" threw:`, err);
        }
      }
    },
  };
}

export const bus = createBus();