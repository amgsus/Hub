/*
 * Author: A.G.
 *   Date: 2019/11/25
 */

import { EventEmitter, once } from "events";
import { Server }             from "net";
import { ClientHandler }      from "./client.mjs";
import getTestExpression      from "./match.mjs";
import { createLogger }       from "./../app/logging.mjs";

import {
    RPCDispatcher,
    RPCCall
} from "./rpc.mjs";

import {
    HubDictionary,
    Entry
} from "./dictionary.mjs";

import {
    popCallback,
    isDefined,
    toNumber,
    createPromiseBasedOn
} from "./utils.mjs";

// ----------------------------------------------------------------------------

const log = createLogger(`Hub(class)`);

const SINGLE_SPACE = " ";

const ERROR_MSG = "ERROR";

const TIMESTAMP_ABSOLUTE = "abs";
const TIMESTAMP_RELATIVE = "rel";
const TIMESTAMP_NONE     = "none";

const RPC_REGEX = new RegExp(/^(?<tag>\w+) (?<procName>\w+)(?: (?<argString>.+$))?/i); // Note single spaces.

const RPC_RESULT_REGEX = new RegExp(/^(?<tag>\w+) (?<callResult>\d+)(?: (?<result>.+$))?/i); // Note single spaces.

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

    #server = new Server({}, this.#acceptConnection.bind(this));
    #nextClientID = 0;
    #clients = []; // Connected clients (handlers).
    #listeningPort = 7778;
    #host = ``;
    #creatingEmptyChannelsUponRequest = false; // TODO: Pass through arguments.
    #defaultNotificationMask;
    #defaultClientOpts;

    #clientMap = {};

    /**
     * @type {RPCDispatcher}
     */
    #rpcDispatcher;

    /**
     * @type {HubDictionary}
     */
    #dictionary;

    /**
     * @param {object} opts
     * @param {HubDictionary} dictionary
     * @param {RPCDispatcher} rpcDispatcher
     */
    constructor(opts, dictionary = null, rpcDispatcher = null) {
        super();

        if (dictionary) {
            if (!(dictionary instanceof HubDictionary)) {
                throw new Error(`dictionary is not instance of HubDictionary`);
            }
        } else {
            dictionary = new HubDictionary();
        }

        if (rpcDispatcher) {
            if (!(rpcDispatcher instanceof RPCDispatcher)) {
                throw new Error(`rpcDispatcher is not instance of RPCDispatcher`);
            }
        } else {
            rpcDispatcher = new RPCDispatcher();
        }

        this.#dictionary = dictionary;
        this.#rpcDispatcher = rpcDispatcher;
        this.#server.on("error", this.emit.bind(this, "error"));
        this.#server.on("close", this.emit.bind(this, "stop" ));
        this.#defaultNotificationMask = `${opts.defaultNotificationMask}` || "*";
        this.#defaultClientOpts = opts.clientOpts;
    }

    get server() { return this.#server; }

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
        for ( let client of this.#clients ) {
            log.trace(`Force closing ${client.idString}`);
            // TODO: Broadcast event?
            client.disconnect();
        }
    }

    get numOfConnections() { return this.#clients.length; }

    #acceptConnection(connection) {
        let clientID = this.#getUniqueClientID();
        let client = new ClientHandler(this, clientID, connection,
            this.#defaultNotificationMask, "none", this.#defaultClientOpts);

        this.#clients.push(client);
        this.#clientMap[`${client.id}`] = client;

        client.connectionTime = Date.now(); // Used by #online to calculate up-time.

        this.#dictionary.addSubscriber(client.notifyExpression, client);

        client.on("error", this.#onClientError.bind(this, client));
        client.on("disconnect", this.#onClientClose.bind(this, client));
        client.on("store", this.#onClientStore.bind(this, client));
        client.on("list", this.#onClientList.bind(this, client));
        client.on("publish", this.#onClientPublish.bind(this, client));
        client.on("retrieve", this.#onClientRetrieve.bind(this, client));
        client.on("identify", this.#onClientIdentification.bind(this, client));
        client.on("delete", this.#onClientDeleteValue.bind(this, client));
        client.on("notifyChange", this.#onClientNotifyChange.bind(this, client));
        client.on("rpc", this.#onProcedureCall.bind(this, client));
        client.on("result", this.#onProcedureCallResult.bind(this, client));
        client.on("registerRPC", this.#onClientRegistersRPC.bind(this, client));
        client.on("unregisterRPC", this.#onClientUnregistersRPC.bind(this, client));
        client.on("listRPCs", this.#onCommandListRPCs.bind(this, client));
        client.on("listOnline", this.#onOnlineRequested.bind(this, client));
        client.on("fetch", this.#onFetch.bind(this, client));
        client.on("dump", this.#onDump.bind(this, client));
        client.on("optionSet", this.#onClientOptionSet.bind(this, client));

        this.emit("accept", {
            id: client.id,
            remoteAddress: client.remoteAddress,
            socket: client.socket,
            client
        });
    }

    /**
     * Responds the list of all connected clients to this server.
     *
     * @param client {ClientHandler}
     * @param format {string}
     */
    #onOnlineRequested(client, format) {
        let check = format.endsWith("?");
        let desiredClientName = format.slice(0, format.length - 1);
        let detailed = ( format === "detailed" ) || check;
        let now = Date.now();
        let clientList = check ? this.#clients.filter((c) => c.clientName === desiredClientName) : this.#clients;
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
        let responseString = JSON.stringify(onlineDetails);
        client.send("#online", responseString);
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
    #onDump(client, mask) {
        let fltEntries = this.#dictionary.entries;
        if (mask && mask !== "*") {
            let expr = mask instanceof RegExp ? mask : getTestExpression(mask);
            fltEntries = fltEntries.filter((entry) => expr.test(entry.path));
        }
        let result = fltEntries.reduce((dump, keyObj) => {
            dump[keyObj.path] = keyObj.value;
            return dump;
        }, {});
        let responseText = JSON.stringify(result);
        client.send("#dump", responseText);
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
     *
     * @private
     */
    #onFetch(client, mask) {
        let fltEntries = this.#dictionary.entries;
        if (mask && mask !== "*") {
            let expr = mask instanceof RegExp ? mask : getTestExpression(mask);
            fltEntries = fltEntries.filter((entry) => expr.test(entry.path));
        }
        let keys = fltEntries.map((entry) => entry.path);
        let responseText = JSON.stringify(keys);
        client.send("#fetch", responseText);
    }

    #onClientError(client, error) {
        log.error(`${client.idString} fault occurred: ${error.stack}`);
    }

    #onClientIdentification(client) {
        this.emit(`identification`, client, client.clientName);
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
        this.#unregisterClientsRPCs(client, `${client.idString} disconnects`); // FIXME
        let index = this.#clients.indexOf(client);
        this.#clients.splice(index, 1); // Remove entry from clients[].
        client.removeAllListeners();
        this.emit(`disconnect`, {
            id: client.id,
            remoteAddress: client.remoteAddress,
            socket: null
        });
    }

    #onClientNotifyChange(client) {
        let notifyExpression = client.notifyExpression;
        for (let i = 0, len = this.#dictionary.length; i < len; i += 1) {
            let path        = this.#dictionary.entries[i].path;
            let subscribers = this.#dictionary.entries[i].subscribers;
            let index          = subscribers.indexOf(client);
            let subscribed     = (index !== -1);
            let matchesPattern = notifyExpression.test(path);
            if (matchesPattern && !subscribed) {
                subscribers.push(client);
            }
            if (!matchesPattern && subscribed) {
                subscribers.splice(index, 1);
            }
        }
    }

    #onClientList(client, mask) {
        let expr = getTestExpression(mask);
        let filteredEntries = this.#dictionary.entries.filter((entry) => expr.test(entry.path));
        for ( let ent of filteredEntries ) {
            let payload = this.#buildPayload({
                path: ent.path,
                value: ent.value,
                ts: ent.ts
            }, client.timestampFormat);
            client.writeLine(payload);
        }
    }

    #onClientRetrieve(client, keyName, defaultValue) {
        let notifying = true;
        let entry = this.#dictionary.get(keyName);
        if (!entry) {
            if (this.#creatingEmptyChannelsUponRequest) {
                this.#onClientStore(client, keyName, defaultValue, Date.now());
                entry = this.#dictionary.get(keyName);
            } else {
                if (client.opts.retrieveNonExisting) {
                    entry = new Entry(keyName);
                } else {
                    notifying = false;
                }
            }
        }
        if (notifying) {
            let packet = this.#buildPayload({
                path: keyName,
                value: entry.value,
                ts: entry.ts
            }, client.timestampFormat);
            client.writeLine(packet);
        }
    }

    #onClientStore(client, keyName, value, ts) {
        let entry = this.#dictionary.get(keyName); // No create.
        if (!entry) {
            entry = this.#dictionary.createEntry(keyName);
            entry.subscribers = this.#clients.filter(function (client2) {
                return client2.notifyExpression.test(keyName);
            });
            log.trace(`Client ${client.clientName || client.id} has created key: ${entry.path}`);
            log.silly(`Total keys stored: ${this.#dictionary.length}`);
        }
        if (ts > entry.ts) {
            entry.value = value;
            entry.ts = ts;
        }
        this.#scheduleSubscribersNotification(entry, entry.subscribers, client);
    }

    #scheduleSubscribersNotification(entry, subscribers, sender = null) {
        setImmediate(this.#notifySubscribers.bind(this, entry, subscribers, sender));
    }

    #onClientPublish(client, path, value, ts) {
        let subscribers = this.#clients.filter((c) => c.notifyExpression.test(path));
        let entry = new Entry(path, value, ts);
        this.#scheduleSubscribersNotification(entry, subscribers, client);
    }

    #notifySubscribers(entry, subscribers, exclude) {
        let packetCache = this.#buildPayloadWithCachedTimestamps(entry);
        for ( let i = 0; i < subscribers.length; i++ ) {
            let client = subscribers[i];
            if (client === exclude) {
                continue;
            }
            client.writeLine(packetCache[client.timestampFormat]);
        }
    }

    #buildPayload(data, tsMode = TIMESTAMP_NONE) {
        switch (tsMode) {
            case TIMESTAMP_ABSOLUTE:
                return `${data.path}@${data.ts}=${data.value}`;
            case TIMESTAMP_RELATIVE:
                let ts = ((data.ts - Date.now()) || '-0');
                return `${data.path}@${ts}=${data.value}`;
            default:
                return `${data.path}=${data.value}`;
        }
    }

    #buildPayloadWithCachedTimestamps(entry) {
        let cache = {};
        cache[TIMESTAMP_ABSOLUTE] = this.#buildPayload(entry, TIMESTAMP_ABSOLUTE);
        cache[TIMESTAMP_RELATIVE] = this.#buildPayload(entry, TIMESTAMP_RELATIVE);
        cache[TIMESTAMP_NONE]     = this.#buildPayload(entry, TIMESTAMP_NONE);
        return cache;
    }

    #getUniqueClientID() {
        let id;
        do {
            id = this.#nextClientID;
            this.#nextClientID++;
        } while (this.#clientMap[`${id}`]);
        return id;
    }

    #onClientOptionSet(client, optionName) {
        log.silly(`${client.idString} set option: ${optionName}=${client.opts[optionName]}`);
    }

    isFeatureEnabled(featureName) { return true; }

    updateValue(name, value, notifySubscribers = true) {
        let entry = this.#dictionary.updateValue(name, value);
        if (notifySubscribers) {
            this.#scheduleSubscribersNotification(entry, entry.subscribers, null);
        }
    }

    #onCommandListRPCs(client, mask) {
        let regex = mask instanceof RegExp ? mask : getTestExpression(mask);
        let allNames = this.#rpcDispatcher.listRegistered();
        let filteredNames = allNames.filter((name) => regex.test(name));
        let response = filteredNames.join(SINGLE_SPACE);
        client.send("#rpclist", response);
    }

    #onClientRegistersRPC(client, procName) { // TODO: Validate procedure name.
        if (this.#rpcDispatcher.registerProcedure(procName, client)) {
            this.emit("registerRPC", client, procName);
        } else {
            client.send("#rpcreg", ERROR_MSG);
        }
    }

    #onClientUnregistersRPC(client, procName) { // TODO: Validate procedure name.
        if (client === this.#rpcDispatcher.getProvider(procName)) {
            this.#rpcDispatcher.unregisterProcedure(procName);
            this.emit("unregisterRPC", procName, client);
        }
    }

    #onProcedureCall(client, param) {
        let { groups } = ((() => (RPC_REGEX.exec(param) || { groups: {} }))()); // In-place.
        if (groups.tag) { // Filter invalid.
            let rpc = {
                tag: groups.tag,
                procName: groups.procName,
                args: groups.argString // Do nothing with it (as it is).
            };
            this.#rpcDispatcher.dispatchCall(rpc, (err, request, provider) => {
                if (err) {
                    rpc.callResult = "404"; // ?
                    client.sendRPCResult(rpc);
                    this.emit("clientError", err, rpc);
                } else {
                    provider.sendRPC(request);
                }
            });
        }
    }

    #onProcedureCallResult(client, param) {
        // raw = raw.trim(); // Remove possible (at the beginning) / unnecessary (at the end) whitespaces.
        let { groups } = ((() => (RPC_RESULT_REGEX.exec(param) || { groups: {} }))()); // In-place.
        if (groups.tag && this.#rpcWhitelist[groups.tag]) { // Filter outdated/unknown transactions.
            delete this.#rpcWhitelist[groups.tag]; // Remove from filter list.
            let rpc = {
                masqueradedTag: groups.tag,
                callResult: groups.callResult,
                result: groups.result
            };
            this.#rpcDispatcher.dispatchResult(rpc, (err, response, caller) => {
                if (err) {
                    this.emit("clientError", err, rpc);
                } else {
                    caller.sendRPCResult(response);
                }
            });
        }
    }
}
