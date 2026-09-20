/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Browser-safe Clerk key. Absent means auth is stubbed and the app runs signed-out. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  /** Your own Avaturn project, e.g. https://walk-the-past.avaturn.dev. Without
   * one the selfie step falls back to Avaturn's shared demo project. */
  readonly VITE_AVATURN_URL?: string;
  /** Folder under public/characters holding locomotion clips for the guide.
   * With none installed the guide is animated from src/companion/pose.ts. */
  readonly VITE_GUIDE_CLIPS?: string;
}
