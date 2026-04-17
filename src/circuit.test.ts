import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "./circuit.js";

describe("CircuitBreaker", () => {
  it("trips after the configured number of consecutive failures", async () => {
    const onTrip = vi.fn();
    const breaker = new CircuitBreaker({ enabled: true, threshold: 3, onTrip });
    await breaker.recordFailure();
    await breaker.recordFailure();
    expect(onTrip).not.toHaveBeenCalled();
    await breaker.recordFailure();
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(breaker.isTripped()).toBe(true);
  });

  it("resets the counter on success", async () => {
    const onTrip = vi.fn();
    const breaker = new CircuitBreaker({ enabled: true, threshold: 3, onTrip });
    await breaker.recordFailure();
    await breaker.recordFailure();
    breaker.recordSuccess();
    await breaker.recordFailure();
    await breaker.recordFailure();
    expect(onTrip).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", async () => {
    const onTrip = vi.fn();
    const breaker = new CircuitBreaker({ enabled: false, threshold: 1, onTrip });
    await breaker.recordFailure();
    await breaker.recordFailure();
    expect(onTrip).not.toHaveBeenCalled();
    expect(breaker.isTripped()).toBe(false);
  });

  it("only trips once (repeated failures after trip don't re-fire the hook)", async () => {
    const onTrip = vi.fn();
    const breaker = new CircuitBreaker({ enabled: true, threshold: 1, onTrip });
    await breaker.recordFailure();
    await breaker.recordFailure();
    await breaker.recordFailure();
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it("un-trips on success so status reflects recovery", async () => {
    const onTrip = vi.fn();
    const breaker = new CircuitBreaker({ enabled: true, threshold: 1, onTrip });
    await breaker.recordFailure();
    expect(breaker.isTripped()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.isTripped()).toBe(false);
  });
});
