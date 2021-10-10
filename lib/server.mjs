/*
 * Author: A.G.
 *   Date: 2019/11/25
 */

import { EventEmitter, once }   from "events";
import { Server }               from "net";
import { createLogger }         from "./../app/logging.mjs"; // TODO: Remove!!!
import { HubConnectionManager } from "./connmgr.mjs";
import { HubMatcher }           from "./match.mjs";

import {
    HubRPCDispatcher, RPC_CODE_NOT_REGISTERED
} from "./rpc.mjs";

import {
    HubDictionary,
    HubStoredValue
} from "./dictionary.mjs";

import {
    popCallback,
    isDefined,
    toNumber,
    createPromiseBasedOn, arrayDeleteItem
} from "./utils.mjs";

import {
    ERROR_MSG,
    SINGLE_SPACE
} from "./consts.mjs";

import { EntityRenderer } from "./renderer.mjs";
import { HubServerError } from "./error.mjs";

// ----------------------------------------------------------------------------

const log = createLogger("Hub");

const RPC_REGEX = new RegExp(/^(?<tag>\w+) (?<procName>\w+)(?: (?<argString>.+$))?/); // Note single spaces.

const RPC_RESULT_REGEX = new RegExp(/^(?<tag>\w+) (?<callResult>\d+)(?: (?<result>.+$))?/); // Note single spaces.

// ----------------------------------------------------------------------------

// TODO: Do not use logger. Pass everything via events to upper-level code.

/**
 * @emits accept - when a new client has connected.
 * @emits disconnect - when a client has disconnected or connection is lost.
 * @emits listening - when the server starts to accept connections.
 * @emits stop - when the server stops.
 * @emits error - when an error occurs (and server cannot continue to perform normally). The server does not emit this event, if a client socket throws an error.
 */
export class Hub extends EventEmitter {

    static #regexCache = HubMatcher.getSingleton();

    #server = new Server({}, this.#acceptConnection.bind(this));
    #listeningPort;
    #host;
    #creatingEmptyChannelsUponRequest = false; // FIXME: Hardcoded.
    #rpcMaxTimeout = 60000; // FIXME: Hardcoded.
    #defaultNotificationMask;
    #defaultClientOpts;

    /**
     * @type {HubRPCDispatcher}
     */
    #rpcDispatcher;

    /**
     * @type {HubDictionary}
     */
    #dictionary;

    /**
     * @type {HubConnectionManager}
     */
    #clientManager;

    /**
     * @param {object} opts
     * @param {HubDictionary} dictionary
     * @param {HubRPCDispatcher} rpcDispatcher
     * @param {HubConnectionManager} connectionManager
     */
    constructor(opts, dictionary = null, rpcDispatcher = null, connectionManager = null) {
        super();

        if (dictionary) {
            if (!(dictionary instanceof HubDictionary)) {
                throw new Error("dictionary must be instance of HubDictionary");
            }
            log.trace(`Using provided instance of HubDictionary`);
        } else {
            dictionary = new HubDictionary();
        }

        if (rpcDispatcher) {
            if (!(rpcDispatcher instanceof HubRPCDispatcher)) {
                throw new Error("rpcDispatcher must be instance of RPCDispatcher");
            }
            log.trace(`Using provided instance of HubRPCDispatcher`);
        } else {
            rpcDispatcher = new HubRPCDispatcher();
        }

        if (connectionManager) {
            if (!(connectionManager instanceof HubConnectionManager)) {
                throw new Error("connectionManager must be instance of HubConnectionManager");
            }
            log.trace(`Using provided instance of HubConnectionManager`);
        } else {
            connectionManager = new HubConnectionManager();
        }

        this.#dictionary = dictionary;
        this.#rpcDispatcher = rpcDispatcher;
        this.#clientManager = connectionManager;
        this.#server.on("error", this.emit.bind(this, "error"));
        this.#server.on("close", this.emit.bind(this, "stop" ));
        this.#defaultNotificationMask = opts.defaultNotificationMask;
        this.#defaultClientOpts = opts.clientOpts;
        if ((typeof opts.binding).indexOf("object") >= 0) {
            this.#listeningPort = opts.binding.port;
            this.#host = opts.binding.address;
        }
    }

    get server() { return this.#server; }

    get address() {
        return `${this.#host}:${this.#listeningPort}`;
    }

    /**
     * @param   [port]
     * @param   [host]
     * @param   [callback]
     * @returns {(Promise|undefined)}
     */
    listen(port, host, callback) {
        let {
            args,
            callback: realCallback
        } = popCallback(arguments);

        port = args[0];
        host = args[1];
        callback = realCallback;

        if (this.#server.listening) {
            throw new Error("Server is already listening");
        }

        if (isDefined(port)) {
            this.#listeningPort = toNumber(port, (value) => {
                if (isNaN(value)) {
                    throw new Error(`Port must be a number: ${port}`);
                }
                return value;
            });
        }

        if (isDefined(host) || host === "") {
            this.#host = host;
        }

        const startListening = (cb) => {
            this.#server.listen(this.#listeningPort, this.#host);
            once(this.#server, "listening").then(this.#onServerListening.bind(this, cb)).catch(cb);
        };

        if (callback) {
            startListening(callback);
        } else {
            return createPromiseBasedOn(startListening);
        }
    }

    #onServerListening(cb) {
        this.emit("listening", this.#server.address());
        cb(null, this.#server.address());
    }

    get listening() { return this.#server.listening; }

    /**
     * Stops the server.
     *
     * @param {function():void} [callback]
     *
     * @returns {Promise|undefined}
     */
    stop(callback) {
        const stopImpl = (cb) => {
            this.#rpcDispatcher.dropPendingCalls(this); // Drop only on this server.
            this.#server.close((err) => {
                if (err) console.error(err); // FIXME: Use logger?
                cb();
            });
            this.closeAllConnections();
        };
        if (typeof callback === "function") {
            if (this.listening) {
                stopImpl(callback);
            } else {
                setImmediate(callback);
            }
        } else {
            if (this.listening) {
                return new Promise((resolve) => {
                    stopImpl(() => {
                        resolve();
                    });
                });
            } else {
                return Promise.resolve();
            }
        }
    }

    closeAllConnections() {
        this.#clientManager.closeAllConnections((client) => {
            log.trace(`Gracefully closing connection ${client.idString}`);
        });
    }

    get numOfConnections() { return this.#clientManager.numOfConnections; }

    #acceptConnection(connection) {
        let client = this.#clientManager.acceptConnection(connection, this, this.#defaultClientOpts);

        client.on("error", this.#onClientError.bind(this, client));
        client.on("disconnect", this.#onClientClose.bind(this, client));
        client.on("store", this.#onClientStore.bind(this, client));
        client.on("list", this.#onClientList.bind(this, client));
        client.on("publish", this.#onClientPublish.bind(this, client));
        client.on("retrieve", this.#onClientRetrieve.bind(this, client));
        client.on("identify", this.#onClientIdentification.bind(this, client));
        client.on("delete", this.#onClientDeleteValue.bind(this, client));
        client.on("subscriptionUpdate", this.#onClientSubscriptionUpdate.bind(this, client));
        client.on("rpc", this.#onProcedureCall.bind(this, client));
        client.on("result", this.#onProcedureCallResult.bind(this, client));
        client.on("registerRPC", this.#onClientRegistersRPC.bind(this, client));
        client.on("unregisterRPC", this.#onClientUnregistersRPC.bind(this, client));
        client.on("listRPCs", this.#onCommandListRPCs.bind(this, client));
        client.on("listOnline", this.#onOnlineRequested.bind(this, client));
        client.on("fetch", this.#onFetch.bind(this, client));
        client.on("dump", this.#onDump.bind(this, client));
        client.on("optionSet", this.#onClientOptionSet.bind(this, client));
        client.on("infoRequest", this.#onClientInfoRequest.bind(this, client));
        client.on("featureRequest", this.#onClientFeatureRequest.bind(this, client));
        client.on("adjustRPCTimeout", this.#onClientAdjustRPCTimeout.bind(this, client));

        client.setSubscriptionMaskOrRegExp(this.#defaultNotificationMask, false);
        this.#dictionary.addSubscriber(client, client.notificationRegExp);

        this.#emitClientEvent("accept", client);
    }

    #emitClientEvent(eventName, client) {
        this.emit(eventName, {
            id: client.id,
            remoteAddress: client.remoteAddress,
            client
        });
    }

    #onClientAdjustRPCTimeout(client, desiredTimeout, callback) {
        desiredTimeout = Number(desiredTimeout);
        let set = null;
        if (desiredTimeout <= this.#rpcMaxTimeout) { // Limit.
            if (desiredTimeout >= 0) {
                set = desiredTimeout;
            }
        } else {
            set = this.#rpcMaxTimeout;
        }
        callback(set);
    }

    /**
     * Callback for feature request from client. The server returns supported
     * and enabled features to client.
     *
     * Feature list is required for Hub client library to determine what
     * commands can be issued on server.
     *
     * @param client
     * @param sendResponse
     */
    #onClientFeatureRequest(client, sendResponse) {
        sendResponse(ERROR_MSG); // TODO: Not implemented.
    }

    /**
     * Responds the list of all connected clients to this server.
     *
     * @param client
     * @param format
     * @param sendResponse
     */
    #onOnlineRequested(client, format, sendResponse) {
        let check = format.endsWith("?") && format !== "?";
        let desiredClientName = format.slice(0, -1);
        let detailed = ( format === "detailed" ) || check;
        let now = Date.now();
        let clientList = check ? this.#clientManager.allClients.filter((c) => c.clientName === desiredClientName) : this.#clientManager.allClients;
        let onlineDetails = clientList.map((c) => {
            let clientInfo = {
                id: c.id,
                nick: c.clientName ? c.clientName : undefined
            };
            if (detailed) {
                clientInfo.addr = c.remoteAddress;
                clientInfo.uptime = now - c.connectionTime;
            }
            return clientInfo;
        });
        sendResponse(onlineDetails);
    }

    #onClientInfoRequest(client, sendResponse) {
        this.emit("infoRequest", sendResponse, client);
    }

    /**
     * Responds to the client a JSON-object containing key pairs stored in
     * dictionary and matching the mask (if specified).
     *
     * Example (formatted):
     *
     *      {
     *          "Fan": "ON",
     *          "Heater": "OFF"
     *      }
     *
     * @param client
     * @param mask
     *
     * @private
     */
    #onDump(client, mask, sendResponse) {
        let fltEntries = this.#dictionary.allEntries;
        if (mask && mask !== "*") {
            let expr = mask instanceof RegExp ? mask : getTestExpression(mask);
            fltEntries = fltEntries.filter((entry) => expr.test(entry.name));
        }
        let result = fltEntries.reduce((dump, keyObj) => {
            dump[keyObj.name] = keyObj.value;
            return dump;
        }, {});
        sendResponse(result);
    }

    /**
     * Responds to the client with a JSON-array of the names of keys stored in
     * the dictionary and matching the mask (if specified).
     *
     * Example (formatted):
     *
     *      [
     *          "Fan",
     *          "Heater"
     *      ]
     *
     * @param client
     * @param mask
     * @param sendResponse
     *
     * @private
     */
    #onFetch(client, mask, sendResponse) {
        let fltEntries = this.#dictionary.allEntries;
        if (mask && mask !== "*") {
            let expr = mask instanceof RegExp ? mask : getTestExpression(mask);
            fltEntries = fltEntries.filter((entry) => expr.test(entry.name));
        }
        let keys = fltEntries.map((entry) => entry.name);
        sendResponse(keys);
    }

    #onClientError(client, error) {
        log.error(`${client.idString} fault occurred: ${error.stack}`);
    }

    #onClientIdentification(client) {
        this.emit("identification", client, client.clientName);
    }

    #onClientDeleteValue(client, keyName) { // FIXME: Dictionary.
        if (this.#dictionary.deleteValue(keyName)) {
            log.trace(`${client.idString} has deleted key: ${keyName}`);
            log.silly(`There are ${this.#dictionary.length} key(s) stored`);
        } else {
            log.trace(`${client.idString} has requested to delete key '${keyName}', but such key does not exist`);
        }
    }

    #onClientClose(client) {
        this.#dictionary.removeSubscriber(client);
        this.#rpcDispatcher.unregisterProcedureOfProvider(client);
        this.#clientManager.removeConnection(client);
        client.removeAllListeners();
        this.#emitClientEvent("connectionClose", client);
    }

    #onClientSubscriptionUpdate(client) { // TODO: Delegate logic to HubDictionary class.
        for ( let ent of this.#dictionary.allEntries ) {
            let index = ent.subscribers.indexOf(client);
            let subscribed = (index !== -1);
            let matchesPattern = HubMatcher.testNotificationMask(client, ent.name);
            if (matchesPattern && !subscribed) {
                ent.subscribers.push(client);
            }
            if (!matchesPattern && subscribed) {
                ent.subscribers.splice(index, 1);
            }
        }
        log.trace(`Client ${client.idString} updated subscription (listensAll = ${client.listensAll})`);
    }

    #onClientList(client, mask) {
        let expr = Hub.#regexCache.getOrCreateCachedNotificationRegExp(mask);
        let filteredEntries = this.#dictionary.filter(expr, true); // Exclude unassigned values.
        for ( let ent of filteredEntries ) {
            client.sendValue(ent);
        }
    }

    #onClientRetrieve(client, keyName, defaultValue) {
        let notifying = true;
        let entry = this.#dictionary.get(keyName);
        if (!entry) {
            if (this.#creatingEmptyChannelsUponRequest || defaultValue || defaultValue === "") {
                this.#onClientStore(client, keyName, defaultValue, Date.now());
                entry = this.#dictionary.get(keyName);
            } else {
                if (client.opts.retrieveNonExisting) {
                    entry = new HubStoredValue(keyName);
                } else {
                    notifying = false;
                }
            }
        }
        if (notifying) {
            client.sendValue(entry);
        }
    }

    #onClientStore(client, keyName, value, ts) {
        this.#dictionary.getOrCreateEntry(keyName, (entry, existing) => {
            if (!existing) {
                entry.subscribers = HubMatcher.filterClientsWithMatchedNotificationMask(this.#clientManager.allClients, keyName);
                log.trace(`Client ${client.idString} has created key: ${entry.name}`);
                log.trace(`Total stored values: ${this.#dictionary.length}`);
            }
            this.#dictionary.updateValue(keyName, value, ts, this);
            this.#scheduleSubscribersNotification(entry, entry.subscribers, client);
        });
    }

    #onClientPublish(client, keyName, value, ts) {
        this.#dictionary.getOrCreateEntry(keyName, (entry, existing) => { // Stored value is used for maintaining clients' subscriptions (only).
            if (!existing) {
                entry.subscribers = HubMatcher.filterClientsWithMatchedNotificationMask(this.#clientManager.allClients, keyName);
                log.trace(`Client ${client.idString} has created key: ${entry.name}`);
                log.trace(`Total stored values: ${this.#dictionary.length}`);
            }
            entry.value = null; // FIXME: Should we reset stored value to null? Thinking to make this option.
            let publishingEntry = new HubStoredValue(keyName, value, ts);
            this.#scheduleSubscribersNotification(publishingEntry, entry.subscribers, client);
        });
    }

    #scheduleSubscribersNotification(entry, subscribers, sender = null) {
        setImmediate(this.#notifySubscribers.bind(this, entry, subscribers, sender));
    }

    #notifySubscribers(entry, subscribers, excludedConnection) {
        let renderer = new EntityRenderer(entry);
        for ( let sub of subscribers ) {
            if (sub !== excludedConnection) {
                sub.sendValueUsingTimestampRenderer(renderer);
            }
        }
    }

    #onClientOptionSet(client, optionName) {
        log.silly(`${client.idString} set option: ${optionName}=${client.opts[optionName]}`);
    }

    isFeatureEnabled(featureName) { return true; }



    #onCommandListRPCs(client, mask) {
        let regex = mask instanceof RegExp ? mask : getTestExpression(mask);
        let allNames = this.#rpcDispatcher.listRegistered();
        let filteredNames = allNames.filter((name) => regex.test(name));
        let response = filteredNames.join(SINGLE_SPACE);
        client.send("#rpclist", response);
    }

    #onClientRegistersRPC(client, procName) { // TODO: Validate procedure name.
        if (this.#rpcDispatcher.registerProcedure(procName, client)) {
            this.emit("registerRPC", client, procName); // Notify upper layer.
        } else {
            client.send("#regrpc", ERROR_MSG); // Introduce constant for command.
        }
    }

    #onClientUnregistersRPC(client, procName) { // TODO: Validate procedure name.
        if (client === this.#rpcDispatcher.getProvider(procName)) {
            this.#rpcDispatcher.unregisterProcedure(procName);
            this.emit("unregisterRPC", procName, client);
        }
    }

    #onProcedureCall(client, param) {
        let { groups } = ((() => (RPC_REGEX.exec(param) || { groups: {} }))()); // In-place. // TODO: Refactor.
        if (groups.tag) { // Filter invalid.
            let rpc = {
                tag: groups.tag,
                procedureName: groups.procName,
                args: groups.argString, // Do nothing with it (as it is).
                caller: client,
                server: this,
                waitTimeout: client.opts.rpcTimeout
            };
            this.#rpcDispatcher.dispatchCall(rpc, (err, request, hoster) => {
                if (err) { // Error is code, exception on success.
                    rpc.callResult = err;
                    client.sendRPCResult(rpc);
                    this.emit("clientError", client, HubServerError.create(err), rpc);
                } else {
                    hoster.sendRPC(request);
                }
            });
        }
    }

    #onProcedureCallResult(client, param) {
        let { groups } = ((() => (RPC_RESULT_REGEX.exec(param) || { groups: {} }))()); // In-place. // TODO: Refactor.
        let masqueradedTag = groups.tag;
        if (masqueradedTag && client.passRPCWhiteList(masqueradedTag)) { // TODO: Filter outdated/unknown transactions. Filter by client.
            let rpc = {
                masqueradedTag,
                callResult: groups.callResult,
                result: groups.result
            };
            this.#rpcDispatcher.dispatchResult(rpc, (err, response, caller) => {
                if (err) {
                    this.emit("clientError", client, err, rpc);
                }
                caller.sendRPCResult(response);
            });
        }
    }
}
