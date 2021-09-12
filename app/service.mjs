/*
 * Author: A.G.
 *   Date: 2021/06/26
 */

import { Hub }                  from "./../lib/server.mjs";
import { createLogger }         from "./logging.mjs";
import { importValuesFromFile } from "./util.mjs";
import config                   from "./config.mjs";

const log = createLogger();

// Main.
((async () => {
    log.print(`*** Hub v${config.version} ***`);

    if (config.verbose) {
        log.plain(`Running configuration:`, config);
    }

    let server = new Hub();

    if (config.preload) {
        try {
            await preload(server, config.preload);
        } catch (e) {
            console.error(e);
            log.error(`Failed to preload dictionary from file: ${config.preload}\r\n${e.message}`);
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

    server.on(`identification`, (client, clientName) => {
        if (config.verbose) {
            log.info(`${client.idString} identified as "${clientName}"`);
        }
    });

    server.on(`registerRPC`, (client, name) => {
        if (config.verbose) {
            log.trace(`${client.idString} registered RPC "${name}"`);
        }
    });

    server.on(`unregisterRPC`, (client, name) => {
        if (config.verbose) {
            log.trace(`${client.idString} unregistered RPC "${name}"`);
        }
    });

    process.on(`SIGINT`, (async () => {
        log.info(`Caught SIGINT (Ctrl+C): stopping the server...`);
        await server.stop();
        process.exit();
    }));

    await server.listen(config.binding.port, config.binding.address); // Start listening for incoming connections.

    if (config.http) {
        log.warn(`REST API is not implemented`);
    }
})());

async function preload(server, filename) {
    const logPreload = createLogger("Preload");
    let entries = [];

    try {
        let tuple = await importValuesFromFile(filename);
        if (tuple.ignoredCount > 0 && config.verbose) {
            logPreload.silly(`Skipped ${tuple.ignoredCount} special key(s)`);
        }
        entries = tuple.entries;
    } catch (e) {
        logPreload.error(e.message);
    }

    for ( let x of entries ) {
        server.updateValue(x.name, x.value);
        if (config.verbose) {
            logPreload.silly(`Updated: ${x.name}`);
        }
    }
}
