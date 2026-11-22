import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();
const rulesText = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
const blueprint = JSON.parse(
  fs.readFileSync(path.join(ROOT, "firebase-blueprint.json"), "utf8"),
) as {
  entities: Record<string, { required: string[]; properties: Record<string, unknown> }>;
  firestore: Record<string, { schema: { $ref: string } }>;
};

const VALID_ID = /^[a-zA-Z0-9_-]{1,128}$/;

interface AuthContext {
  uid: string;
  email: string;
  emailVerified: boolean;
  isAdminDoc?: boolean;
}

function isBootstrappedAdmin(auth: AuthContext | null): boolean {
  return Boolean(
    auth &&
      auth.emailVerified &&
      auth.email.toLowerCase() === "enricomigsduran@gmail.com",
  );
}

function isAdmin(auth: AuthContext | null): boolean {
  return isBootstrappedAdmin(auth) || Boolean(auth && auth.emailVerified && auth.isAdminDoc);
}

// Local mirror of firestore.rules invariants to exercise all Dirty Dozen payloads
function evaluateProfileAccess(
  op: "get" | "list" | "create" | "update",
  auth: AuthContext | null,
  userId: string,
  incoming?: Record<string, unknown>,
  existing?: Record<string, unknown>,
  serverTime = 1000,
): boolean {
  if (op === "list") return false;
  if (!auth || !auth.emailVerified || !VALID_ID.test(userId) || auth.uid !== userId) {
    return false;
  }
  if (op === "get") return true;
  if (!incoming) return false;

  const expectedKeys = ["uid", "displayName", "email", "createdAt", "updatedAt"];
  const keys = Object.keys(incoming);
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((k) => k in incoming)
  ) {
    return false;
  }
  if (
    typeof incoming.uid !== "string" ||
    !VALID_ID.test(incoming.uid) ||
    incoming.uid !== auth.uid ||
    incoming.uid !== userId
  ) {
    return false;
  }
  if (
    typeof incoming.displayName !== "string" ||
    incoming.displayName.length < 1 ||
    incoming.displayName.length > 80
  ) {
    return false;
  }
  if (
    typeof incoming.email !== "string" ||
    incoming.email.length < 3 ||
    incoming.email.length > 254 ||
    incoming.email !== auth.email
  ) {
    return false;
  }

  if (op === "create") {
    return incoming.createdAt === serverTime && incoming.updatedAt === serverTime;
  }
  if (!existing) return false;
  if (incoming.uid !== existing.uid || incoming.createdAt !== existing.createdAt) {
    return false;
  }
  if (incoming.updatedAt !== serverTime) return false;

  const allowedUpdateKeys = new Set(["displayName", "email", "updatedAt"]);
  for (const key of new Set([...Object.keys(incoming), ...Object.keys(existing)])) {
    if (incoming[key] !== existing[key] && !allowedUpdateKeys.has(key)) {
      return false;
    }
  }
  return true;
}

function evaluatePreferencesWrite(
  auth: AuthContext | null,
  userId: string,
  incoming: Record<string, unknown>,
  serverTime = 1000,
): boolean {
  if (!auth || !auth.emailVerified || !VALID_ID.test(userId) || auth.uid !== userId) {
    return false;
  }
  const expectedKeys = [
    "uid",
    "program",
    "city",
    "sector",
    "budget",
    "budgetBasis",
    "weights",
    "updatedAt",
  ];
  if (
    Object.keys(incoming).length !== expectedKeys.length ||
    !expectedKeys.every((k) => k in incoming)
  ) {
    return false;
  }
  if (incoming.uid !== auth.uid || incoming.uid !== userId) return false;
  if (typeof incoming.program !== "string" || incoming.program.length > 200) return false;
  if (typeof incoming.city !== "string" || incoming.city.length > 200) return false;
  if (!["", "Public", "Private"].includes(String(incoming.sector))) return false;
  if (
    incoming.budget !== null &&
    (typeof incoming.budget !== "number" ||
      !Number.isFinite(incoming.budget) ||
      incoming.budget < 0 ||
      incoming.budget > 10_000_000)
  ) {
    return false;
  }
  if (!["semester", "trimester", "year", "unit"].includes(String(incoming.budgetBasis))) {
    return false;
  }
  const w = incoming.weights as Record<string, unknown> | undefined;
  const wKeys = ["program", "location", "budget", "sector"];
  if (
    !w ||
    typeof w !== "object" ||
    Object.keys(w).length !== 4 ||
    !wKeys.every(
      (k) => typeof w[k] === "number" && (w[k] as number) >= 0 && (w[k] as number) <= 1,
    )
  ) {
    return false;
  }
  return incoming.updatedAt === serverTime;
}

function evaluateShortlistWrite(
  auth: AuthContext | null,
  userId: string,
  incoming: Record<string, unknown>,
  serverTime = 1000,
): boolean {
  if (!auth || !auth.emailVerified || !VALID_ID.test(userId) || auth.uid !== userId) {
    return false;
  }
  const expectedKeys = ["uid", "savedIds", "compareIds", "updatedAt"];
  if (
    Object.keys(incoming).length !== expectedKeys.length ||
    !expectedKeys.every((k) => k in incoming)
  ) {
    return false;
  }
  if (incoming.uid !== auth.uid || incoming.uid !== userId) return false;
  const checkList = (arr: unknown, max: number) =>
    Array.isArray(arr) &&
    arr.length <= max &&
    (arr.length === 0 ||
      (typeof arr[0] === "string" &&
        VALID_ID.test(arr[0]) &&
        typeof arr[arr.length - 1] === "string" &&
        VALID_ID.test(arr[arr.length - 1])));
  if (!checkList(incoming.savedIds, 50)) return false;
  if (!checkList(incoming.compareIds, 3)) return false;
  return incoming.updatedAt === serverTime;
}

function evaluateCatalogWrite(
  op: "create" | "update" | "delete",
  auth: AuthContext | null,
  universityId: string,
  incoming?: Record<string, unknown>,
  existing?: Record<string, unknown>,
  serverTime = 1000,
): boolean {
  if (!auth || !auth.emailVerified || !VALID_ID.test(universityId) || !isAdmin(auth)) {
    return false;
  }
  if (op === "delete") return true;
  if (!incoming) return false;
  if (incoming.id !== universityId || incoming.updatedByUid !== auth.uid) return false;
  if (!["Public", "Private"].includes(String(incoming.sector))) return false;
  if (!["green", "maroon", "gold", "rust", "lilac"].includes(String(incoming.color))) return false;
  if (!["pending", "partial", "verified"].includes(String(incoming.collectionStatus))) return false;
  if (typeof incoming.officialUrl !== "string") return false;
  if (incoming.officialUrl !== "" && !incoming.officialUrl.startsWith("https://")) return false;
  if (op === "create") {
    return incoming.createdAt === serverTime && incoming.updatedAt === serverTime;
  }
  if (!existing) return false;
  return (
    incoming.id === existing.id &&
    incoming.createdAt === existing.createdAt &&
    incoming.updatedAt === serverTime
  );
}

describe("firestore.rules static & blueprint verification", () => {
  it("enforces global default deny and covers every blueprint path without blanket reads", () => {
    assert.ok(rulesText.includes("match /{document=**}"));
    assert.ok(rulesText.includes("allow read, write: if false;"));
    assert.equal(/\ballow\s+read\s*:\s*if\s+true\b/.test(rulesText), false);
    assert.equal(/\ballow\s+list\s*:\s*if\s+true\b/.test(rulesText), false);
    assert.equal(/\ballow\s+list\s*:\s*if\s+isSignedIn\(\)\s*;/.test(rulesText), false);

    for (const collectionPath of Object.keys(blueprint.firestore)) {
      assert.ok(
        rulesText.includes(`match ${collectionPath}`),
        `Missing match block for ${collectionPath}`,
      );
    }
  });

  it("enforces email verification, temporal integrity, schema whitelist, admin gates, and action updates", () => {
    assert.ok(rulesText.includes("request.auth.token.email_verified == true"));
    assert.ok(rulesText.includes("incoming().createdAt == request.time"));
    assert.ok(rulesText.includes("incoming().updatedAt == request.time"));
    assert.ok(rulesText.includes("incoming().createdAt == existing().createdAt"));
    assert.ok(rulesText.includes("incoming().diff(existing()).affectedKeys().hasOnly"));
    assert.ok(rulesText.includes("resource.data.isPublished == true"));
    assert.ok(rulesText.includes("isBootstrappedAdmin()"));
  });
});

describe("Dirty Dozen adversarial payload checks", () => {
  const uid1: AuthContext = {
    uid: "uid1",
    email: "student1@example.edu.ph",
    emailVerified: true,
  };
  const uid2: AuthContext = {
    uid: "uid2",
    email: "student2@example.edu.ph",
    emailVerified: true,
  };
  const unverified: AuthContext = {
    uid: "uid1",
    email: "student1@example.edu.ph",
    emailVerified: false,
  };
  const spoofedAdmin: AuthContext = {
    uid: "uid99",
    email: "Enricomigsduran@gmail.com",
    emailVerified: false,
  };
  const realAdmin: AuthContext = {
    uid: "admin1",
    email: "Enricomigsduran@gmail.com",
    emailVerified: true,
  };

  it("blocks all adversarial student & admin payloads and allows valid writes", () => {
    // 1. Unauthenticated read
    assert.equal(evaluateProfileAccess("get", null, "uid1"), false);
    // 2. Cross-user PII read
    assert.equal(evaluateProfileAccess("get", uid2, "uid1"), false);
    // 3. Unverified email write
    assert.equal(
      evaluateProfileAccess("create", unverified, "uid1", {
        uid: "uid1",
        displayName: "Ana",
        email: "student1@example.edu.ph",
        createdAt: 1000,
        updatedAt: 1000,
      }),
      false,
    );
    // 4. Shadow field injection (role escalation)
    assert.equal(
      evaluateProfileAccess("create", uid1, "uid1", {
        uid: "uid1",
        displayName: "Ana",
        email: "student1@example.edu.ph",
        createdAt: 1000,
        updatedAt: 1000,
        role: "admin",
      }),
      false,
    );
    // 5. Identity spoofing on create
    assert.equal(
      evaluatePreferencesWrite(uid1, "uid1", {
        uid: "uid2",
        program: "CS",
        city: "Manila",
        sector: "Public",
        budget: 20000,
        budgetBasis: "semester",
        weights: { program: 0.45, location: 0.2, budget: 0.2, sector: 0.15 },
        updatedAt: 1000,
      }),
      false,
    );
    // 6. Immutable field tampering on update
    const existingProfile = {
      uid: "uid1",
      displayName: "Ana",
      email: "student1@example.edu.ph",
      createdAt: 900,
      updatedAt: 900,
    };
    assert.equal(
      evaluateProfileAccess(
        "update",
        uid1,
        "uid1",
        { ...existingProfile, createdAt: 1000, updatedAt: 1000 },
        existingProfile,
        1000,
      ),
      false,
    );
    // 7. Client-forged timestamp
    assert.equal(
      evaluatePreferencesWrite(
        uid1,
        "uid1",
        {
          uid: "uid1",
          program: "CS",
          city: "Manila",
          sector: "Public",
          budget: 20000,
          budgetBasis: "semester",
          weights: { program: 0.45, location: 0.2, budget: 0.2, sector: 0.15 },
          updatedAt: 500,
        },
        1000,
      ),
      false,
    );
    // 8. Path ID poisoning
    assert.equal(evaluateProfileAccess("get", uid1, "../../admin"), false);
    // 9. Oversized string (Denial of Wallet)
    assert.equal(
      evaluatePreferencesWrite(uid1, "uid1", {
        uid: "uid1",
        program: "A".repeat(5000),
        city: "Manila",
        sector: "Public",
        budget: 20000,
        budgetBasis: "semester",
        weights: { program: 0.45, location: 0.2, budget: 0.2, sector: 0.15 },
        updatedAt: 1000,
      }),
      false,
    );
    // 10. Invalid enum / value poisoning
    assert.equal(
      evaluatePreferencesWrite(uid1, "uid1", {
        uid: "uid1",
        program: "CS",
        city: "Manila",
        sector: "Hacked",
        budget: -500,
        budgetBasis: "semester",
        weights: { program: 0.45, location: 0.2, budget: 0.2, sector: 0.15 },
        updatedAt: 1000,
      }),
      false,
    );
    // 11. Unbounded array injection
    assert.equal(
      evaluateShortlistWrite(uid1, "uid1", {
        uid: "uid1",
        savedIds: ["pup"],
        compareIds: ["pup", "dlsu", "ust", "up"],
        updatedAt: 1000,
      }),
      false,
    );
    // 12. Blanket collection listing
    assert.equal(evaluateProfileAccess("list", uid1, "uid1"), false);
    // 13. Non-admin catalog mutation & unverified admin email spoofing
    const catalogPayload = {
      id: "dlsu-manila",
      sector: "Private",
      color: "green",
      collectionStatus: "verified",
      officialUrl: "https://www.dlsu.edu.ph/",
      updatedByUid: "uid1",
      createdAt: 1000,
      updatedAt: 1000,
    };
    assert.equal(evaluateCatalogWrite("create", uid1, "dlsu-manila", catalogPayload), false);
    assert.equal(
      evaluateCatalogWrite("create", spoofedAdmin, "dlsu-manila", {
        ...catalogPayload,
        updatedByUid: "uid99",
      }),
      false,
    );
    // 14. Unsafe http/javascript officialUrl in catalog
    assert.equal(
      evaluateCatalogWrite("create", realAdmin, "dlsu-manila", {
        ...catalogPayload,
        officialUrl: "javascript:alert(1)",
        updatedByUid: "admin1",
      }),
      false,
    );

    // Positive valid cases
    assert.equal(
      evaluateProfileAccess("create", uid1, "uid1", {
        uid: "uid1",
        displayName: "Ana Santos",
        email: "student1@example.edu.ph",
        createdAt: 1000,
        updatedAt: 1000,
      }),
      true,
    );
    assert.equal(
      evaluateShortlistWrite(uid1, "uid1", {
        uid: "uid1",
        savedIds: ["pup-sta-mesa", "dlsu-manila"],
        compareIds: ["pup-sta-mesa", "dlsu-manila"],
        updatedAt: 1000,
      }),
      true,
    );
    assert.equal(
      evaluateCatalogWrite("create", realAdmin, "dlsu-manila", {
        ...catalogPayload,
        updatedByUid: "admin1",
      }),
      true,
    );
  });
});
