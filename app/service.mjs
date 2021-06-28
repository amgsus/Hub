/*
 * Author: A.G.
 *   Date: 2021.06.26
 */

import { Hub }                from "./../lib/server.mjs";
import { createLogger }       from "./logging.mjs";
import { loadValuesFromFile } from "./util.mjs";
import config                 from "./config.mjs";

const log = createLogger();

// Main.
((async () => {
    log.print(`*** Hub v${config.version} ***`);

    if (config.verbose) {
        log.plain(`Running configuration:`, config);
    }

    let server = new Hub();

    if (config.preload) {
        let entries = [];
        const logPreload = createLogger("--preload");

        try {
            entries = await loadValuesFromFile(config.preload);
        } catch (e) {
            logPreload.error(e.message);
        }

        for ( let x of entries ) {
            if (config.verbose) {
                logPreload.silly(`Added: ${x.name}`);
            }
            server.updateValue(x.name, x.value);
        }
    }

    server.on(`listening`, ((thisServer, port, ip) => {
        let msg = ``;
        switch (ip) {
            case "127.0.0.1":
            case "localhost":
                msg = `Private localhost server is listening on port ${port}`;
                break;
            case null:
            case "":
            case "0.0.0.0":
            case "::":
                msg = `Public server is listening on port ${port}`;
                break;
            default:
                msg = `Server is bind to ${ip} and listening on ${port}`;
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
            log.silly(`Remaining connected clients: ${server.numOfConnections}`);
        } else {
            log.silly(`No more clients connected`);
        }
    }));

    process.on(`SIGINT`, (async () => {
        log.info(`Caught SIGINT: stopping the server...`);
        await server.stop();
        process.exit();
    }));

    await server.listen(config.binding.port, config.binding.address); // Start listening for incoming connections.

    if (config.http) {
        log.warn(`REST API is not implemented`);
    }
})());
