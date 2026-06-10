import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./functions";

export const UNDEFINED_GITHUB_AUTH_CLEANUP_CONFIRMATION =
  "delete-undefined-github-auth-account-and-expire-credentials";

type CleanupPlan = {
  targetAccount: {
    authAccountId: Id<"authAccounts">;
    userId: Id<"users">;
    providerAccountId: string;
    createdAt: number;
  } | null;
  user: {
    userId: Id<"users">;
    handle: string | null;
    name: string | null;
    displayName: string | null;
    emailPresent: boolean;
    deletedAt: number | null;
    deactivatedAt: number | null;
    purgedAt: number | null;
  } | null;
  invalidGitHubAuthAccountsForUser: Array<{
    authAccountId: Id<"authAccounts">;
    providerAccountId: string;
    createdAt: number;
  }>;
  numericGitHubAuthAccountsForUser: Array<{
    authAccountId: Id<"authAccounts">;
    providerAccountId: string;
    createdAt: number;
  }>;
  pendingVerificationCodes: Array<{
    verificationCodeId: Id<"authVerificationCodes">;
    authAccountId: Id<"authAccounts">;
    createdAt: number;
    expirationTime: number;
  }>;
  sessions: Array<{
    sessionId: Id<"authSessions">;
    createdAt: number;
    expirationTime: number;
    refreshTokenCount: number;
  }>;
  apiTokens: Array<{
    tokenId: Id<"apiTokens">;
    label: string;
    prefix: string;
    createdAt: number;
    lastUsedAt: number | null;
    revokedAt: number | null;
  }>;
  counts: {
    targetAuthAccountsToDelete: number;
    pendingVerificationCodesToDelete: number;
    sessionsToDelete: number;
    refreshTokensToDelete: number;
    activeApiTokensToRevoke: number;
    alreadyRevokedApiTokens: number;
  };
};

type CleanupResult = CleanupPlan & {
  applied: boolean;
  revokedApiTokens: boolean;
  deleted: {
    authAccounts: number;
    authVerificationCodes: number;
    authSessions: number;
    authRefreshTokens: number;
  };
  apiTokensRevoked: number;
};

function isNumericGitHubProviderAccountId(providerAccountId: string) {
  return /^\d+$/.test(providerAccountId);
}

async function collectUndefinedGitHubAuthCleanupPlan(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  args: {
    authAccountId: Id<"authAccounts">;
    userId: Id<"users">;
    providerAccountId: "undefined";
  },
): Promise<CleanupPlan> {
  const user = await ctx.db.get(args.userId);
  const targetAccount = await ctx.db.get(args.authAccountId);

  if (targetAccount) {
    if (targetAccount.provider !== "github") {
      throw new Error("Target auth account is not a GitHub auth account");
    }
    if (targetAccount.providerAccountId !== args.providerAccountId) {
      throw new Error("Target auth account providerAccountId does not match");
    }
    if (targetAccount.userId !== args.userId) {
      throw new Error("Target auth account userId does not match");
    }
  }

  const githubAccounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", args.userId).eq("provider", "github"))
    .collect();
  const invalidGitHubAuthAccountsForUser = githubAccounts
    .filter((account) => !isNumericGitHubProviderAccountId(account.providerAccountId))
    .map((account) => ({
      authAccountId: account._id,
      providerAccountId: account.providerAccountId,
      createdAt: account._creationTime,
    }));
  const numericGitHubAuthAccountsForUser = githubAccounts
    .filter((account) => isNumericGitHubProviderAccountId(account.providerAccountId))
    .map((account) => ({
      authAccountId: account._id,
      providerAccountId: account.providerAccountId,
      createdAt: account._creationTime,
    }));

  const pendingVerificationCodes = targetAccount
    ? (
        await ctx.db
          .query("authVerificationCodes")
          .withIndex("accountId", (q) => q.eq("accountId", targetAccount._id))
          .collect()
      ).map((code) => ({
        verificationCodeId: code._id,
        authAccountId: targetAccount._id,
        createdAt: code._creationTime,
        expirationTime: code.expirationTime,
      }))
    : [];

  const sessionsRaw = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", args.userId))
    .collect();
  const sessions = [];
  let refreshTokensToDelete = 0;
  for (const session of sessionsRaw) {
    const refreshTokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    refreshTokensToDelete += refreshTokens.length;
    sessions.push({
      sessionId: session._id,
      createdAt: session._creationTime,
      expirationTime: session.expirationTime,
      refreshTokenCount: refreshTokens.length,
    });
  }

  const apiTokens = (
    await ctx.db
      .query("apiTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect()
  ).map((token) => ({
    tokenId: token._id,
    label: token.label,
    prefix: token.prefix,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt ?? null,
    revokedAt: token.revokedAt ?? null,
  }));

  return {
    targetAccount: targetAccount
      ? {
          authAccountId: targetAccount._id,
          userId: targetAccount.userId,
          providerAccountId: targetAccount.providerAccountId,
          createdAt: targetAccount._creationTime,
        }
      : null,
    user: user
      ? {
          userId: user._id,
          handle: user.handle ?? null,
          name: user.name ?? null,
          displayName: user.displayName ?? null,
          emailPresent: typeof user.email === "string",
          deletedAt: user.deletedAt ?? null,
          deactivatedAt: user.deactivatedAt ?? null,
          purgedAt: user.purgedAt ?? null,
        }
      : null,
    invalidGitHubAuthAccountsForUser,
    numericGitHubAuthAccountsForUser,
    pendingVerificationCodes,
    sessions,
    apiTokens,
    counts: {
      targetAuthAccountsToDelete: targetAccount ? 1 : 0,
      pendingVerificationCodesToDelete: pendingVerificationCodes.length,
      sessionsToDelete: sessions.length,
      refreshTokensToDelete,
      activeApiTokensToRevoke: apiTokens.filter((token) => token.revokedAt === null).length,
      alreadyRevokedApiTokens: apiTokens.filter((token) => token.revokedAt !== null).length,
    },
  };
}

export const auditUndefinedGitHubAuthCleanupInternal = internalQuery({
  args: {
    authAccountId: v.id("authAccounts"),
    userId: v.id("users"),
    providerAccountId: v.literal("undefined"),
  },
  handler: async (ctx, args): Promise<CleanupPlan> => {
    return await collectUndefinedGitHubAuthCleanupPlan(ctx, args);
  },
});

export const applyUndefinedGitHubAuthCleanupInternal = internalMutation({
  args: {
    authAccountId: v.id("authAccounts"),
    userId: v.id("users"),
    providerAccountId: v.literal("undefined"),
    revokeApiTokens: v.literal(true),
    confirmation: v.literal(UNDEFINED_GITHUB_AUTH_CLEANUP_CONFIRMATION),
  },
  handler: async (ctx, args): Promise<CleanupResult> => {
    const plan = await collectUndefinedGitHubAuthCleanupPlan(ctx, args);
    const now = Date.now();

    let deletedVerificationCodes = 0;
    for (const code of plan.pendingVerificationCodes) {
      await ctx.db.delete(code.verificationCodeId);
      deletedVerificationCodes += 1;
    }

    let deletedRefreshTokens = 0;
    for (const session of plan.sessions) {
      const refreshTokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", session.sessionId))
        .collect();
      for (const refreshToken of refreshTokens) {
        await ctx.db.delete(refreshToken._id);
        deletedRefreshTokens += 1;
      }
      await ctx.db.delete(session.sessionId);
    }

    let apiTokensRevoked = 0;
    for (const token of plan.apiTokens) {
      if (token.revokedAt !== null) continue;
      await ctx.db.patch(token.tokenId, { revokedAt: now });
      apiTokensRevoked += 1;
    }

    let deletedAuthAccounts = 0;
    if (plan.targetAccount) {
      await ctx.db.delete(plan.targetAccount.authAccountId);
      deletedAuthAccounts = 1;
    }

    return {
      ...plan,
      applied: true,
      revokedApiTokens: true,
      deleted: {
        authAccounts: deletedAuthAccounts,
        authVerificationCodes: deletedVerificationCodes,
        authSessions: plan.sessions.length,
        authRefreshTokens: deletedRefreshTokens,
      },
      apiTokensRevoked,
    };
  },
});
