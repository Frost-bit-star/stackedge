const {
  FRAME_REQUEST_BODY,
  FRAME_RESPONSE_BODY,
  decodeFrame,
  encodeBody,
  encodeJson,
  requestFrame,
  heartbeat,
  protocolError,
  cancel
} = require("../shared/protocol");

class TunnelConnection {
  constructor({ serviceId, requestTimeout = 30000, maxBodySize = 16 * 1024 * 1024 }) {
    this.serviceId = serviceId;
    this.requestTimeout = requestTimeout;
    this.maxBodySize = maxBodySize;
    this.socket = null;
    this.pending = new Map();
    this.seenRequests = new Set();
  }

  attach(socket) {
    this.detach();
    this.socket = socket;

    socket.on("message", data => {
      let frame;
      try {
        frame = decodeFrame(data);
      } catch (err) {
        socket.send(encodeJson(protocolError("bad_frame", err.message)));
        return;
      }

      if (frame.kind === "json") this.handleMessage(frame.message);
      else if (frame.type === FRAME_RESPONSE_BODY) this.handleBody(frame);
    });

    socket.on("close", () => this.detach());
    socket.on("error", () => this.detach());
  }

  detach() {
    const socket = this.socket;
    this.socket = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Tunnel disconnected"));
      this.pending.delete(id);
    }
    if (socket && socket.readyState === 1) {
      try {
        socket.close();
      } catch {}
    }
  }

  handleMessage(message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "heartbeat") {
      this.sendJson(heartbeat());
      return;
    }

    if (message.type === "error") return;

    if (message.type !== "response" || !message.requestId) return;

    const entry = this.pending.get(message.requestId);
    if (!entry) return;

    entry.status = message.status || 502;
    entry.headers = message.headers || {};
    entry.expected = Number(message.bodyLength || 0);
    if (entry.expected > this.maxBodySize) {
      clearTimeout(entry.timer);
      this.pending.delete(message.requestId);
      entry.reject(new Error("Response too large"));
      return;
    }

    if (entry.expected === 0) this.finish(message.requestId);
  }

  handleBody(frame) {
    const entry = this.pending.get(frame.requestId);
    if (!entry || entry.result) return;

    entry.chunks.push(frame.body);
    entry.received += frame.body.length;
    if (entry.expected != null && entry.received >= entry.expected) {
      this.finish(frame.requestId);
    }
  }

  finish(requestId) {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.seenRequests.delete(requestId);
    entry.resolve({
      status: entry.status,
      headers: entry.headers,
      body: Buffer.concat(entry.chunks)
    });
  }

  sendJson(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(encodeJson(message));
    return true;
  }

  isConnected() {
    return Boolean(this.socket && this.socket.readyState === 1);
  }

  async relay(request) {
    if (!this.isConnected()) throw new Error("No FRPC tunnel connected");

    const requestId = request.requestId;
    if (this.seenRequests.has(requestId)) throw new Error("Duplicate request id");
    if (request.body.length > this.maxBodySize) throw new Error("Request body too large");
    if (this.socket.bufferedAmount > this.maxBodySize) throw new Error("Tunnel backpressure limit");

    this.seenRequests.add(requestId);

    const result = new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        chunks: [],
        received: 0,
        expected: null,
        status: null,
        headers: {}
      };
      entry.timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.seenRequests.delete(requestId);
        try {
          this.sendJson(cancel(requestId));
        } catch {}
        reject(new Error("Tunnel request timed out"));
      }, this.requestTimeout);
      this.pending.set(requestId, entry);
    });

    this.sendJson(
      requestFrame(requestId, request.method, request.path, request.headers, request.body.length)
    );
    this.socket.send(encodeBody(FRAME_REQUEST_BODY, requestId, request.body));

    return result;
  }
}

module.exports = { TunnelConnection };
