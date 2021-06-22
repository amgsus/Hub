/*
 * By:              A.G.
 * Created on:      2019.11.25
 * Last modified:   2020.07.19
 */

let cache  = {};
cache['']  = new RegExp('$^'); // match nothing
cache['*'] = new RegExp('^.+$'); // match everything

export default function NotifyExpression(mask) {
  let regex = cache[mask];
  if (!regex) {
    let expr = mask
        .replace(/[^\w\s\*]/g, '\\$&') // prefix every non-(alpha|digit|'*'|' ') with '\'
        .replace(/\*/g, '.*') // replace '*' with '.*' pattern (any non-space symbol any number of times)
        .replace(/\?/g, '.?') // Single character match.
        .replace(/\S+/g, '^$&$') // add beginline-'^' and endline-'$' conditions to expessions
        .replace(/\s+/g, '|'); // replace spaces with '|' (OR)
    regex       = new RegExp(expr);
    cache[mask] = regex; // storing regex to cache
  }
  return regex;
}
