export class HumanWarn extends Error {
  constructor(payload = {}) {
    super(payload.message || `human-input paused: ${payload.trigger || "warning"}`);
    this.name = "HumanWarn";
    this.payload = payload;
  }
}

export class HumanBlocked extends Error {
  constructor(payload = {}) {
    super(payload.message || `human-input halted: ${payload.trigger || "blocked"}`);
    this.name = "HumanBlocked";
    this.payload = payload;
  }
}
