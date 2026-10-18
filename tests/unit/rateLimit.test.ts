import { describe, expect, it } from "vitest";
import { consumeUsage, type RpcClient } from "@/lib/rateLimit";

const client = (impl: () => Promise<{ data: unknown; error: unknown }>): RpcClient => ({ rpc: () => impl() });

describe("consumeUsage(): any error is a denial", () => {
  it("allows only when the function returns true", async () => {
    expect(await consumeUsage(client(async () => ({ data: true, error: null })), "extraction")).toBe(true);
    expect(await consumeUsage(client(async () => ({ data: false, error: null })), "extraction")).toBe(false);
  });

  it("denies on an error result, a thrown error, or an unexpected value", async () => {
    expect(await consumeUsage(client(async () => ({ data: true, error: { message: "x" } })), "ask")).toBe(false);
    expect(await consumeUsage(client(async () => Promise.reject(new Error("down"))), "ask")).toBe(false);
    expect(await consumeUsage(client(async () => ({ data: "true", error: null })), "ask")).toBe(false);
  });
});
