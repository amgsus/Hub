/*
 * Author: A.G.
 *   Date: 2019/11/25
 */

import { EventEmitter }       from "events";
import { Socket }             from "net";
import NotifyExpression       from "./match.mjs";
import { ClientStreamParser } from "./stream.mjs";

import {
    RPC_REGEX,
    RPC_RESULT_REGEX
} from "./rpc.mjs";

// ----------------------------------------------------------------------------

const EOL = "\r\n";

/**
 * @emits disconnect
 */
export class ClientHandler extends EventEmitter {

    #registeredRPCs = [];
    #rpcWhitelist = {};

    /**
     * @type {ClientStreamParser}
     */
    #parser = null;

    /**
     * @param id {string}
     * @param socket {Socket}
     * @param notify {string}
     * @param tsFormat {string}
     */
    constructor(id, socket, notify, tsFormat) {
        super();
        this.id         = id;
        this.clientName = "";
        this.remoteAddress    = socket.remoteAddress + ":" + socket.remotePort; // caching remote address, because 'connection' destroys this info after closing
        this.notifyExpression = NotifyExpression(notify);
        this.timestampFormat  = tsFormat || "none"; // can be 'none', 'abs', and 'rel'
        this.maxBufferSize    = 4096;
        this._txQueue         = [];
        this._socket          = socket;
        this.#parser          = new ClientStreamParser(this._socket);
        this._socket.setNoDelay(false); // enable Nagle's algorithm to combine small packets before sending
        this._socket.on("close", this.__onDisconnect.bind(this));
        this._socket.on("error", this.emit.bind(this, "error"));
        this.#parser.on("data", this.__handle.bind(this));
    }

    get socket() { return this._socket; }

    get alive() { return this.socket !== null; }

    get idString() { return `Client ${this.remoteAddress} (ID ${this.id})`; }

    __onDisconnect() {
        this._socket = null;
        this.#parser.removeAllListeners();
        this.emit("disconnect");
    }

    __doWrite() {
        if (!this.alive) {
            this._txQueue = [];
            return;
        }
        if (this._txQueue.length === 0) {
            return;
        }
        this._socket.write(this._txQueue.join(""), this.__doWrite.bind(this)); // TODO: Was __scheduleWrite.
        this._txQueue = [];
    }

    __scheduleWrite() { setImmediate(this.__doWrite.bind(this)); }

    /**
     * Writes text to the buffer. Should not be called directly.
     * @param text {string}
     */
    write(text) {
        if (this._txQueue.length === 0) {
            this.__scheduleWrite();
        }
        this._txQueue.push(text);
        if (this._txQueue.length > this.maxBufferSize) {
            this._txQueue.shift();
        }
    }

    __setNotificationWildcard(mask) {
        mask = mask.replace(/^\s+|\s+$/g, ''); // trim spaces from mask before checkings
        let expr       = NotifyExpression(mask); // get value from cache or generate new if necessary
        let hasChanges = (this.notifyExpression !== expr);
        if (!hasChanges) {
            return;
        }
        this.notifyExpression = expr;
        this.emit("notifyChange");
    }

    __setTimestampFormat(format) {
        format = format.replace(/^\s+|\s+$/g, ""); // trim spaces from format
        if ((format !== "abs") && (format !== "rel")) {
            format = "none";
        }
        let hasChanges = (this.timestampFormat !== format);
        if (!hasChanges) {
            return;
        }
        this.timestampFormat = format;
        this.emit("timestampFormatChange", this.timestampFormat);
    }

    /**
     * @param name {string}
     */
    __updateClientName(name) {
        if (name !== this.clientName) {
            this.clientName = name;
            this.emit("identify", this.clientName);
        }
    }

    /**
     * @param topicName {string}
     */
    __onDeleteTopic(topicName) {
        topicName = topicName.trim();
        if (topicName) {
            this.emit("delete", topicName);
        }
    }

    /**
     * Parses a request for a remote procedure call (RPC). If the request is
     * valid, notifies the upper-level code by emitting an event to continue
     * processing of the request.
     *
     * @param raw {string}
     *
     * @emits rpc
     */
    __onRPCallPacket(raw) {
        let { groups } = ((() => (RPC_REGEX.exec(raw) || { groups: {} }))()); // In-place.
        if (groups.tag) { // Filter invalid.
            this.emit("rpc", {
                tag: groups.tag,
                procName: groups.procName,
                args: groups.argString // Do nothing with it (as it is).
            });
        }
    }

    /**
     * Parses a provider's response for a remote procedure call (RPC).
     *
     * TODO: Doc.
     *
     * @param raw {string}
     *
     * @emits result
     */
    __onProvidersRPCallResultPacket(raw) {
        // raw = raw.trim(); // Remove possible (at the beginning) / unnecessary (at the end) whitespaces.
        let { groups } = ((() => (RPC_RESULT_REGEX.exec(raw) || { groups: {} }))()); // In-place.
        if (groups.tag && this.#rpcWhitelist[groups.tag]) { // Filter outdated/unknown transactions.
            delete this.#rpcWhitelist[groups.tag]; // Remove from filter list.
            this.emit("result", {
                masqueradedTag: groups.tag,
                callResult: groups.callResult,
                result: groups.result
            });
        }
    }

    __setNotificationRegex(data) {
        this.emit(`regex`, new RegExp(data));
    }

    __registerRPC(name) {
        this.emit(`registerRPC`, name);
        this.#registeredRPCs.push(name);
    }

    __unregisterRPC(name) {
        let i = this.#registeredRPCs.indexOf(name);
        if (i < 0) return;
        this.#registeredRPCs.splice(i, 1); // Delete it from array.
        this.emit(`unregisterRPC`, name);
    }

    __direct(param) { // TODO
    }

    /**
     * Dispatch.
     *
     * @param data {Object}
     */
    __handle(data) {
        if (data.mod === "#") {
            this.__handleFunction(data);
        } else {
            if (data.q && !data.ts && !data.mod) { // key?[=value]
                this.emit("retrieve", data.key, data.value);
            } else {
                let ts = undefined;
                if (data.ts) {
                    if (data.ts < 0) {
                        ts = Date.now() + data.ts;
                    } else {
                        ts = data.ts;
                    }
                } else {
                    ts = Date.now();
                }
                if (data.mod === "~") {
                    let newKey = data.key.slice(1);
                    this.emit("publish", newKey, data.value, ts);
                } else if (!data.mod) {
                    this.emit("store", data.key, data.value, ts);
                }
            }
        }
    }

    __handleFunction(packet) {
        let param = packet.value || "";
        switch (packet.key) {
            case "#list":
                this.emit("list", packet.value || "");
                break;
            case "#rpc":
            case "#call":
                this.__onRPCallPacket(param); // Request (caller).
                break;
            case "#result":
                this.__onProvidersRPCallResultPacket(param); // Response (provider).
                break;
            case "#mask":
            case "#notify":
                this.__setNotificationWildcard(param);
                break;
            case "#regex":
                this.__setNotificationRegex(param);
                break;
            case "#delete":
                this.__onDeleteTopic(param);
                break;
            case "#timestamp": // TODO: Deprecated. Backward compatibility with old version.
            case "#ts":
                this.__setTimestampFormat(param);
                break;
            case `#id`:
                this.__updateClientName(param);
                break;
            case "#regrpc":
                this.__registerRPC(param);
                break;
            case "#unregrpc":
                this.__unregisterRPC(param);
                break;
            case "#listrpc":
                this.emit("listRPCs", param || "*");
                break;
            case "#help":
                this.__help(param);
                break;
            case "#direct":
                this.__direct(param);
                break;
            case "#online":
            case "#clientlist":
                this.emit(`listClients`, param || `*`);
                break;
        }
    }

    /**
     * @param rpc {Object}
     */
    sendRPC(rpc) {
        this.write(`#rpc=${rpc.masqueradedTag} ${rpc.procName} ${rpc.args}${EOL}`);
        this.#rpcWhitelist[rpc.masqueradedTag] = true;
    }

    /**
     * @param rpc { {tag:string, callResult:string, result?:string} }
     */
    sendRPCResult(rpc) {
        this.write(`#result=${rpc.tag} ${rpc.callResult} ${rpc.result}${EOL}`);
    }

    notify(topic) {
        let s = "";
        let tsField = `ts${this.timestampFormat}`;
        if (typeof topic[tsField] !== 'undefined') {
            s = `${topic.id}@${topic[tsField]}=${topic.value}${EOL}`;
        } else {
            s = `${topic.id}=${topic.value}${EOL}`;
        }
        this.write(s);
    }

    /**
     * @param name {string}
     * @param value {*}
     */
    send(name, value) {
        return this.write(`${name}=${value}${EOL}`);
    }

    /**
     * Context help handler.
     * @param command {string} - Command name or empty string.
     */
    __help(command) {
        let man = "";
        switch (command) {
            case "regrpc":
                man = "regrpc <procName>: registers remote procedure for this connection";
                break;
            case "unregrpc":
                man = "unregrpc <procName>: unregisters remote procedure previously registered on this connection";
                break;
            case "listrpc":
                man = "listrpc [<mask>]: list all remote procedures that are currently registered on Hub";
                break;
            case "rpc":
                man = "rpc <tag> <procName> [<arg0> ... <argN>]: calls a remote procedure";
                break;
            case "result":
                man = "result <tag> <errorCode> [<data>]: returns a result for a procedure call";
                break;
            case "delete":
                man = "delete <name>: deletes any value from Hub, non-restricted";
                break;
            case "direct":
                man = "send <id> <topic> <value>: writes value directly (without caching) to identified client";
                break;
            // TODO: Add manual.
            default:
                let allCommands = [
                    "help", "ts", "rpc", "list", "result", "mask", "notify", "regex",
                    "delete", "timestamp", "id", "regrpc", "unregrpc", "listrpc", "online"
                ];
                man = allCommands.sort().join(' ');
                break;
        }
        this.write(`#help=${man}${EOL}`)
    }
}
