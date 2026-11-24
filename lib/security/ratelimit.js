function createLimiter(settings) {
  const hits = new Map();
  const blocked = new Map();

  return function allow(key) {
    if (!settings.rateLimit.enabled) return true;

    const now = Date.now();
    const until = blocked.get(key) || 0;
    if (until > now) return false;
    if (until && until <= now) blocked.delete(key);

    const windowMs = settings.rateLimit.window * 1000;
    if (hits.size > 10000) {
      for (const [id, times] of hits) {
        if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(id);
      }
    }

    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= settings.rateLimit.requests) {
      if (settings.rateLimit.blockDuration > 0) {
        blocked.set(key, now + settings.rateLimit.blockDuration * 1000);
      }
      hits.set(key, recent);
      return false;
    }

    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

module.exports = { createLimiter };
