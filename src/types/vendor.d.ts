// Ambient declaration for vendored plain-JS modules (RTK tools) that have no types.
// Bun runs these directly; tsc treats any unresolved `.js` import as `any`.
declare module "*.js";
