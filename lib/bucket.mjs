export function createBucket({ perMinute, burst } = {}, now = 0) {
  const rate = Math.max(1, Number(perMinute) || 1);
  const cap = Math.max(1, Number(burst) || 1);
  return { perMinute: rate, burst: cap, tokens: cap, lastMs: now };
}

function refill(state, now) {
  const elapsed = Math.max(0, now - state.lastMs);
  const tokens = Math.min(state.burst, state.tokens + (elapsed / 60000) * state.perMinute);
  return { ...state, tokens, lastMs: now };
}

export function take(state, now = Date.now()) {
  const filled = refill(state, now);
  if (filled.tokens >= 1) {
    return { waitMs: 0, state: { ...filled, tokens: filled.tokens - 1 } };
  }
  const waitMs = Math.ceil(((1 - filled.tokens) / filled.perMinute) * 60000);
  return { waitMs, state: { ...filled, tokens: 0, lastMs: now + waitMs } };
}

export function peekWait(state, now = Date.now()) {
  return take(state, now).waitMs;
}
