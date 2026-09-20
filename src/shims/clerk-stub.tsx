/**
 * Stand-in for @clerk/react when VITE_CLERK_PUBLISHABLE_KEY is not set (see vite.config.ts).
 * The app renders and every screen works; auth actions report that sign-in is disabled.
 * With a real key the alias is not applied and the genuine Clerk package is used.
 *
 * Every name App.tsx imports from @clerk/react has to appear here, or a build without a
 * key fails at bundling rather than at runtime — which is easy to miss locally, where
 * .env.local supplies a key and this file is never reached.
 */
import type { ReactNode } from "react";

export function ClerkProvider({ children }: { children: ReactNode; publishableKey?: string }) {
  return <>{children}</>;
}

export function useAuth() {
  // getToken mirrors Clerk's shape: no key means no session, so the API sends no bearer
  // token and the Worker answers 401 rather than spending anything.
  return { isSignedIn: false, isLoaded: true, userId: null, getToken: async () => null };
}

/**
 * Clerk's sign-in and sign-up buttons. There is no Clerk to open, so each renders the
 * child it was given and says why nothing happened rather than looking broken.
 */
function DisabledAuthButton({ children }: { children?: ReactNode; mode?: string }) {
  return (
    <span
      onClickCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
        window.alert("Sign-in is disabled in this build: VITE_CLERK_PUBLISHABLE_KEY is not set.");
      }}
    >
      {children}
    </span>
  );
}

export const SignInButton = DisabledAuthButton;
export const SignUpButton = DisabledAuthButton;

/** Signed out by definition, so there is no account control to show. */
export function UserButton() {
  return null;
}
