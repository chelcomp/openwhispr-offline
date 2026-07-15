// Cloud billing disabled — local-only stub. All users are treated as unlimited Pro.
export interface UseUsageResult {
  isSubscribed: boolean;
  isTrial: boolean;
  isPastDue: boolean;
  isOverLimit: boolean;
  isApproachingLimit: boolean;
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  plan: string;
  billingInterval: null;
  trialDaysLeft: null;
  usageLoaded: boolean;
  hasLoaded: boolean;
  checkoutLoading: boolean;
  openCheckout: (opts?: unknown) => Promise<{ success: boolean }>;
  openBillingPortal: () => Promise<{ success: boolean }>;
  switchPlan: (opts?: unknown) => Promise<{ success: boolean; error?: string }>;
  previewSwitchPlan: (opts?: unknown) => Promise<{ success: boolean; alreadyOnPlan?: boolean; error?: string; immediateAmount?: number; currency?: string; newPriceAmount?: number; newInterval?: string; nextBillingDate?: string | null }>;
}

export function useUsage(): UseUsageResult {
  return {
    isSubscribed: true,
    isTrial: false,
    isPastDue: false,
    isOverLimit: false,
    isApproachingLimit: false,
    wordsUsed: 0,
    wordsRemaining: Infinity,
    limit: Infinity,
    plan: "pro",
    billingInterval: null,
    trialDaysLeft: null,
    usageLoaded: true,
    hasLoaded: true,
    checkoutLoading: false,
    openCheckout: async () => ({ success: false }),
    openBillingPortal: async () => ({ success: false }),
    switchPlan: async () => ({ success: false, error: undefined }),
    previewSwitchPlan: async () => ({ success: false }),
  };
}
