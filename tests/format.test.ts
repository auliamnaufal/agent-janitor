import { describe, expect, it } from "vitest";
import { formatBytes, relativeTime } from "../src/util/format.js";

describe("formatBytes", () => {
  it("formats bytes, KB and GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  it("describes age", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 12 * 86_400_000, now)).toBe("12d ago");
  });
});
