// An ESM resolve hook so `node --test tests/*.test.ts` can load a source module
// that itself imports another local source module without an extension.
//
// Node's type-stripping runs the same ESM resolver as JavaScript, which does no
// extensionless resolution: a test importing `../src/core/leaf.ts` works, but a
// module that does `import { x } from "./other"` (the app's convention, resolved
// by tsc/vite as a bundler) fails with ERR_MODULE_NOT_FOUND. This hook retries
// such a specifier once with `.ts` appended, so a test may import any source
// module — leaf or not — following the app's own import style.
//
// Registered by the `npm test` script via `node --import ./tests/register-ts.mjs`,
// and a no-op for specifiers that already resolve.

import { registerHooks } from "node:module";

const RELATIVE = /^\.{1,2}\//;
const HAS_EXTENSION = /\.[a-zA-Z0-9]+$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (
        err &&
        err.code === "ERR_MODULE_NOT_FOUND" &&
        RELATIVE.test(specifier) &&
        !HAS_EXTENSION.test(specifier)
      ) {
        return nextResolve(specifier + ".ts", context);
      }
      throw err;
    }
  },
});
