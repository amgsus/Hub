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
    popCallback,
    isDefined,
    toNumber,
    createPromiseBasedOn
} from "./utils.mjs";

// ----------------------------------------------------------------------------

const log = createLogger(`Hub(class)`);

const TIMESTAMP_ABSOLUTE = "abs";
const TIMESTAMP_RELATIVE = "rel";
const TIMESTAMP_NONE     = "none";

// ----------------------------------------------------------------------------

// TODO: Do not use logger. Pass everything via events to upper-level code.

export class Entry {
    path = "";
    value = "";
    ts = null;
    subscribers = [];

    constructor(path, value = "", ts = null) {
        this.path = path;
        this.value = value;
        this.ts = ts;
    }
}

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
    #nextRPCallID = 0;
    #clients = []; // Connected clients (handlers).
    #listeningPort = 7778;
    #host = ``;
    #variablesMap = {}; // hash-table [path -> entry]
    #dictionary = []; // Array-Mirror for variablesMap values (for easier iterating over variables)
    #creatingEmptyChannelsUponRequest = false; // TODO: Pass through arguments.
    #rpcProviders = {};
    #pendingRPCs = {};
    #rpcTimeout = 5000;
    #defaultNotificationMask;

    constructor(opts) {
        super();
        this.#server.on("error", this.emit.bind(this, "error"));
        this.#server.on("close", this.emit.bind(this, "stop" ));
        this.#defaultNotificationMask = `${opts.defaultNotificationMask}` || "*";
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
                if (err) console.error(err); // FIXME: Use logger.
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
            client.disconnect();
        }
    }

    exists(keyName) {
        return !!this.#variablesMap[keyName];
    }

    createEntry(keyName, value = "") {
        let entry = new Entry(keyName, value, null);
        entry.subscribers = this.#clients.filter((c) => {
            return c.notifyExpression.test(keyName);
        });
        this.#variablesMap[keyName] = entry;
        this.#dictionary.push(entry);
        return entry;
    }

    getOrCreateEntry(keyName) {
        if (!this.exists(keyName)) {
            return this.createEntry(keyName);
        }
        return this.#variablesMap[keyName];
    }

    deleteValue(keyName) {
        keyName = (keyName || "").trim();
        if (keyName) {
            let i = this.#dictionary.findIndex((obj) => (obj.path === keyName));
            if (i >= 0) {
                this.#dictionary.splice(i, 1);
                delete this.#variablesMap[keyName];
            }
        }
    }

    updateValue(name, value, notifySubscribers = true) {
        let entry = this.getOrCreateEntry(name);
        entry.value = value;
        if (notifySubscribers) {
            this.#scheduleSubscribersNotification(entry, entry.subscribers, null);
        }
    }

    get numOfConnections() { return this.#clients.length; }

    #acceptConnection(connection) {
        let client = new ClientHandler(this, this.#getUniqueClientID(), connection,
            this.#defaultNotificationMask, "none");
        this.#clients.push(client);
        client.connectionTime = Date.now(); // Used by #online to calculate up-time.

        let notifyExpression = client.notifyExpression;
        for (let i = 0, len = this.#dictionary.length; i < len; i += 1) {
            let entry = this.#dictionary[i];
            if (notifyExpression.test(entry.path)) {
                entry.subscribers.push(client);
            }
        }

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
        client.on("listRPCs", this.#onClientListRPCs.bind(this, client));
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
        let fltEntries = this.#dictionary;
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
        let fltEntries = this.#dictionary;
        if (mask && mask !== "*") {
            let expr = mask instanceof RegExp ? mask : getTestExpression(mask);
            fltEntries = fltEntries.filter((entry) => expr.test(entry.path));
        }
        let keys = fltEntries.map((entry) => entry.path);
        let responseText = JSON.stringify(keys);
        client.send("#fetch", responseText);
    }

    #onClientListRPCs(client, mask) {
        let nexp = getTestExpression(mask);
        let data = Object.keys(this.#rpcProviders).filter((s) => nexp.test(s)).join(' ');
        client.send("#rpclist", data.trimRight());
    }

    #onClientRegistersRPC(client, procName) {
        if (!this.#rpcProviders[procName]) {
            this.#rpcProviders[procName] = client;
            this.emit(`registerRPC`, client, procName);
        } else {
            log.trace(`${client.idString}: RPC registration failed: procName already exists: ${procName}`);
        }
    }

    #onClientUnregistersRPC(client, procName) {
        if (this.#rpcProviders[procName]) {
            if (this.#rpcProviders[procName] === client) {
                delete this.#rpcProviders[procName];
                this.emit(`unregisterRPC`, client, procName);
            } else {
                log.trace(`Denied to unregister RPC: ${procName}: ${client.idString} is not its provider`);
            }
        }
    }

    #onProcedureCall(client, rpc) {
        let provider = this.#rpcProviders[rpc.procName]; // ClientHandler
        if (provider) {
            rpc.masqueradedTag = this.#getUniqueRPCallID();
            provider.sendRPC(rpc);
            let tout = setTimeout(this.#handleProcedureCallTimeout.bind(this), this.#rpcTimeout, rpc);
            this.#pendingRPCs[rpc.masqueradedTag] = { timeoutHandle: tout, rpc, client, provider };
            // log.trace(`${client.idString}: Relayed RPC to provider ${provider.remoteAddress} (ID ${provider.id}): ${rpc.procName}`);
        } else {
            rpc.callResult = "404";
            client.sendRPCResult(rpc);
            log.debug(`${client.idString}: No such procedure: ${rpc.procName}`)
        }
    }

    #handleProcedureCallTimeout(rpc) {
        if (this.#pendingRPCs[rpc.masqueradedTag] === rpc) {
            rpc.callResult = "502";
            rpc.client.sendRPCResult(rpc);
            delete this.#pendingRPCs[rpc.masqueradedTag];
        }
    }

    #onProcedureCallResult(client, rpc) {
        if (this.#pendingRPCs[rpc.masqueradedTag]) {
            clearTimeout(this.#pendingRPCs[rpc.masqueradedTag].timeoutHandle);
            this.#pendingRPCs[rpc.masqueradedTag].tag = this.#pendingRPCs[rpc.masqueradedTag].rpc.tag;
            this.#pendingRPCs[rpc.masqueradedTag].result = rpc.result;
            this.#pendingRPCs[rpc.masqueradedTag].callResult = rpc.callResult;
            this.#pendingRPCs[rpc.masqueradedTag].client.sendRPCResult(this.#pendingRPCs[rpc.masqueradedTag]);
            // log.trace(`${this.#pendingRPCs[rpc.masqueradedTag].provider.idString}: Relayed RPC result to ${this.#pendingRPCs[rpc.masqueradedTag].client.idString}: ${this.#pendingRPCs[rpc.masqueradedTag].rpc.procName}`);
            delete this.#pendingRPCs[rpc.masqueradedTag];
        }
    }

    #onClientError(client, error) {
        log.error(`${client.idString} fault occurred: ${error.stack}`);
    }

    #onClientIdentification(client) {
        this.emit(`identification`, client, client.clientName);
    }

    #onClientDeleteValue(client, keyName) {
        if (this.deleteValue(keyName)) {
            log.trace(`${client.idString} has deleted a channel: ${keyName}`);
            log.silly(`There are ${this.#dictionary.length} channel(s) remained in the cache`);
        } else {
            log.trace(`${client.idString} has requested to delete a channel '${keyName}', but such channel does not exist`);
        }
    }

    #onClientClose(client) {
        let index  = 0;
        // unsubscribe from all variables
        for (let i = 0, len = this.#dictionary.length; i < len; i += 1) {
            let subscribers = this.#dictionary[i].subscribers;
            if ((index = subscribers.indexOf(client)) !== -1) {
                subscribers.splice(index, 1);
            }
        }

        this.#unregisterClientsRPCs(client, `${client.idString} disconnects`);
        index = this.#clients.indexOf(client);
        this.#clients.splice(index, 1); // Remove entry from clients[].
        client.removeAllListeners();

        this.emit(`disconnect`, {
            id: client.id,
            remoteAddress: client.remoteAddress,
            socket: null
        });
    }

    #unregisterClientsRPCs(client, reason = "") {
        if (reason) {
            reason = `. Reason: ${reason}`;
        }
        let all = Object.keys(this.#rpcProviders);
        let ownedList = all.filter((procName) => (this.#rpcProviders[procName] === client));
        ownedList.forEach((procName) => {
            delete this.#rpcProviders[procName];
            log.debug(`Unregistered RPC: ${procName}${reason}`);
        });
        // TODO: Delete all linked timers.
    }

    #onClientNotifyChange(client) {
        let notifyExpression = client.notifyExpression;
        for (let i = 0, len = this.#dictionary.length; i < len; i += 1) {
            let path        = this.#dictionary[i].path;
            let subscribers = this.#dictionary[i].subscribers;
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
        let filteredEntries = this.#dictionary.filter((entry) => expr.test(entry.path));
        for ( let ent of filteredEntries ) {
            let payload = this.#buildPayload({
                path: ent.path,
                value: ent.value,
                ts: ent.ts
            }, client.timestampFormat);
            client.writeLine(payload);
        }
    }

    #onClientRetrieve(client, path, defaultValue) {
        let notifying = true;
        let entry = this.#variablesMap[path];
        if (!entry) {
            if (this.#creatingEmptyChannelsUponRequest) {
                // this line will add variable, set it's default value and notify clients
                this.#onClientStore(client, path, defaultValue, Date.now());
                entry = this.#variablesMap[path]; // reread value
            } else {
                if (client.opts.retrieveNonExisting) {
                    entry = new Entry(path);
                } else {
                    notifying = false;
                }
            }
        }
        if (notifying) {
            let packet = this.#buildPayload({
                path,
                value: entry.value,
                ts: entry.ts
            }, client.timestampFormat);
            client.writeLine(packet);
        }
    }

    #onClientStore(client, path, value, ts) {
        let entry = this.#variablesMap[path];
        // check if var is already stored in cache
        if (!entry) {
            entry                    = {
                path: path,
                value: null,
                ts: null,
                subscribers: this.#clients.filter(function (client2) {
                    return client2.notifyExpression.test(path);
                })
            };
            this.#variablesMap[path] = entry;
            this.#dictionary.push(entry);
            log.trace(`Client ${client.clientName || client.id} has created a channel: ${entry.path}`);
            log.silly(`Total channels in the cache: ${this.#dictionary.length}`);
        }
        // store latest value only
        if (ts > entry.ts) {
            entry.value = value;
            entry.ts    = ts;
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
        let id = this.#nextClientID;
        this.#nextClientID++;
        return id;
    }

    #getUniqueRPCallID() {
        let id = this.#nextRPCallID;
        this.#nextRPCallID++;
        return id;
    }

    #onClientOptionSet(client, optionName) {
        log.silly(`${client.idString} set option: ${optionName}=${client.opts[optionName]}`);
    }

    isFeatureEnabled(featureName) { return true; }
}
