/**
 * Routing and randomization utilities.
 */

/**
 * Returns true with the given probability (0–100).
 */
export function shouldRouteToV2(percent) {
  return Math.random() * 100 < percent;
}

/**
 * Pick a random integer in [min, max].
 */
export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
