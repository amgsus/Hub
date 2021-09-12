/*
 * Author: A.G.
 *   Date: 2020/07/19
 */

export const RPC_REGEX = new RegExp(/^(?<tag>\w+) (?<procName>\w+)(?: (?<argString>.+$))?/i); // Note single spaces.

export const RPC_RESULT_REGEX = new RegExp(/^(?<tag>\w+) (?<callResult>\d+)(?: (?<result>.+$))?/i); // Note single spaces.
