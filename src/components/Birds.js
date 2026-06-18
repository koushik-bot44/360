/**
 * Birds.js — convenience re-export.
 *
 * The tour code imports `Birds` from `../Birds` (components root) while the
 * implementation lives under `fx/`. Re-export it here so both paths resolve
 * to the same GPU-flocking birds effect.
 */
export { default } from './fx/Birds';
