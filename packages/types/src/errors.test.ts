import { describe, expect, it } from "vitest";
import {
  AART_ERROR_CLASSES,
  AartError,
  CapabilityDeniedError,
  ConcurrencyRejectedError,
  CorrelationError,
  HttpClientError,
  HttpServerError,
  IterationLimitExceededError,
  PackHashMismatchError,
  SecretResolutionError,
  TimeoutError,
  ValidationError,
} from "./errors.js";

describe("AartError hierarchy (architecture §8, 10 subclasses)", () => {
  it("declares exactly the 10 named subclasses", () => {
    expect(AART_ERROR_CLASSES).toHaveLength(10);
  });

  it.each(AART_ERROR_CLASSES)("%s is instantiable, extends AartError, and self-reports its errorClass", (ErrorClass) => {
    const err = new ErrorClass({ message: "boom", detail: { foo: "bar" } });
    expect(err).toBeInstanceOf(AartError);
    expect(err).toBeInstanceOf(Error);
    expect(err.errorClass).toBe(ErrorClass.name);
    expect(err.name).toBe(ErrorClass.name);
    expect(err.message).toBe("boom");
    expect(err.detail).toEqual({ foo: "bar" });
  });

  it.each(AART_ERROR_CLASSES)("%s.toJSON() produces a stable, serializable shape for StepTrace.error / ModelFacingReport.failures[]", (ErrorClass) => {
    const err = new ErrorClass({ message: "boom" });
    expect(err.toJSON()).toEqual({ errorClass: ErrorClass.name, message: "boom", detail: undefined });
  });

  it("preserves a `cause` chain when provided", () => {
    const cause = new Error("root cause");
    const err = new TimeoutError({ message: "step timed out", cause });
    expect(err.cause).toBe(cause);
  });

  it("supports instanceof narrowing per concrete subclass, useful for engine retry matching (architecture micro-decision #9)", () => {
    const err: AartError = new HttpServerError({ message: "502" });
    expect(err instanceof HttpServerError).toBe(true);
    expect(err instanceof HttpClientError).toBe(false);
  });

  it("every errorClass string is unique across the taxonomy", () => {
    const classes = AART_ERROR_CLASSES.map((C) => new C({ message: "x" }).errorClass);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it("covers the specific classes named in architecture §8's enumeration", () => {
    expect(AART_ERROR_CLASSES).toContain(ValidationError);
    expect(AART_ERROR_CLASSES).toContain(CapabilityDeniedError);
    expect(AART_ERROR_CLASSES).toContain(TimeoutError);
    expect(AART_ERROR_CLASSES).toContain(HttpClientError);
    expect(AART_ERROR_CLASSES).toContain(HttpServerError);
    expect(AART_ERROR_CLASSES).toContain(IterationLimitExceededError);
    expect(AART_ERROR_CLASSES).toContain(CorrelationError);
    expect(AART_ERROR_CLASSES).toContain(SecretResolutionError);
    expect(AART_ERROR_CLASSES).toContain(PackHashMismatchError);
    expect(AART_ERROR_CLASSES).toContain(ConcurrencyRejectedError);
  });
});
