const crypto = require("crypto");

const PROTOCOL_VERSION = 1;
const FRAME_JSON = 1;
const FRAME_REQUEST_BODY = 2;
const FRAME_RESPONSE_BODY = 3;
const REQUEST_ID_BYTES = 16;

function newRequestId() {
  return crypto.randomUUID();
}

function requestIdBuffer(requestId) {
  return Buffer.from(String(requestId).replace(/-/g, ""), "hex");
}

function requestIdString(buffer) {
  const hex = buffer.subarray(0, REQUEST_ID_BYTES).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeJson(message) {
  return Buffer.concat([Buffer.from([FRAME_JSON]), Buffer.from(JSON.stringify(message))]);
}

function encodeBody(type, requestId, body) {
  const id = requestIdBuffer(requestId);
  if (id.length !== REQUEST_ID_BYTES) throw new Error("Invalid request id");
  return Buffer.concat([Buffer.from([type]), id, Buffer.isBuffer(body) ? body : Buffer.from(body || "")]);
}

function decodeFrame(data) {
  const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!frame.length) throw new Error("Empty frame");
  const type = frame[0];

  if (type === FRAME_JSON) {
    return { kind: "json", message: JSON.parse(frame.subarray(1).toString("utf8")) };
  }

  if (type === FRAME_REQUEST_BODY || type === FRAME_RESPONSE_BODY) {
    if (frame.length < 1 + REQUEST_ID_BYTES) throw new Error("Truncated body frame");
    return {
      kind: "body",
      type,
      requestId: requestIdString(frame.subarray(1, 1 + REQUEST_ID_BYTES)),
      body: frame.subarray(1 + REQUEST_ID_BYTES)
    };
  }

  throw new Error(`Unknown frame type: ${type}`);
}

function register(serviceId, token, application) {
  return { type: "register", protocol: PROTOCOL_VERSION, serviceId, token, application };
}

function registered(serviceId) {
  return { type: "registered", protocol: PROTOCOL_VERSION, serviceId };
}

function protocolError(code, message) {
  return { type: "error", code, message };
}

function requestFrame(requestId, method, path, headers, bodyLength) {
  return { type: "request", requestId, method, path, headers, bodyLength };
}

function responseFrame(requestId, status, headers, bodyLength) {
  return { type: "response", requestId, status, headers, bodyLength };
}

function heartbeat(timestamp = Math.floor(Date.now() / 1000)) {
  return { type: "heartbeat", timestamp };
}

function cancel(requestId) {
  return { type: "cancel", requestId };
}

module.exports = {
  PROTOCOL_VERSION,
  FRAME_JSON,
  FRAME_REQUEST_BODY,
  FRAME_RESPONSE_BODY,
  REQUEST_ID_BYTES,
  newRequestId,
  encodeJson,
  encodeBody,
  decodeFrame,
  register,
  registered,
  protocolError,
  requestFrame,
  responseFrame,
  heartbeat,
  cancel
};
