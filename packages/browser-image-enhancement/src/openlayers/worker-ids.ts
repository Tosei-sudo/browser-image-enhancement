/** Negative ids for the map's requests to the worker pool, so they never meet the ids `execute` gives its strips on the same worker. */
let next = -1;

export function nextWorkerId(): number {
  return next--;
}
