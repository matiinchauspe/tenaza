import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { liveAnsweredEvent } from "../src/contract/event";
import { writeAlive } from "../src/daemonlink";
import { appendHumanEvent } from "../src/log";
import {
  buildExpiryDenyMessage,
  GENERIC_REJECT_REASON,
  readLiveAnswer,
  waitForLiveAnswer,
} from "../src/live";
import { daemonAlivePath, humanLogPath } from "../src/paths";

describe("readLiveAnswer", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-live-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("undefined while no answer has landed yet", () => {
    expect(readLiveAnswer(home, "abc123")).toBeUndefined();
  });

  test("finds an approve answer by ref, message included", () => {
    appendHumanEvent(home, liveAnsweredEvent("sess-1", "abc123", "approve", "dale"));
    expect(readLiveAnswer(home, "abc123")).toEqual({ answer: "approve", message: "dale" });
  });

  test("finds a reject answer with no message", () => {
    appendHumanEvent(home, liveAnsweredEvent("sess-1", "abc123", "reject"));
    expect(readLiveAnswer(home, "abc123")).toEqual({ answer: "reject", message: undefined });
  });

  test("ignores an answer for a DIFFERENT ref", () => {
    appendHumanEvent(home, liveAnsweredEvent("sess-1", "other-ref", "approve"));
    expect(readLiveAnswer(home, "abc123")).toBeUndefined();
  });

  test("tolerant of a torn line elsewhere in the human log", () => {
    appendHumanEvent(home, liveAnsweredEvent("sess-1", "abc123", "approve"));
    appendFileSync(humanLogPath(home), "{torn\n");
    expect(readLiveAnswer(home, "abc123")).toEqual({ answer: "approve", message: undefined });
  });
});

describe("buildExpiryDenyMessage", () => {
  test("matches the spec's own exact es-AR wording", () => {
    expect(buildExpiryDenyMessage("3a7f")).toBe(
      "nadie respondió; quedó como inbox 3a7f para que el humano lo corra",
    );
  });
});

describe("GENERIC_REJECT_REASON", () => {
  test("is a non-empty, human-readable fallback", () => {
    expect(GENERIC_REJECT_REASON.length).toBeGreaterThan(0);
  });
});

describe("waitForLiveAnswer", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "tenaza-live-wait-"));
    writeAlive(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("resolves 'approved' the moment an approve answer lands, carrying the message", async () => {
    const deadline = Date.now() + 10_000;
    const promise = waitForLiveAnswer(home, "abc123", deadline, 20);
    await Bun.sleep(30);
    appendHumanEvent(home, liveAnsweredEvent("sess-1", "abc123", "approve", "dale"));

    const result = await promise;
    expect(result).toEqual({ kind: "approved", message: "dale" });
  });

  test("resolves 'rejected' the moment a reject answer lands", async () => {
    const deadline = Date.now() + 10_000;
    const promise = waitForLiveAnswer(home, "abc123", deadline, 20);
    await Bun.sleep(30);
    appendHumanEvent(home, liveAnsweredEvent("sess-1", "abc123", "reject", "primero corré los tests"));

    const result = await promise;
    expect(result).toEqual({ kind: "rejected", message: "primero corré los tests" });
  });

  test("resolves 'expired' once the deadline passes with no answer", async () => {
    const deadline = Date.now() + 40;
    const result = await waitForLiveAnswer(home, "abc123", deadline, 20);
    expect(result).toEqual({ kind: "expired" });
  });

  test("resolves 'stale' at once when the heartbeat is already stale when the hold begins", async () => {
    rmSync(daemonAlivePath(home), { force: true });
    const deadline = Date.now() + 10_000;
    const result = await waitForLiveAnswer(home, "abc123", deadline, 20);
    expect(result).toEqual({ kind: "stale" });
  });

  test("resolves 'stale' mid-wait once the heartbeat goes stale, even though the deadline has not passed", async () => {
    const deadline = Date.now() + 10_000;
    const promise = waitForLiveAnswer(home, "abc123", deadline, 20);
    await Bun.sleep(30);
    rmSync(daemonAlivePath(home), { force: true });

    const result = await promise;
    expect(result).toEqual({ kind: "stale" });
  });

  test("an answer that lands exactly at the deadline still wins over expiry", async () => {
    const deadline = Date.now() + 40;
    const promise = waitForLiveAnswer(home, "abc123", deadline, 20);
    await Bun.sleep(35);
    appendHumanEvent(home, liveAnsweredEvent("sess-1", "abc123", "approve"));

    const result = await promise;
    expect(result.kind).toBe("approved");
  });
});
