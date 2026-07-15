export function useAuth() {
  return { isSignedIn: true, isGracePeriodOnly: false, isLoaded: true, session: null, user: null };
}
