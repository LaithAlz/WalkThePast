/**
 * Vite defines `import.meta.env`; the Node test runner, which loads these
 * modules straight off disk, does not — and reading a property off it there
 * throws before any test gets to run. Everything in this folder goes through
 * here rather than touching `import.meta.env` directly.
 *
 * One exception, deliberately: a branch that must be dropped from a production
 * build keeps `import.meta.env.DEV` written out in full at the branch itself.
 * Vite folds that literal and removes the dead code; a read through this object
 * is opaque to it, and the branch ships. Only modules the tests never load can
 * do that, which today means the selfie step and the Avaturn client.
 */
export const env: Partial<ImportMetaEnv> = import.meta.env ?? {};
