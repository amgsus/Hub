/*
 * Author: A.G.
 *   Date: 2021/06/26
 */

import { Hub }          from "./../lib/server.mjs";
import { createLogger } from "./logging.mjs";
import config           from "./config.mjs";

import {
    importValuesFromFile,
    isModuleNotFound
} from "./utils.mjs";

import {
    HubDictionary,
    HubRPCDispatcher
} from "./../index.mjs";

const log = createLogger();

// Main.
((async () => {
    log.print(`*** Hub v${config.version} ***`);

    if (config.verbose) {
        log.plain(`Running configuration:`, config);
    }

    let sharedDictionary = new HubDictionary(); // Shared between server instances.
    let sharedRPCDispatcher = new HubRPCDispatcher(); // Shared between server instances.

    let server = new Hub({
        defaultNotificationMask: config.server.notificationMask,
        clientOpts: config.clientOptions.default,
        binding: config.server.binding
    }, sharedDictionary, sharedRPCDispatcher);

    let mirrors = [];

    if (config.server.mirrors) {
        mirrors = config.server.mirrors.map((instanceConfig, index) => {
            let mirror = new Hub({
                defaultNotificationMask: instanceConfig.notificationMask,
                clientOpts: config.clientOptions.default,
                binding: instanceConfig.binding
            }, sharedDictionary, sharedRPCDispatcher);
            log.debug(`Created server mirror #${index+1}: ${mirror.address}`);
            return mirror;
        });
    }

    if (config.preload) {
        try {
            await preload(server, config.preload);
        } catch (e) {
            console.error(e);
            log.error(`Failed to preload dictionary from file: ${config.preload}\r\n${e.message}`);
        }
    }

    server.on(`listening`, ((binding) => {
        let msg = ``;
        switch (binding.address) {
            case "127.0.0.1":
            case "localhost":
                msg = `Private localhost server is listening on port ${binding.port}`;
                break;
            case null:
            case "":
            case "0.0.0.0":
            case "::":
                msg = `Public server is listening on port ${binding.port}`;
                break;
            default:
                msg = `Server is bind to ${binding.address} and listening on ${binding.port}`;
                break;
        }
        log.info(msg);
    }));

    server.on(`error`, ((err) => {
        log.error(err);
    }));

    server.on(`accept`, ((clientInfo) => {
        log.debug(`A new client has connected: ${clientInfo.remoteAddress} (ID ${clientInfo.id})`);
        log.trace(`Total connected clients: ${server.numOfConnections}`);
    }));

    server.on(`disconnect`, ((clientInfo) => {
        log.debug(`Client has disconnected: ${clientInfo.remoteAddress}`);
        if (server.numOfConnections > 0) {
            log.trace(`Remaining connected clients: ${server.numOfConnections}`);
        } else {
            log.trace(`No more clients connected`);
        }
    }));

    server.on(`identification`, (client, clientName) => {
        if (config.verbose) {
            log.trace(`${client.idString} identified as "${clientName}"`);
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

    server.on("stop", () => {
        log.info("Stopped");
    });

    process.on("SIGINT", (async () => {
        log.debug("Caught SIGINT (Ctrl+C): stopping the server(s)...");
        for ( let m of mirrors ) {
            await m.stop();
        }
        await server.stop();
    }));

    await server.listen();

    if (mirrors.length > 0) {
        log.debug("Starting mirror servers...");
        await Promise.all(mirrors.map(async (mirrorServer, index) => {
            try {
                await mirrorServer.listen();
            } catch (e) {
                log.error(`Failed to start mirror server #${index+1}: ${e.message}`);
            }
        }));
    }
})());

async function preload(server, filename) { // FIXME: Pass dictionary, not server.
    const MODULE_NAME = "line-reader";
    const logPreload = createLogger("Preload");

    let entries = [];
    let module;

    try {
        module = await import(MODULE_NAME);
    } catch (e) {
        if (isModuleNotFound(e)) {
            log.error(`Module "${MODULE_NAME}" not found: --preload feature requires it to be installed`);
        } else {
            log.error(e.message);
        }
        return;
    }

    try {
        let tuple = await importValuesFromFile(module.eachLine, filename);
        if (tuple.ignoredCount > 0 && config.verbose) {
            logPreload.silly(`Skipped ${tuple.ignoredCount} special key(s)`);
        }
        entries = tuple.entries;
    } catch (e) {
        logPreload.error(e.message);
    }

    for ( let x of entries ) {
        server.updateValue(x.name, x.value, false);
        if (config.verbose) {
            logPreload.silly(`Updated: ${x.name}`);
        }
    }
}
