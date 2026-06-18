/**
 * spaceCustom.js — per-space custom scene hook.
 *
 * The engine optionally lets a space inject bespoke scene logic (custom VFX,
 * cutscenes, post passes). When a space ships without one — as the default
 * 360 Virtual Tour demo does — this returns null and every call site guards
 * with `if (this.spaceCustom)`, so the tour runs unaffected.
 *
 * To add custom behaviour for a space, return an object implementing any of:
 *   { onLoad(), update(), render() }
 */
export default function setupSpaceCustom() {
  return null;
}
