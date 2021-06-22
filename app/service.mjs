/*
 * By:              A.G.
 * Created on:      2020.07.18
 * Last modified:   2020.07.23
 */

import Hub              from "./../index.mjs";
import { createLogger } from "./logging.mjs";

const log = createLogger(); // You may change to Winston if want.

((async () => {
    let server = new Hub();

    server.on(`listening`, ((thisServer, port, ip) => {
        let msg = ``;
        switch (ip) {
            case "127.0.0.1":
            case "localhost":
                msg = `Private localhost server is listening on port ${port}.`;
                break;
            case null:
            case "":
            case "0.0.0.0":
            case "::":
                msg = `Public server is listening on port ${port}.`;
                break;
            default:
                msg = `Server is bind to ${ip} and listening on ${port}.`;
                break;
        }
        log.info(msg);
    }));

    server.on(`error`, ((err) => {
        log.error(err);
    }));

    server.on(`accept`, ((clientInfo) => {
        log.debug(`A new client has connected: ${clientInfo.remoteAddress} (ID ${clientInfo.id})`);
        log.silly(`Total connected clients: ${server.numOfConnections}`);
    }));

    server.on(`disconnect`, ((clientInfo) => {
        log.debug(`Client has disconnected: ${clientInfo.remoteAddress}`);
        if (server.numOfConnections > 0) {
            log.silly(`Remaining connected clients: ${server.numOfConnections}`)
        } else {
            log.silly(`No more clients connected`)
        }
    }));

    await server.listen(7778); // Start listening for incoming connections.

    process.on(`SIGINT`, (async () => {
        log.info(`Caught SIGINT: stopping the server...`);
        await server.stop();
        process.exit();
    }));
})());
