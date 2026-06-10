import { describe, expect, it, vi } from "vitest";
import {
  UNDEFINED_GITHUB_AUTH_CLEANUP_CONFIRMATION,
  applyUndefinedGitHubAuthCleanupInternal,
  auditUndefinedGitHubAuthCleanupInternal,
} from "./authIdentityRemediation";

type WrappedHandler<TArgs, TResult> = {
  _handler: (ctx: unknown, args: TArgs) => Promise<TResult>;
};

type CleanupArgs = {
  authAccountId: string;
  userId: string;
  providerAccountId: "undefined";
};

const auditHandler = (
  auditUndefinedGitHubAuthCleanupInternal as unknown as WrappedHandler<CleanupArgs, unknown>
)._handler;
const applyHandler = (
  applyUndefinedGitHubAuthCleanupInternal as unknown as WrappedHandler<
    CleanupArgs & {
      revokeApiTokens: true;
      confirmation: typeof UNDEFINED_GITHUB_AUTH_CLEANUP_CONFIRMATION;
    },
    unknown
  >
)._handler;

function makeQueryBuilder() {
  const fields: Record<string, unknown> = {};
  const q = {
    eq: (field: string, value: unknown) => {
      fields[field] = value;
      return q;
    },
  };
  return { q, fields };
}

function makeCtx() {
  const user = {
    _id: "users:target",
    handle: "fixture-user",
    name: "fixture-user",
    displayName: "Fixture User",
    email: "fixture@example.invalid",
  };
  const targetAccount = {
    _id: "authAccounts:undefined",
    _creationTime: 1,
    provider: "github",
    providerAccountId: "undefined",
    userId: "users:target",
  };
  const numericAccount = {
    _id: "authAccounts:numeric",
    _creationTime: 2,
    provider: "github",
    providerAccountId: "123456",
    userId: "users:target",
  };
  const code = {
    _id: "authVerificationCodes:1",
    _creationTime: 3,
    accountId: "authAccounts:undefined",
    expirationTime: 4,
  };
  const sessionA = {
    _id: "authSessions:1",
    _creationTime: 5,
    userId: "users:target",
    expirationTime: 6,
  };
  const sessionB = {
    _id: "authSessions:2",
    _creationTime: 7,
    userId: "users:target",
    expirationTime: 8,
  };
  const refreshTokens = [
    { _id: "authRefreshTokens:1", sessionId: "authSessions:1" },
    { _id: "authRefreshTokens:2", sessionId: "authSessions:1" },
    { _id: "authRefreshTokens:3", sessionId: "authSessions:2" },
  ];
  const activeToken = {
    _id: "apiTokens:active",
    userId: "users:target",
    label: "Active token",
    prefix: "ch_live_1",
    createdAt: 9,
    lastUsedAt: 10,
    revokedAt: undefined,
  };
  const revokedToken = {
    _id: "apiTokens:revoked",
    userId: "users:target",
    label: "Revoked token",
    prefix: "ch_live_2",
    createdAt: 11,
    lastUsedAt: undefined,
    revokedAt: 12,
  };
  const docs = new Map<string, Record<string, unknown>>([
    [user._id, user],
    [targetAccount._id, targetAccount],
    [numericAccount._id, numericAccount],
    [code._id, code],
    [sessionA._id, sessionA],
    [sessionB._id, sessionB],
    [activeToken._id, activeToken],
    [revokedToken._id, revokedToken],
    ...refreshTokens.map((token) => [token._id, token] as const),
  ]);
  const get = vi.fn(async (id: string) => docs.get(id) ?? null);
  const delete_ = vi.fn(async (id: string) => {
    docs.delete(id);
  });
  const patch = vi.fn(async (id: string, patchValue: Record<string, unknown>) => {
    docs.set(id, { ...docs.get(id), ...patchValue });
  });
  const normalizeId = vi.fn((tableName: string, id: string) =>
    id.startsWith(`${tableName}:`) ? id : null,
  );
  const query = vi.fn((table: string) => ({
    withIndex: vi.fn((_indexName: string, buildQuery: (q: unknown) => unknown) => {
      const { q, fields } = makeQueryBuilder();
      buildQuery(q);
      return {
        collect: vi.fn(async () => {
          if (table === "authAccounts") {
            return [targetAccount, numericAccount].filter(
              (account) =>
                account.userId === fields.userId &&
                (fields.provider === undefined || account.provider === fields.provider),
            );
          }
          if (table === "authVerificationCodes") {
            return fields.accountId === targetAccount._id ? [code] : [];
          }
          if (table === "authSessions") {
            return fields.userId === user._id ? [sessionA, sessionB] : [];
          }
          if (table === "authRefreshTokens") {
            return refreshTokens.filter((token) => token.sessionId === fields.sessionId);
          }
          if (table === "apiTokens") {
            return fields.userId === user._id ? [activeToken, revokedToken] : [];
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      };
    }),
  }));

  return {
    ctx: { db: { get, query, delete: delete_, patch, normalizeId } },
    db: { get, query, delete: delete_, patch, normalizeId },
  };
}

describe("authIdentityRemediation", () => {
  const args: CleanupArgs = {
    authAccountId: "authAccounts:undefined",
    userId: "users:target",
    providerAccountId: "undefined",
  };

  it("audits the invalid GitHub auth account cleanup plan without writes", async () => {
    const { ctx, db } = makeCtx();

    const result = (await auditHandler(ctx, args)) as {
      counts: Record<string, number>;
      invalidGitHubAuthAccountsForUser: Array<Record<string, unknown>>;
      numericGitHubAuthAccountsForUser: Array<Record<string, unknown>>;
    };

    expect(result.counts).toMatchObject({
      targetAuthAccountsToDelete: 1,
      pendingVerificationCodesToDelete: 1,
      sessionsToDelete: 2,
      refreshTokensToDelete: 3,
      activeApiTokensToRevoke: 1,
      alreadyRevokedApiTokens: 1,
    });
    expect(result.invalidGitHubAuthAccountsForUser).toHaveLength(1);
    expect(result.numericGitHubAuthAccountsForUser).toHaveLength(1);
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.patch).not.toHaveBeenCalled();
  });

  it("rejects a target auth account that is not the expected undefined GitHub account", async () => {
    const { ctx } = makeCtx();

    await expect(
      auditHandler(ctx, {
        ...args,
        providerAccountId: "undefined",
        authAccountId: "authAccounts:numeric",
      }),
    ).rejects.toThrow("Target auth account providerAccountId does not match");
  });

  it("applies cleanup and revokes active API tokens conservatively", async () => {
    const { ctx, db } = makeCtx();

    const result = (await applyHandler(ctx, {
      ...args,
      revokeApiTokens: true,
      confirmation: UNDEFINED_GITHUB_AUTH_CLEANUP_CONFIRMATION,
    })) as {
      deleted: Record<string, number>;
      apiTokensRevoked: number;
    };

    expect(result.deleted).toEqual({
      authAccounts: 1,
      authVerificationCodes: 1,
      authSessions: 2,
      authRefreshTokens: 3,
    });
    expect(result.apiTokensRevoked).toBe(1);
    expect(db.delete).toHaveBeenCalledWith("authVerificationCodes:1");
    expect(db.delete).toHaveBeenCalledWith("authRefreshTokens:1");
    expect(db.delete).toHaveBeenCalledWith("authRefreshTokens:2");
    expect(db.delete).toHaveBeenCalledWith("authRefreshTokens:3");
    expect(db.delete).toHaveBeenCalledWith("authSessions:1");
    expect(db.delete).toHaveBeenCalledWith("authSessions:2");
    expect(db.delete).toHaveBeenCalledWith("authAccounts:undefined");
    expect(db.patch).toHaveBeenCalledWith("apiTokens:active", {
      revokedAt: expect.any(Number),
    });
    expect(db.patch).not.toHaveBeenCalledWith("apiTokens:revoked", expect.anything());
  });
});
