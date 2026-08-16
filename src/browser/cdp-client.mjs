export class CdpClient {
  constructor(socket, { timeoutMs = 15000 } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;

    socket.addEventListener('message', event => this.#onMessage(event));
    socket.addEventListener('close', () => this.#onClose());
    socket.addEventListener('error', event => this.#onSocketError(event));
  }

  static async connect(url, { timeoutMs = 15000, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (!WebSocketImpl) throw new Error('Ferrum direct CDP requires a WebSocket implementation. Node 24+ provides one globally.');
    const socket = new WebSocketImpl(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try { socket.close(); } catch {}
        reject(new Error(`CDP WebSocket did not open within ${timeoutMs}ms: ${url}`));
      }, timeoutMs);
      timer.unref?.();
      const onOpen = () => { cleanup(); resolve(); };
      const onError = event => { cleanup(); reject(new Error(`CDP WebSocket failed to open: ${event?.message || url}`)); };
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener?.('open', onOpen);
        socket.removeEventListener?.('error', onError);
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
    return new CdpClient(socket, { timeoutMs });
  }

  on(method, handler) {
    const set = this.handlers.get(method) || new Set();
    set.add(handler);
    this.handlers.set(method, set);
    return () => {
      set.delete(handler);
      if (!set.size) this.handlers.delete(method);
    };
  }

  async send(method, params = {}, sessionId = undefined, timeoutMs = this.timeoutMs) {
    if (this.closed) throw new Error(`CDP connection is closed; cannot send ${method}`);
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    if (this.socket.readyState === 0 || this.socket.readyState === 1) {
      try { this.socket.close(); } catch {}
    }
  }

  #onMessage(event) {
    let message;
    try {
      const raw = typeof event.data === 'string' ? event.data : event.data?.toString?.() ?? String(event.data);
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(`CDP ${pending.method} failed (${message.error.code}): ${message.error.message}`);
        error.cdpError = message.error;
        pending.reject(error);
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (!message.method) return;
    const handlers = this.handlers.get(message.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try { handler(message.params ?? {}, message); } catch {}
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket closed unexpectedly'));
    }
    this.pending.clear();
  }

  #onSocketError(event) {
    if (this.closed) return;
    const error = new Error(`CDP WebSocket error: ${event?.message || 'unknown error'}`);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}
