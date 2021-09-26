/*
 * Author: A.G.
 *   Date: 2021/09/26
 */

export const TIMESTAMP_ABSOLUTE = "abs";

export const TIMESTAMP_RELATIVE = "rel";

export const TIMESTAMP_NONE     = "none";

export class EntityRenderer {
    #entity;
    #cache = {};

    constructor(entity) {
        this.#entity = entity;
    }

    reset() {
        this.#cache = {};
    }

    renderLine(timestampFormat) {
        if (!this.#cache[timestampFormat]) {
            switch (timestampFormat) {
                case "abs":
                case "absolute":
                    this.#cache[timestampFormat] = `${this.#entity.name}@${this.#entity.ts}=${this.#entity.value}`;
                    break;
                case "rel":
                case "relative":
                    let relts = ((this.#entity.ts - Date.now()) || '-0'); // Force '-' for 0.
                    this.#cache[timestampFormat] = `${this.#entity.name}@${relts}=${this.#entity.value}`;
                    break;
                default:
                    this.#cache[timestampFormat] = `${this.#entity.name}=${this.#entity.value}`;
                    break;
            }
        }
        return this.#cache[timestampFormat];
    }
}
