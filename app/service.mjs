#!/usr/bin/env node

/*
 * Author: A.G.
 *   Date: 2021/06/26
 */

import { createLogger } from "./logging.mjs";
import config           from "./config.mjs";

import {
    importValuesFromFile,
    isModuleNotFound
} from "./utils.mjs";

import {
    Hub,
    HubConnectionManager,
    HubDictionary,
    HubRPCDispatcher
} from "./../index.mjs";

const log = createLogger();

// Main.
((async () => {
    log.print(`*** Hub v${config.version} ***`);

    if (config.verbose) {
        log.print("Running configuration:", config);
    }

    let sharedDictionary    = new HubDictionary();
    let sharedRPCDispatcher = new HubRPCDispatcher();
    let connectionManager   = new HubConnectionManager();

    if (config.debug) {
        addEventTracingLoggersToDictionary(sharedDictionary);
    }

    let server = new Hub({
        defaultNotificationMask: config.server.notificationMask,
        clientOpts: config.clientOptions.default,
        binding: config.server.binding
    }, sharedDictionary, sharedRPCDispatcher, connectionManager);

    let mirrors = [];

    let countConnectedClients = () => {
        return connectionManager.numOfConnections;
    };

    let getInfo = (client) => {
        return {
            server: {
                version: config.version
            },
            client: {
                remoteAddress: client.remoteAddress
            }
        };
    };

    let utilLambdas = Object.seal({
        countConnectedClients,
        getInfo
    });

    addEventListenersToServer(server, utilLambdas);

    process.on("SIGINT", (async () => { // FIXME: Add timeout?
        let allServers = [ ...mirrors, server ];
        log.debug(`Caught SIGINT (Ctrl+C): stopping ${allServers.length} server(s)...`);
        for ( let srv of allServers ) {
            try {
                await srv.stop();
            } catch (e) {
                log.error(`Failed to stop server (${srv.address}): ${e.message}`);
            }
        }
    }));

    process.on("beforeExit", (code) => {
        log.info("Exiting...");
    });

    if (config.preload) {
        try {
            await preload(sharedDictionary, config.preload);
        } catch (e) {
            console.error(e);
            log.error(`Failed to preload dictionary from file: ${config.preload}\r\n${e.message}`);
        }
    }

    if (config.server.mirrors) {
        log.debug(`Initializing server's mirrors (${config.server.mirrors.length})...`);
        let enabledMirrors = config.server.mirrors.filter((instanceConfig) => instanceConfig.enabled);
        mirrors = enabledMirrors.map((instanceConfig, index) => {
            let mirror = new Hub({
                defaultNotificationMask: instanceConfig.notificationMask,
                clientOpts: config.clientOptions.default,
                binding: instanceConfig.binding
            }, sharedDictionary, sharedRPCDispatcher, connectionManager);
            addEventListenersToServer(mirror, utilLambdas, `Mirror #${index+1}`);
            return mirror;
        });
    }

    await server.listen();

    await Promise.all(mirrors.map(async (instance, index) => {
        try {
            log.trace(`Socket ${instance.address}: start listening...`);
            await instance.listen();
        } catch (e) {
            log.error(`Failed to start server's mirror #${index}: ${e.message}`);
        }
    }));
})());

async function preload(dictionary, filename) {
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
        dictionary.createValue(x.name, x.value);
        if (config.verbose) {
            logPreload.silly(`Updated: ${x.name}`);
        }
    }
}

function addEventListenersToServer(server, { countConnectedClients, getInfo }, prefix = "") {
    server.on("listening", ((binding) => {
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
        if (prefix) {
            log.info(`${prefix}: ${msg}`);
        } else {
            log.info(msg);
        }
    }));

    server.on("error", ((err) => {
        log.error(err);
    }));

    server.on("accept", ((clientInfo) => {
        log.debug(`New connection accepted: ${clientInfo.remoteAddress} (ID ${clientInfo.id})`);
        log.trace(`Connected clients: ${countConnectedClients()}`);
    }));

    server.on("connectionClose", ((clientInfo) => {
        log.debug(`Connection close: ${clientInfo.remoteAddress}`);
        let numOfConnections = countConnectedClients();
        if (numOfConnections > 0) {
            log.trace(`Connected clients: ${numOfConnections}`);
        } else {
            log.trace("No more clients connected");
        }
    }));

    server.on("identification", (client, clientName) => {
        if (config.verbose) {
            log.trace(`${client.idString} identified as "${clientName}"`);
        }
    });

    server.on("registerRPC", (client, name) => {
        if (config.verbose) {
            log.trace(`${client.idString} registered RPC "${name}"`);
        }
    });

    server.on("unregisterRPC", (client, name) => {
        if (config.verbose) {
            log.trace(`${client.idString} unregistered RPC "${name}"`);
        }
    });

    server.on("stop", () => {
        log.info(`Stopped server: ${server.address}`);
    });

    server.on("infoRequest", (sendResponse, client) => {
        let info = getInfo(client);
        sendResponse(info);
    });
}

function addEventTracingLoggersToDictionary(sharedDictionary) {
    sharedDictionary.on("addSubscriber", (event) => {
        log.silly(`Added subscriber: keyName="${event.entry.name}" client=${event.subscriber.shortIDString}`);
    });

    sharedDictionary.on("removeSubscriber", (event) => {
        log.silly(`Removed subscriber: keyName="${event.entry.name}" client=${event.subscriber.shortIDString}`);
    });

    sharedDictionary.on("create", (entry) => {
        log.silly(`Created key: name="${entry.name}" value="${entry.value}"`);
    });

    sharedDictionary.on("delete", (entry) => {
        log.silly(`Deleted key: name="${entry.name}"`);
    });

    sharedDictionary.on("update", (entry) => {
        log.silly(`Updated key: name="${entry.name}" value="${entry.value}"`);
    });
}
