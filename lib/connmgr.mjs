/*
 * Author: A.G.
 *   Date: 2021/09/25
 */

import { EventEmitter }    from "events";
import { arrayDeleteItem }      from "./utils.mjs";
import { HubConnectionHandler } from "./client.mjs";

export class HubConnectionManager extends EventEmitter {

    /**
     * @type {HubConnectionHandler[]}
     */
    #clients = [];

    #nextClientID = 0;
    #clientMap = {};

    /**
     * @type {Hub}
     */
    #server;

    constructor() {
        super();
    }

    get server() { return this.#server; }

    get numOfConnections() { return this.#clients.length; }

    get allClients() { return this.#clients; }

    getClientsByServer(server) {
        return this.allClients.filter((client) => client.server === server);
    }

    closeAllConnections(forEach) {
        if (forEach) {
            if (typeof forEach !== "function") {
                throw new Error("forEach is expected to be function");
            }
        } else {
            forEach = () => {}; // Dummy.
        }
        for ( let client of this.#clients ) {
            forEach(client);
            client.disconnect();
        }
    }

    acceptConnection(socket, server, clientOpts) {
        let clientID = this.#getUniqueClientID();
        let client = new HubConnectionHandler(server, clientID, socket, clientOpts); // FIXME
        client.connectionTime = Date.now(); // Used by #online to calculate up-time.
        this.#clients.push(client);
        return client;
    }

    removeConnection(client) {
        return arrayDeleteItem(this.#clients, client);
    }

    disconnect(client) {
        client.disconnect();
        return this.removeConnection(client);
    }

    #getUniqueClientID() {
        let id;
        do {
            id = this.#nextClientID;
            this.#nextClientID++; // FIXME: Any limit?
        } while (this.#clientMap[`C#${id}`]);
        return id;
    }
}
