const EventEmitter = require("events");
const WebSocket = require("ws");
const { forwardToTarget } = require("./request-handler");
const {
  FRAME_REQUEST_BODY,
  FRAME_RESPONSE_BODY,
  decodeFrame,
  encodeBody,
  encodeJson,
  register,
  responseFrame,
  heartbeat
} = require("../protocol");

class FrpcClient extends EventEmitter {
  constructor({
    url,
    serviceId,
    token,
    application = "app",
    target,
    maxBodySize = 16 * 1024 * 1024,
    requestTimeout = 30000,
    heartbeatInterval = 15000,
    reconnectDelayMs = 1000
  }) {
    super();
    if (!url || !serviceId || !token || !target) {
      throw new Error("url, serviceId, token and target are required");
    }

    this.url = url;
    this.serviceId = serviceId;
    this.token = token;
    this.application = application;
    this.target = target;
    this.maxBodySize = maxBodySize;
    this.requestTimeout = requestTimeout;
    this.heartbeatInterval = heartbeatInterval;
    this.reconnectDelayMs = reconnectDelayMs;

    this.socket = null;
    this.pending = new Map();
    this.stopping = true;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastMessageAt = Date.now();
  }

  start() {
    this.stopping = false;
    this.attempt = 0;
    this.open();
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.clearPending();
    if (this.socket && this.socket.readyState <= 1) this.socket.terminate();
    this.socket = null;
    this.emit("stopped");
  }

  open() {
    if (this.stopping) return;

    const socket = new WebSocket(this.url, { handshakeTimeout: 10000 });
    this.socket = socket;
    this.lastMessageAt = Date.now();

    const handshakeTimer = setTimeout(() => socket.terminate(), 15000);

    socket.on("open", () => {
      clearTimeout(handshakeTimer);
      this.sendJson(register(this.serviceId, this.token, this.application));
    });

    socket.on("message", data => this.onMessage(data));

    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      if (this.socket === socket) this.socket = null;
      this.clearPending();
      clearInterval(this.heartbeatTimer);
      this.emit("disconnected");
      if (this.stopping) return;

      const delay =
        Math.min(60000, this.reconnectDelayMs * 2 ** this.attempt) + Math.floor(Math.random() * 500);
      this.attempt++;
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    });

    socket.on("error", err => this.emit("error", err));
  }

  onMessage(data) {
    let frame;
    try {
      frame = decodeFrame(data);
    } catch (err) {
      this.emit("error", err);
      return;
    }

    this.lastMessageAt = Date.now();

    if (frame.kind === "json") {
      this.onControl(frame.message);
      return;
    }

    if (frame.type !== FRAME_REQUEST_BODY) return;
    const entry = this.pending.get(frame.requestId);
    if (!entry || entry.body) return;

    entry.chunks.push(frame.body);
    entry.received += frame.body.length;
    if (entry.received >= entry.expected) this.handleRequest(entry);
  }

  onControl(message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "registered") {
      this.attempt = 0;
      this.startHeartbeat();
      this.emit("connected", message);
      return;
    }

    if (message.type === "heartbeat") {
      this.sendJson(heartbeat());
      return;
    }

    if (message.type === "cancel") {
      this.pending.delete(message.requestId);
      return;
    }

    if (message.type === "error") {
      this.emit("error", new Error(`${message.code || "error"}: ${message.message || ""}`));
      return;
    }

    if (message.type !== "request" || !message.requestId) return;

    const expected = Number(message.bodyLength || 0);
    if (expected > this.maxBodySize) {
      this.respond(message.requestId, 413, "Request too large");
      return;
    }

    const entry = {
      requestId: message.requestId,
      method: message.method,
      path: message.path,
      headers: message.headers || {},
      expected,
      chunks: [],
      received: 0,
      body: null
    };
    this.pending.set(message.requestId, entry);

    if (expected === 0) {
      entry.body = Buffer.alloc(0);
      this.handleRequest(entry);
    }
  }

  async handleRequest(entry) {
    this.pending.delete(entry.requestId);
    if (!entry.body) {
      entry.body = Buffer.concat(entry.chunks);
    }

    try {
      const result = await forwardToTarget(
        this.target,
        { ...entry, body: entry.body },
        { maxBodySize: this.maxBodySize, requestTimeout: this.requestTimeout }
      );
      this.sendJson(responseFrame(entry.requestId, result.status, result.headers, result.body.length));
      this.sendBody(entry.requestId, result.body);
      this.emit("request", { requestId: entry.requestId, status: result.status });
    } catch (err) {
      this.respond(entry.requestId, 504, err.message);
    }
  }

  respond(requestId, status, message) {
    const body = Buffer.from(String(message));
    this.sendJson(responseFrame(requestId, status, { "content-type": "text/plain" }, body.length));
    this.sendBody(requestId, body);
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.heartbeatInterval * 3) {
        if (this.socket) this.socket.terminate();
        return;
      }
      this.sendJson(heartbeat());
    }, this.heartbeatInterval);
  }

  clearPending() {
    this.pending.clear();
  }

  sendJson(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(encodeJson(message));
    return true;
  }

  sendBody(requestId, body) {
    if (!this.socket || this.socket.readyState !== 1) return;
    this.socket.send(encodeBody(FRAME_RESPONSE_BODY, requestId, body));
  }
}

module.exports = { FrpcClient };
