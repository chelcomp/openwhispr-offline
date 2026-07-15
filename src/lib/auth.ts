// Cloud auth disabled — local-only stub
export const AUTH_URL = "";

export const authClient = {
  signOut: async () => {},
  signIn: {
    social: async (_opts: unknown) => {},
    sso: async (_opts: unknown) => {},
  },
  requestPasswordReset: async (_opts: unknown) => {},
  useSession: () => ({ data: null, isPending: false, error: null, refetch: async () => null }),
};

export type SocialProvider = "google" | "microsoft" | "apple";

export function updateLastSignInTime(): void {}

export function isWithinGracePeriod(): boolean {
  return false;
}

export async function deleteAccount(): Promise<{ error?: Error }> {
  return { error: new Error("cloud disabled") };
}

export async function signOut(): Promise<void> {}

export async function withSessionRefresh<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

export async function signInWithSocial(_provider: SocialProvider): Promise<{ error?: Error }> {
  return { error: new Error("cloud disabled") };
}

export async function signInWithSSO(_email: string): Promise<{ error?: Error }> {
  return { error: new Error("cloud disabled") };
}

export async function requestPasswordReset(_email: string): Promise<{ error?: Error }> {
  return { error: new Error("cloud disabled") };
}
