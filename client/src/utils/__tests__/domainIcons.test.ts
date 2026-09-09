import { describe, expect, it } from "vitest";
import { organizationForEmail } from "../domainIcons";

describe("organizationForEmail", () => {
  it.each([
    ["analyst@databricks.com", "Databricks"],
    ["leader@take2games.com", "Take-Two Interactive Software"],
    ["player@2k.com", "2K"],
    ["builder@zynga.com", "Zynga"],
    ["james@demonware.net", "Demonware"],
  ])("maps %s to %s", (email, organizationName) => {
    expect(organizationForEmail(email).name).toBe(organizationName);
  });

  it("uses the Activision mark for Demonware identities", () => {
    expect(organizationForEmail("james@demonware.net").icon).toMatchObject({
      src: "/brand/domain-icons/activision.svg",
      background: "#000000",
    });
  });

  it("labels unknown domains without assigning another company's name", () => {
    expect(organizationForEmail("person@example.com")).toMatchObject({
      id: "domain:example.com",
      name: "example.com",
      icon: null,
    });
  });
});
