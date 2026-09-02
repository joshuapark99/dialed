export interface ApiRateLimitRule {
  max: number;
  timeWindow: number;
  groupId: string;
}

export interface ApiRateLimitPolicy {
  me: ApiRateLimitRule;
  syncPush: ApiRateLimitRule;
  syncPull: ApiRateLimitRule;
  accountExport: ApiRateLimitRule;
  accountDelete: ApiRateLimitRule;
}

export const defaultApiRateLimits: ApiRateLimitPolicy = {
  me: { max: 120, timeWindow: 60_000, groupId: "me" },
  syncPush: { max: 30, timeWindow: 60_000, groupId: "sync-push" },
  syncPull: { max: 120, timeWindow: 60_000, groupId: "sync-pull" },
  accountExport: {
    max: 5,
    timeWindow: 3_600_000,
    groupId: "account-export",
  },
  accountDelete: {
    max: 5,
    timeWindow: 3_600_000,
    groupId: "account-delete",
  },
};
