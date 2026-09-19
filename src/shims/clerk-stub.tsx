/**
 * Stand-in for @clerk/react when VITE_CLERK_PUBLISHABLE_KEY is not set (see vite.config.ts).
 * The app renders and every screen works; auth actions report that sign-in is disabled.
 * With a real key the alias is not applied and the genuine Clerk package is used.
 */
import type { ReactNode } from "react";

export function ClerkProvider({ children }: { children: ReactNode; publishableKey?: string }) {
  return <>{children}</>;
}

export function useAuth() {
  return { isSignedIn: false, isLoaded: true, userId: null };
}

const disabled = { errors: [{ message: "Sign-in is disabled in this build (no Clerk key configured)." }] };
const attempt = {
  status: "needs_first_factor",
  password: async () => ({ error: disabled }),
  sso: async () => ({ error: disabled }),
  finalize: async () => undefined,
  verifications: { sendEmailCode: async () => undefined, verifyEmailCode: async () => ({ error: disabled }) },
  mfa: { sendEmailCode: async () => undefined, verifyEmailCode: async () => ({ error: disabled }) },
};

export function useSignIn() {
  return { signIn: attempt };
}
export function useSignUp() {
  return { signUp: attempt };
}
