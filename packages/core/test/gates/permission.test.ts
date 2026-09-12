import { describe, it, expect } from "vitest";
import { isPermitted, aclUnion } from "../../src/gates/permission.js";
import { makeObject } from "../../src/testing/fixtures.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

const strict = DEFAULT_CONFIG;
const tenantOnly = { ...DEFAULT_CONFIG, acl_mode: "tenant_only" as const };

describe("aclUnion", () => {
  it("deduplicates and sorts tags across every evidence item", () => {
    expect(
      aclUnion([{ acl: ["group:b", "group:a"] }, { acl: ["group:a", "group:c"] }]),
    ).toEqual(["group:a", "group:b", "group:c"]);
  });

  it("returns an empty union for evidence with no tags", () => {
    expect(aclUnion([{ acl: [] }, { acl: [] }])).toEqual([]);
  });
});

describe("isPermitted (strict)", () => {
  it("permits a caller holding every required tag", () => {
    const obj = makeObject({ acl: ["group:support"], acl_complete: true });
    expect(isPermitted({ object: obj, granted: ["group:support", "group:eng"], config: strict }).pass)
      .toBe(true);
  });

  it("refuses a caller missing even one tag", () => {
    const obj = makeObject({ acl: ["group:support", "group:finance"], acl_complete: true });
    const result = isPermitted({ object: obj, granted: ["group:support"], config: strict });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("group:finance");
  });

  it("permits an object built entirely from untagged evidence", () => {
    const obj = makeObject({ acl: [], acl_complete: true });
    expect(isPermitted({ object: obj, granted: [], config: strict }).pass).toBe(true);
  });

  it("refuses any object whose ACLs the index could not report", () => {
    const obj = makeObject({ acl: [], acl_complete: false });
    const result = isPermitted({ object: obj, granted: ["group:support"], config: strict });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/acl_complete/);
  });
});

describe("isPermitted (tenant_only)", () => {
  it("permits regardless of tags, because the operator opted out explicitly", () => {
    const obj = makeObject({ acl: ["group:finance"], acl_complete: false });
    expect(isPermitted({ object: obj, granted: [], config: tenantOnly }).pass).toBe(true);
  });
});
