const EventEmitter = require("events");
const { forwardToTarget } = require("./request-handler");

class FrpcClient extends EventEmitter {
  constructor({
    url,
    serviceId,
    token,
    application = "app",
    target,
    maxBodySize = 16 * 1024 * 1024,
    requestTimeout = 30000,
    pollTimeout = 20000,
    pollInterval = 250,
    poolSize = 6,
    reconnectDelayMs = 1000,
    fetchImpl
  }) {
    super();
    if (!url || !serviceId || !token || !target) {
      throw new Error("url, serviceId, token and target are required");
    }

    this.url = String(url).replace(/\/+$/, "");
    this.serviceId = serviceId;
    this.token = token;
    this.application = application;
    this.target = target;
    this.maxBodySize = Math.min(maxBodySize, 6 * 1024 * 1024);
    this.requestTimeout = requestTimeout;
    this.pollTimeout = pollTimeout;
    this.pollInterval = pollInterval;
    this.poolSize = Math.max(1, Math.min(12, Number(poolSize) || 6));
    this.reconnectDelayMs = reconnectDelayMs;
    this.fetch = fetchImpl || fetch;
    this.controllers = new Set();
    this.workers = [];
    this.stopping = true;
    this.connected = false;
    this.attempt = 0;
  }

  start() {
    if (!this.stopping) return;
    this.stopping = false;
    this.attempt = 0;
    this.hello().catch(err => {
      if (!this.stopping) this.emit("error", err);
    });
    this.workers = Array.from({ length: this.poolSize }, (_, index) => this.worker(index));
  }

  async hello() {
    const response = await this.fetch(`${this.url}/_frpc/hello`, {
      method: "GET",
      headers: { "x-stackfrp-token": this.token }
    });
    if (!response.ok) throw new Error(`Handshake failed with ${response.status}`);
    const message = await response.json();
    if (!this.stopping) this.markConnected(message);
  }

  stop() {
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.connected = false;
    this.emit("stopped");
  }

  markConnected(message) {
    this.attempt = 0;
    if (this.connected) return;
    this.connected = true;
    this.emit("connected", {
      status: "polling",
      mode: "pull",
      instanceId: message && message.instanceId,
      serviceId: this.serviceId
    });
  }

  markDisconnected() {
    if (!this.connected) return;
    this.connected = false;
    this.emit("disconnected");
  }

  async worker(index) {
    while (!this.stopping) {
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const response = await this.fetch(
          `${this.url}/_frpc/poll?wait=${this.pollTimeout}`,
          {
            method: "GET",
            headers: { "x-stackfrp-token": this.token },
            signal: controller.signal
          }
        );
        if (!response.ok) throw new Error(`Poll failed with ${response.status}`);
        const message = await response.json();
        this.markConnected(message);
        if (message && message.type === "request") await this.handleRequest(message);
        else if (this.pollInterval) await sleep(this.pollInterval);
      } catch (err) {
        if (this.stopping || controller.signal.aborted) return;
        this.markDisconnected();
        this.emit("error", err);
        const delay =
          Math.min(60000, this.reconnectDelayMs * 2 ** this.attempt) + Math.floor(Math.random() * 500);
        this.attempt++;
        await sleep(delay);
      } finally {
        this.controllers.delete(controller);
      }
    }
  }

  async handleRequest(message) {
    const body = Buffer.from(message.body || "", "base64");
    if (body.length > this.maxBodySize) {
      await this.submitResult(message.requestId, {
        status: 413,
        headers: { "content-type": "text/plain" },
        body: "Request too large"
      });
      return;
    }

    try {
      const result = await forwardToTarget(
        this.target,
        {
          requestId: message.requestId,
          method: message.method,
          path: message.path,
          headers: message.headers || {},
          body
        },
        { maxBodySize: this.maxBodySize, requestTimeout: this.requestTimeout }
      );
      await this.submitResult(message.requestId, {
        status: result.status,
        headers: result.headers,
        body: result.body.toString("base64")
      });
      this.emit("request", { requestId: message.requestId, status: result.status });
    } catch (err) {
      await this.submitResult(message.requestId, {
        status: 504,
        headers: { "content-type": "text/plain" },
        body: Buffer.from(String(err && err.message || err)).toString("base64")
      });
    }
  }

  async submitResult(requestId, result) {
    const response = await this.fetch(`${this.url}/_frpc/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stackfrp-token": this.token
      },
      body: JSON.stringify({ requestId, ...result })
    });
    if (!response.ok) throw new Error(`Result submit failed with ${response.status}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { FrpcClient };
