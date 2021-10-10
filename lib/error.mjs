/*
 * Author: A.G.
 *   Date: 2021/10/10
 */

export class HubServerError extends Error {
    constructor(message) {
        super(message);
    }

    /**
     * Fabric method.
     */
    static create(msg) {
        return new HubServerError(msg);
    }
}
