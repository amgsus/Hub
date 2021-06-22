/*
 * By:              A.G.
 * Created on:      2019.11.25
 * Last modified:   2020.07.23
 */

import { EventEmitter, once } from "events";
import { Server }             from "net";
import { ClientHandler }      from "./client.mjs";
import NotifyExpression from "./match.mjs";
import { createLogger } from "./../app/logging.mjs";

// ----------------------------------------------------------------------------

const log = createLogger(`Hub(class)`);

const TIMESTAMP_ABSOLUTE = "abs";
const TIMESTAMP_RELATIVE = "rel";
const TIMESTAMP_NONE     = "none";

// ----------------------------------------------------------------------------

// TODO: Do not use logger. Pass everything via events to upper-level code.

// Variable
// Topic
// Channel

/**
 * @emits accept - when a new client has connected.
 * @emits disconnect - when a client has disconnected or connection is lost.
 * @emits listening - when the server starts to accept connections.
 * @emits stop - when the server stops.
 * @emits error - when an error occurs (and server cannot continue to perform normally). The server does not emit this event, if a client socket throws an error.
 */
export class Hub extends EventEmitter {

    #server = new Server({}, this.__acceptConnection.bind(this)); // TODO: Why is "*" here?
    #nextClientID = 0;
    #nextRPCallID = 0;
    clients = []; // Connected clients (handlers).
    #listeningPort = 7788;
    #interfaceBinding = ``;
    variablesMap = {}; // hash-table [path -> entry]
    variablesArray = []; // Array-Mirror for variablesMap values (for easier iterating over variables)
    creatingEmptyChannelsUponRequest = false; // TODO: Pass through arguments.
    #listening = false; // TODO: -> listening
    #rpcProviders = {};
    #pendingRPCs = {};
    rpcTimeout = 5000;

    constructor() { super();
        this.#server.on(`error`, this.emit.bind(this, `error`)); // Bypass.
    }

    /**
     * @param port {number?}
     * @returns {Promise}
     */
    async listen(port) {
        if (this.#listening) {
            return Promise.resolve();
        } else {
            if (port) {
                this.#listeningPort = Number(port);
            }
            return new Promise((resolve, reject) => {
                this.#server.listen(this.#listeningPort, this.#interfaceBinding);
                once(this.#server, `listening`).then(this._onServerListening.bind(this, resolve)).catch(reject);
            });
        }
    }

    _onServerListening(cb) {
        this.#listening = true;
        this.emit(`listening`, this, this.#listeningPort, this.#interfaceBinding);
        cb();
    }

    get listening() { return this.#listening; }

    get numOfConnections() { return this.clients.length; }

    async stop() { // FIXME: Promise.
        new Promise((resolve) => {
            this.#server.once(`close`, resolve);
            this.#server.close();
            this.#listening = false;
            setTimeout(resolve, 3000); // Force callback even if event not fired.
        }).then(() => {
            this.emit(`stop`);
        });
    }

    __acceptConnection(connection) {
        let client = new ClientHandler(this.__getUniqueClientID(), connection, "*", "none");
        this.clients.push(client);

        let notifyExpression = client.notifyExpression;
        for (let i = 0, len = this.variablesArray.length; i < len; i += 1) {
            let entry = this.variablesArray[i];
            if (notifyExpression.test(entry.path)) {
                entry.subscribers.push(client);
            }
        }

        client.on("error", this._onClientError.bind(this, client));
        client.on("disconnect", this._onClientClose.bind(this, client));
        client.on("store", this._onClientStore.bind(this, client));
        client.on("list", this._onClientList.bind(this, client));
        client.on("publish", this._onClientPublish.bind(this, client));
        client.on("retrieve", this._onClientRetrieve.bind(this, client));
        client.on("identify", this._onClientIdentification.bind(this, client));
        client.on("delete", this._onClientDeleteChannel.bind(this, client));
        client.on("notifyChange", this._onClientNotifyChange.bind(this, client));
        client.on("rpc", this.__onProcedureCall.bind(this, client));
        client.on("result", this.__onProcedureCallResult.bind(this, client));
        client.on("registerRPC", this.__onClientRegistersRPC.bind(this, client));
        client.on("unregisterRPC", this.__onClientUnregistersRPC.bind(this, client));
        client.on("listRPCs", this.__onClientListRPCs.bind(this, client));
        client.on("listClients", this.__onClientListClients.bind(this, client));

        this.emit(`accept`, {
            id: client.id,
            remoteAddress: client.remoteAddress,
            socket: client.socket
        });
    }

    /**
     * @param client {ClientHandler}
     * @param mask {string}
     */
    __onClientListClients(client, mask) { // TODO: Mask.
        let allClientsString = this.clients.map((c) => c.remoteAddress).join(" "); // TODO: Response format?
        client.send("#online", allClientsString);
    }

    __onClientListRPCs(client, mask) {
        let nexp = NotifyExpression(mask);
        let data = Object.keys(this.#rpcProviders).filter((s) => nexp.test(s)).join(' ');
        client.send("#rpclist", data.trimRight());
    }

    __onClientRegistersRPC(client, procName) {
        if (!this.#rpcProviders[procName]) {
            this.#rpcProviders[procName] = client;
            log.debug(`${client.idString} has registered RPC: ${procName}`);
        } else {
            log.debug(`${client.idString}: RPC registration failed: procName already exists: ${procName}`);
        }
    }

    __onClientUnregistersRPC(client, procName) {
        if (this.#rpcProviders[procName]) {
            if (this.#rpcProviders[procName] === client) {
                delete this.#rpcProviders[procName];
                log.debug(`${client.idString}: Unregistered RPC: ${procName}`);
            } else {
                log.debug(`Denied to unregister RPC: ${procName}: ${client.idString} is not its provider`);
            }
        }
    }

    /**
     * @param client {ClientHandler}
     * @param rpc {Object}
     */
    __onProcedureCall(client, rpc) {
        let provider = this.#rpcProviders[rpc.procName]; // ClientHandler
        if (provider) {
            rpc.masqueradedTag = this.__getUniqueRPCallID();
            provider.sendRPC(rpc);
            let tout = setTimeout(this.__handleProcedureCallTimeout.bind(this), this.rpcTimeout, rpc);
            this.#pendingRPCs[rpc.masqueradedTag] = { timeoutHandle: tout, rpc, client, provider };
            // log.trace(`${client.idString}: Relayed RPC to provider ${provider.remoteAddress} (ID ${provider.id}): ${rpc.procName}`);
        } else {
            rpc.callResult = "404";
            client.sendRPCResult(rpc);
            log.debug(`${client.idString}: No such procedure: ${rpc.procName}`)
        }
    }

    /**
     * @param rpc {Object}
     */
    __handleProcedureCallTimeout(rpc) {
        if (this.#pendingRPCs[rpc.masqueradedTag] === rpc) {
            rpc.callResult = "502";
            rpc.client.sendRPCResult(rpc);
            delete this.#pendingRPCs[rpc.masqueradedTag];
        }
    }

    /**
     * @param client {ClientHandler}
     * @param rpc {Object}
     */
    __onProcedureCallResult(client, rpc) {
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

    _onClientError(client, error) {
        log.error(`${client.idString} fault occurred: ${error.stack}`);
    }

    _onClientIdentification(client) {
        log.info (`${client.idString} has been identified as "${client.clientName}"`);
    }

    _onClientDeleteChannel(client, channelName) {
        let i = this.variablesArray.findIndex((obj) => (obj.path === channelName));
        if (i >= 0) {
            this.variablesArray.splice(i, 1);
            delete this.variablesMap[channelName];
            log.trace(`${client.idString} has deleted a channel: ${channelName}`);
            log.silly(`There are ${this.variablesArray.length} channel(s) remained in the cache`);
        } else {
            log.trace(`${client.idString} has requested to delete a channel '${channelName}', but such channel does not exist`);
        }
    }

    _onClientClose(client) {
        let index  = 0;
        // unsubscribe from all variables
        for (let i = 0, len = this.variablesArray.length; i < len; i += 1) {
            let subscribers = this.variablesArray[i].subscribers;
            if ((index = subscribers.indexOf(client)) !== -1) {
                subscribers.splice(index, 1);
            }
        }

        this.__unregisterClientsRPCs(client, `${client.idString} disconnects`);
        index = this.clients.indexOf(client);
        this.clients.splice(index, 1); // Remove entry from clients[].
        client.removeAllListeners();

        this.emit(`disconnect`, {
            id: client.id,
            remoteAddress: client.remoteAddress,
            socket: null
        });
    }

    __unregisterClientsRPCs(client, reason = "") {
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

    _onClientNotifyChange(client) {
        let notifyExpression = client.notifyExpression;
        for (let i = 0, len = this.variablesArray.length; i < len; i += 1) {
            let path        = this.variablesArray[i].path;
            let subscribers = this.variablesArray[i].subscribers;
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

    _onClientList(client, mask) {
        let notifyExpression = NotifyExpression(mask);
        let data = this.variablesArray
            .filter((entry) => notifyExpression.test(entry.path))
            .map((entry) => {
                return Hub.buildPayload({
                    path: entry.path,
                    value: entry.value,
                    ts: entry.ts
                }, client.timestampFormat);
            }).join('');
        client.write(data);
    }

    /**
     * @param client {ClientHandler}
     * @param path {string}
     * @param defaultValue {string}
     */
    _onClientRetrieve(client, path, defaultValue) {
        // LOGGER.silly(`Client #${client.id} asked for "${path}"`);
        let notifying = true;
        let entry = this.variablesMap[path];
        if (!entry) {
            if (this.creatingEmptyChannelsUponRequest) {
                // this line will add variable, set it's default value and notify clients
                this._onClientStore(client, path, defaultValue, Date.now());
                entry = this.variablesMap[path]; // reread value
            } else {
                notifying = false;
            }
        }
        if (notifying) {
            let packet = Hub.buildPayload({
                path,
                value: entry.value,
                ts: entry.ts
            }, client.timestampFormat);
            client.write(packet);
        }
    }

    _onClientStore(client, path, value, ts) {
        let entry = this.variablesMap[path];
        // check if var is already stored in cache
        if (!entry) {
            entry = {
                path: path,
                value: null,
                ts: null,
                subscribers: this.clients.filter(function (client2) {
                    return client2.notifyExpression.test(path);
                })
            };
            this.variablesMap[path] = entry;
            this.variablesArray.push(entry);
            log.trace(`Client ${client.clientName || client.id} has created a channel: ${entry.path}`);
            log.silly(`Total channels in the cache: ${this.variablesArray.length}`);
        }
        // store latest value only
        if (ts > entry.ts) {
            entry.value = value;
            entry.ts    = ts;
        }
        // notify clients about var update
        setImmediate(this._notifySubscribers.bind(this, entry.subscribers, path, value, ts, client));
    }

    _onClientPublish(client, path, value, ts) {
        let subscribers = this.clients.filter((c) => c.notifyExpression.test(path));
        setImmediate(this._notifySubscribers.bind(this, subscribers, path, value, ts, client));
    }

    _notifySubscribers(subscribers, path, value, ts, exclude) {
        let packetCache = Hub.buildPayloadWithCachedTimestamps({path, value, ts});
        for (let i = 0; i < subscribers.length; i += 1) {
            let client = subscribers[i];
            if (client === exclude) {
                continue;
            }
            client.write(packetCache[client.timestampFormat]);
        }
    }

    static buildPayload(data, tsMode = TIMESTAMP_NONE) {
        switch (tsMode) {
            case TIMESTAMP_ABSOLUTE:
                return `${data.path}@${data.ts}=${data.value}\n`; // [ data.path, '@', data.ts, '=', data.value, '\n' ].join('');
            case TIMESTAMP_RELATIVE:
                let ts = ((data.ts - Date.now()) || '-0');
                return `${data.path}@${ts}=${data.value}\n`; // [ data.path, '@', ((data.ts - Date.now()) || '-0'), '=', data.value, '\n' ].join('');
            default:
                return `${data.path}=${data.value}\n`; // [ data.path, '=', data.value, '\n' ].join('');
        }
    }

    static buildPayloadWithCachedTimestamps(data) {
        let cache = {};
        cache[TIMESTAMP_ABSOLUTE] = this.buildPayload(data, TIMESTAMP_ABSOLUTE);
        cache[TIMESTAMP_RELATIVE] = this.buildPayload(data, TIMESTAMP_RELATIVE);
        cache[TIMESTAMP_NONE] = this.buildPayload(data, TIMESTAMP_NONE);
        return cache;
    }




    __getUniqueClientID() {
        let id = this.#nextClientID;
        this.#nextClientID++;
        return id;
    }

    __getUniqueRPCallID() {
        let id = this.#nextRPCallID;
        this.#nextRPCallID++;
        return id;
    }
}
