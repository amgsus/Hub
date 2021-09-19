/*
 * Author: A.G.
 *   Date: 2021/09/19
 */

import "@hapi/hapi";

export function createServer(hubServer) {
    return {
        listen: () => {
            throw new Error("REST API is not implemented");
        }
    };
}
