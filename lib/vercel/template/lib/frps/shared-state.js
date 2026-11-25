const crypto = require("crypto");

const RESPONSE_CHANNEL = "stackedge:frp:responses";
const DEFAULT_PRESENCE_TTL_SECONDS = 60;
const DEFAULT_PRESENCE_REFRESH_MS = 20000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SHARED_BODY = 6 * 1024 * 1024;

function readUpstashConfig(env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: String(url).replace(/\/+$/, ""), token: String(token) };
}

function readRedisUrl(env) {
  const value = env.REDIS_URL || env.REDIS_CONNECTION_STRING || env.STACKEDGE_REDIS_URL;
  return value ? String(value) : null;
}

function requestChannel(serviceId) {
  return `stackedge:frp:requests:${serviceId}`;
}

function presenceKey(serviceId) {
  return `stackedge:frp:tunnel:${serviceId}`;
}

function encodeMessage(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

function decodeMessage(value) {
  try {
    return JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
  } catch {}
  try {
    return JSON.parse(String(value));
  } catch {}
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class SharedTunnelState {
  constructor({
    serviceId,
    env = process.env,
    fetchImpl = fetch,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS,
    maxBodySize = DEFAULT_MAX_SHARED_BODY,
    presenceTtl = DEFAULT_PRESENCE_TTL_SECONDS,
    presenceRefreshMs = DEFAULT_PRESENCE_REFRESH_MS,
    redisClientFactory = null,
    instanceId = null
  } = {}) {
    this.serviceId = serviceId;
    this.config = readUpstashConfig(env);
    this.redisUrl = readRedisUrl(env);
    this.redisClientFactory = redisClientFactory;
    this.backend = this.redisUrl ? "redis-url" : this.config ? "upstash-rest" : "memory";
    this.fetch = fetchImpl;
    this.redisClient = null;
    this.redisClientPromise = null;
    this.redisSubscribers = new Set();
    this.memory = new Map();
    this.requestTimeout = requestTimeout;
    this.maxBodySize = maxBodySize;
    this.presenceTtl = presenceTtl;
    this.presenceRefreshMs = presenceRefreshMs;
    this.instanceId = instanceId || crypto.randomUUID();
    this.requestChannel = requestChannel(serviceId);
    this.presenceKey = presenceKey(serviceId);
    this.enabled = true;
    this.online = false;
    this.pending = new Map();
    this.requestStream = null;
    this.responseStream = null;
    this.presenceTimer = null;
    this.onRequest = null;
  }

  queueKey() {
    return `stackedge:frp:queue:${this.serviceId}`;
  }

  resultKey(requestId) {
    return `stackedge:frp:result:${this.serviceId}:${requestId}`;
  }

  memoryGet(key) {
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  memoryCommand(...args) {
    const [command, key, value, modifier, ttl] = args;
    const op = String(command).toUpperCase();
    if (op === "SET") {
      const expiresAt = String(modifier).toUpperCase() === "EX" ? Date.now() + Number(ttl) * 1000 : null;
      this.memory.set(String(key), { value: String(value), expiresAt });
      return "OK";
    }
    if (op === "GET") return this.memoryGet(String(key));
    if (op === "DEL") return this.memory.delete(String(key)) ? 1 : 0;
    if (op === "EXPIRE") {
      if (!this.memory.has(String(key))) return 0;
      const entry = this.memory.get(String(key));
      entry.expiresAt = Date.now() + Number(value) * 1000;
      return 1;
    }
    if (op === "LPUSH") {
      const list = this.memoryGet(String(key));
      const next = Array.isArray(list) ? list : [];
      next.unshift(String(value));
      this.memory.set(String(key), { value: next, expiresAt: null });
      return next.length;
    }
    if (op === "LPOP") {
      const list = this.memoryGet(String(key));
      if (!Array.isArray(list) || list.length === 0) return null;
      const item = list.shift();
      if (list.length) this.memory.set(String(key), { value: list, expiresAt: null });
      else this.memory.delete(String(key));
      return item;
    }
    throw new Error(`Unsupported memory command ${op}`);
  }

  async getRedisClient() {
    if (!this.redisClientPromise) {
      this.redisClientPromise = (async () => {
        if (!this.redisClient) {
          if (this.redisClientFactory) {
            this.redisClient = this.redisClientFactory({ url: this.redisUrl });
          } else {
            const { createClient } = require("redis");
            this.redisClient = createClient({ url: this.redisUrl });
          }
          if (this.redisClient.on) this.redisClient.on("error", () => {});
        }
        if (!this.redisClient.isOpen) await this.redisClient.connect();
        return this.redisClient;
      })().catch(err => {
        this.redisClientPromise = null;
        throw err;
      });
    }
    return this.redisClientPromise;
  }

  async redisCommand(...args) {
    const client = await this.getRedisClient();
    return client.sendCommand(args.map(arg => String(arg)));
  }

  async redisSubscribe(channel, onMessage, onError) {
    const source = await this.getRedisClient();
    const subscriber = source.duplicate();
    subscriber.on("error", err => {
      if (onError) onError(err);
    });
    await subscriber.connect();
    await subscriber.subscribe(channel, raw => {
      const message = decodeMessage(raw);
      if (message) onMessage(message);
    });

    const entry = {
      closed: () => !subscriber.isOpen,
      close: async () => {
        this.redisSubscribers.delete(entry);
        if (subscriber.isOpen) await subscriber.quit();
      }
    };
    this.redisSubscribers.add(entry);
    return entry;
  }

  async command(...args) {
    if (this.backend === "memory") return this.memoryCommand(...args);
    if (this.backend === "redis-url") return this.redisCommand(...args);
    if (!this.config) throw new Error("Shared tunnel state is not configured");
    const path = args.map(arg => encodeURIComponent(String(arg))).join("/");
    const url = `${this.config.url}/${path}`;
    const response = await this.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.token}` }
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `Shared state command failed with ${response.status}`);
    }
    return payload.result;
  }

  async subscribe(channel, onMessage, onError) {
    if (this.backend === "redis-url") return this.redisSubscribe(channel, onMessage, onError);
    if (!this.config) throw new Error("Shared tunnel state is not configured");
    const controller = new AbortController();
    let closed = false;
    let cancelReader = null;

    const open = async () => {
      const response = await this.fetch(`${this.config.url}/subscribe/${encodeURIComponent(channel)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: "text/event-stream"
        },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Shared state subscribe failed with ${response.status}`);
      if (!response.body) throw new Error("Shared state stream is unavailable");
      return response;
    };

    const consume = async response => {
      const reader = response.body.getReader();
      cancelReader = () => reader.cancel().catch(() => {});
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            const data = line.startsWith("data:") ? line.slice(5).trim() : "";
            if (!data) continue;
            const first = data.indexOf(",");
            if (first === -1) continue;
            const kind = data.slice(0, first);
            const rest = data.slice(first + 1);
            const second = rest.indexOf(",");
            if (kind !== "message" || second === -1) continue;
            const message = decodeMessage(rest.slice(second + 1));
            if (message) await onMessage(message);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    };

    let response = await open();
    const run = async () => {
      while (!closed) {
        try {
          await consume(response);
          if (closed) return;
          response = await open();
        } catch (err) {
          if (closed) return;
          if (onError) onError(err);
          await sleep(1000);
          if (closed) return;
          response = await open();
        }
      }
    };

    const task = run();
    return {
      closed: () => closed,
      close: () => {
        closed = true;
        controller.abort();
        if (cancelReader) cancelReader();
        return task.catch(() => {});
      }
    };
  }

  async enqueueRequest(message) {
    const queue = this.queueKey();
    await this.command("LPUSH", queue, encodeMessage(message));
    await this.command("EXPIRE", queue, String(this.presenceTtl * 2));
  }

  async dequeueRequest() {
    const value = await this.command("LPOP", this.queueKey());
    return value ? decodeMessage(value) : null;
  }

  async setResult(requestId, message) {
    await this.command(
      "SET",
      this.resultKey(requestId),
      encodeMessage(message),
      "EX",
      String(this.presenceTtl * 2)
    );
  }

  async getResult(requestId) {
    const key = this.resultKey(requestId);
    const value = await this.command("GET", key);
    if (!value) return null;
    await this.command("DEL", key);
    return decodeMessage(value);
  }

  async publish(channel, message) {
    return Number(await this.command("PUBLISH", channel, encodeMessage(message)));
  }

  async touch() {
    const value = JSON.stringify({ serviceId: this.serviceId, instanceId: this.instanceId });
    await this.command("SET", this.presenceKey, value, "EX", String(this.presenceTtl));
    this.online = true;
  }

  async isOnline() {
    if (!this.enabled) return false;
    if (this.online && this.requestStream && !this.requestStream.closed()) return true;
    const value = await this.command("GET", this.presenceKey);
    this.online = Boolean(value);
    return this.online;
  }

  async attach(onRequest) {
    if (!this.enabled) return false;
    this.onRequest = onRequest;
    if (this.requestStream && !this.requestStream.closed()) return true;

    this.requestStream = await this.subscribe(
      this.requestChannel,
      async message => {
        if (message.instanceId !== this.instanceId) return;
        await this.handleRequest(message);
      },
      () => {
        this.requestStream = null;
        this.online = false;
        if (this.onRequest) {
          setTimeout(() => {
            this.attach(this.onRequest).catch(() => {});
          }, 1000).unref?.();
        }
      }
    );

    await this.touch();
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(() => {
        this.touch().catch(() => {
          this.online = false;
        });
      }, this.presenceRefreshMs);
      this.presenceTimer.unref?.();
    }
    return true;
  }

  async handleRequest(message) {
    const replyTo = message.replyTo || RESPONSE_CHANNEL;
    try {
      if (!this.onRequest) throw new Error("No FRPC tunnel connected");
      const request = {
        requestId: message.requestId,
        method: message.method,
        path: message.path,
        headers: message.headers || {},
        body: Buffer.from(message.body || "", "base64")
      };
      const result = await this.onRequest(request);
      if (result.body.length > this.maxBodySize) throw new Error("Response too large");
      await this.publish(replyTo, {
        requestId: message.requestId,
        status: result.status || 502,
        headers: result.headers || {},
        body: result.body.toString("base64")
      });
    } catch (err) {
      await this.publish(replyTo, {
        requestId: message.requestId,
        error: String(err && err.message || err)
      }).catch(() => {});
    }
  }

  async ensureResponseStream() {
    if (this.responseStream && !this.responseStream.closed()) return;
    this.responseStream = await this.subscribe(
      RESPONSE_CHANNEL,
      message => {
        const entry = this.pending.get(message.requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.requestId);
        if (message.error) entry.reject(new Error(message.error));
        else {
          entry.resolve({
            status: message.status || 502,
            headers: message.headers || {},
            body: Buffer.from(message.body || "", "base64")
          });
        }
      },
      () => {
        this.responseStream = null;
      }
    );
  }

  async relay(request) {
    if (request.body.length > this.maxBodySize) throw new Error("Request body too large");
    if (!(await this.isOnline())) throw new Error("No FRPC tunnel connected");

    await this.enqueueRequest({
      requestId: request.requestId,
      method: request.method,
      path: request.path,
      headers: request.headers,
      body: request.body.toString("base64")
    });

    const deadline = Date.now() + this.requestTimeout;
    while (Date.now() < deadline) {
      const result = await this.getResult(request.requestId);
      if (result) {
        if (result.error) throw new Error(result.error);
        return {
          status: result.status || 502,
          headers: result.headers || {},
          body: Buffer.from(result.body || "", "base64")
        };
      }
      await sleep(100);
    }
    throw new Error("Tunnel request timed out");
  }

  async close() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.online = false;
    this.onRequest = null;
    if (this.requestStream) await this.requestStream.close();
    if (this.responseStream) await this.responseStream.close();
    this.requestStream = null;
    this.responseStream = null;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    if (this.backend === "redis-url") {
      for (const subscriber of this.redisSubscribers) {
        await subscriber.close().catch(() => {});
      }
      this.redisSubscribers.clear();
      try {
        if (this.redisClient && this.redisClient.isOpen) await this.redisClient.quit();
      } catch {}
      this.redisClient = null;
      this.redisClientPromise = null;
      return;
    }
    if (!this.enabled) return;
    try {
      const value = await this.command("GET", this.presenceKey);
      if (value && JSON.parse(value).instanceId === this.instanceId) {
        await this.command("DEL", this.presenceKey);
      }
    } catch {}
  }
}

function createSharedTunnelState(options) {
  return new SharedTunnelState(options);
}

module.exports = {
  SharedTunnelState,
  createSharedTunnelState,
  RESPONSE_CHANNEL,
  requestChannel,
  presenceKey,
  readUpstashConfig,
  readRedisUrl
};
