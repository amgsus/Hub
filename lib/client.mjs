/*
 * Author: A.G.
 *   Date: 2019/11/25
 */

import { EventEmitter }       from "events";
import { ClientStreamParser } from "./stream.mjs";
import { HubMatcher }         from "./match.mjs";
import { EntityRenderer }     from "./renderer.mjs";

import {
    getStringOrEmpty
} from "./utils.mjs";

import {
    ERROR_MSG,
    SINGLE_SPACE
} from "./consts.mjs";

// ----------------------------------------------------------------------------

const CLIENT_NAME_REGEXP = new RegExp(/^[a-z_][a-z0-9_]*$/i); // User-defined client name.

const LINE_ENDINGS = Object.freeze({
    crlf: "\r\n", cr: "\r", lf: "\n"
});

const SUPPORTED_ENCODINGS = Object.freeze({
    ascii: "ascii",
    utf8: "utf8"
});

const COMMAND_ALIASES = Object.freeze({
    rpc:        "call",
    id:         "identify",
    nickname:   "identify",
    nick:       "identify",
    notify:     "mask",
    ts:         "timestamp",
    sub:        "subscribe",
    unsub:      "unsubscribe"
});

class Command {
    constructor(handler, feature = "") {
        this.handler = handler;
        this.feature = feature;
    }
    exec(...params) { return this.handler(...params) };
}

/**
 * Handlers I/O operations on client's socket.
 */
export class HubConnectionHandler extends EventEmitter {

    id = -1;
    clientName = "";
    remoteAddress;
    #notifyExpression = null;
    timestampFormat;
    opts = {
        retrieveNonExisting: false,
        lineEnding: "lf",
        regexMode: false,
        encoding: "utf8",
        rpcTimeout: 5000
    };
    connectionTime = 0;

    #registeredRPCs = [];
    #rpcWhitelist   = {};
    #parser         = null;
    #maxBufferSize  = 4096;
    #txQueue        = []; // can be 'none', 'abs', and 'rel'// caching remote address, because 'connection' destroys this info after closing
    #commands;
    #socket;
    #server;
    #immediateWriteScheduled;
    #eol = LINE_ENDINGS[this.opts.lineEnding];
    #trace;
    #debug;

    constructor(server, id, socket, opts) {
        super();

        this.id               = id;
        this.remoteAddress    = socket.remoteAddress + ":" + socket.remotePort;
        this.timestampFormat  = "none";
        this.opts = opts;

        this.#socket = socket;
        this.#parser = new ClientStreamParser(this.#socket, this.idString);
        this.#parser.on("data", this.#handle.bind(this));
        this.#socket.setNoDelay(false); // enable Nagle's algorithm to combine small packets before sending
        this.#socket.on("error", this.emit.bind(this, "error"));
        this.#server = server;
        this.#socket.on("close", this.#onDisconnect.bind(this));

        this.#commands = {
            list:           new Command(this.#onList.bind(this)),
            fetch:          new Command(this.#onFetch.bind(this), "fetch"),
            dump:           new Command(this.#onDump.bind(this), "dump"),
            delete:         new Command(this.#onDeleteKey.bind(this), "delete"),
            call:           new Command(this.#onRPCCall.bind(this), "rpc"),
            result:         new Command(this.#onRPCResult.bind(this), "rpc"),
            mask:           new Command(this.#onNotificationMaskSet.bind(this)),
            timestamp:      new Command(this.#onTimestampFormatSet.bind(this)),
            identify:       new Command(this.#onIdentify.bind(this), "identify"),
            regrpc:         new Command(this.#onRPCRegister.bind(this), "rpc"),
            unregrpc:       new Command(this.#onRPCUnregister.bind(this), "rpc"),
            listrpc:        new Command(this.#onRPCList.bind(this), "rpc"),
            online:         new Command(this.#onListOnline.bind(this), "online"),
            echo:           new Command(this.#onEcho.bind(this), "echo"),
            set:            new Command(this.#onOptionSet.bind(this), "options"),
            info:           new Command(this.#onInfo.bind(this), "info"),
            features:       new Command(this.#onSupportedFeatureRequest.bind(this)),
            login:          undefined,
            store:          undefined,
            retrieve:       undefined,
            subscribe:      undefined,
            unsubscribe:    undefined,
            lock:           undefined,
            unlock:         undefined
        };
    }

    get server() { return this.#server; }

    get socket() { return this.#socket; }

    get alive() { return this.socket !== null; }

    get idString() { return `${this.remoteAddress} (ID ${this.id})`; }

    get shortIDString() {
        return this.clientName || `#${this.id}`;
    }

    get logName() {
        if (this.clientName) { // Nickname?
            return `C${this.id}#${this.clientName}`;
        } else {
            return `C${this.id}`;
        }
    }

    get notificationRegExp() { return this.#notifyExpression; }

    get listensAll() { // FIXME: Performance improvement?
        return this.notificationRegExp === HubMatcher.getSingleton().getOrCreateCachedNotificationRegExp("*")
    };

    disconnect() {
        if (this.socket) {
            this.socket.destroy();
        }
    }

    #onDisconnect() {
        this.#socket = null;
        this.#parser.removeAllListeners();
        this.emit("disconnect");
    }

    #writeImplSocket() {
        if (!this.alive) {
            this.#txQueue = [];
            return;
        }
        if (this.#txQueue.length === 0) {
            return;
        }
        let data = this.#txQueue.join("");
        this.#socket.write(data, this.#scheduleWrite.bind(this));
        this.#txQueue = [];
    }

    #scheduleWrite() {
        this.#immediateWriteScheduled =
            setImmediate(this.#writeImplSocket.bind(this));
    }

    /**
     * Writes text to the buffer. Should not be called directly.
     * @param text {string}
     */
    write(text) {
        if (this.#txQueue.length === 0) {
            this.#scheduleWrite(); // Postpone transmission to next tick.
        }
        this.#txQueue.push(text);
        if (this.#txQueue.length > this.#maxBufferSize) {
            this.#txQueue.shift();
        }
    }

    /**
     * The same as @ClientHandler#write but ends line with CRLF desired by client.
     *
     * @param {string} text
     */
    writeLine(text) {
        this.write(`${text}${this.#eol}`);
    }

    sendRPC(rpc) {
        const KEY_CMD_CALL = "call";
        let value = `${rpc.masqueradedTag} ${rpc.procedureName} ${rpc.args}`;
        this.#rpcWhitelist[rpc.masqueradedTag] = true; // TODO: Need?
        this.sendSpecial(KEY_CMD_CALL, value);
    }

    passRPCWhiteList(masqueradedTag) {
        let rpc = this.#rpcWhitelist[masqueradedTag];
        this.excludeRPC(masqueradedTag);
        return !!rpc;
    }

    excludeRPC(masqueradedTag) { // TODO: Need?
        delete this.#rpcWhitelist[masqueradedTag];
    }

    sendRPCResult(rpc) {
        const KEY_CMD_RPC_RESULT = "result";
        let value = `${rpc.tag} ${rpc.callResult} ${rpc.result}`;
        this.sendSpecial(KEY_CMD_RPC_RESULT, value);
    }

    sendSpecial(specialKey, value) {
        this.send(`#${specialKey}`, value);
    }

    sendValue(entity) {
        this.sendValueUsingTimestampRenderer(new EntityRenderer(entity));
    }

    sendValueUsingTimestampRenderer(renderer) {
        this.writeLine(renderer.renderLine(this.timestampFormat));
    }

    send(name, value) {
        return this.write(`${name}=${value}${this.#eol}`);
    }

    #handle(data) {
        if (data.mod === "#") {
            this.#handleFunction(data);
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

    #handleFunction(data) {
        let id = data.key.slice(1);
        let command = this.#getCommandByNameOrAlias(id);
        if (command) {
            if (command.feature) {
                if (!this.#server.isFeatureEnabled(command.feature)) {
                    return;
                }
            }
            command.exec(data.value, data, this.#respond.bind(this, data));
        }
    }

    #respond(data, response) {
        if (response) {
            if (typeof response === "object") {
                this.sendObject(data.key, response);
            } else {
                this.send(data.key, response);
            }
        }
    }

    setSubscriptionMaskOrRegExp(maskOrRegExp, emitEvent = true, emitOnlyIfChanged = true) {
        let updated;
        if (maskOrRegExp) {
            if (!(maskOrRegExp instanceof RegExp)) {
                let s = `${maskOrRegExp}`.trim(); // FIXME: Cast to string.
                maskOrRegExp = HubMatcher.getSingleton().getOrCreateCachedNotificationRegExp(s);
            }
            updated = ( this.#notifyExpression !== maskOrRegExp );
            this.#notifyExpression = maskOrRegExp;
        } else {
            updated = ( this.#notifyExpression !== null );
            this.#notifyExpression = null;
        }
        if (emitEvent && (updated || !emitOnlyIfChanged)) {
            this.emit("subscriptionUpdate");
        }
    }

    #onNotificationMaskSet(mask) {
        this.setSubscriptionMaskOrRegExp(mask, true, true); // Emit event if different than current mask.
    }

    #onTimestampFormatSet(format) {
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

    #onIdentify(param, data) {
        param = getStringOrEmpty(param).trim();
        if (param === "?" || (data.q && !data.value)) { // "#id=?" or "#id?".
            this.send(data.key, this.clientName); // Return current ID.
        } else {
            if (param !== this.clientName) {
                if (CLIENT_NAME_REGEXP.test(param)) {
                    this.clientName = param;
                    this.emit("identify", param);
                } else {
                    this.send(data.key, ERROR_MSG);
                }
            }
        }
    }

    #onDeleteKey(param) {
        let topicName = (param || "").trim();
        if (topicName) {
            this.emit("delete", topicName);
        }
    }

    #onList(pattern) {
        this.emit("list", (pattern || "*").trim());
    }

    #onFetch(pattern, data, respond) {
        this.emit("fetch", (pattern || "").trim(), respond);
    }

    #onDump(pattern, data, respond) {
        this.emit("dump", (pattern || "").trim(), respond);
    }

    #onListOnline(param, data, respond) {
        this.emit("listOnline", (param || "").trim(), respond);
    }

    #onRPCCall(param) {
        param = (param || "").trimStart();
        if (param) {
            this.emit("rpc", param);
        }
    }

    #onRPCRegister(name) {
        this.emit("registerRPC", name);
        // FIXME
        //this.#registeredRPCs.push(name);
    }

    #onRPCUnregister(name) {
        // FIXME
        // let i = this.#registeredRPCs.indexOf(name);
        // if (i < 0) return;
        // this.#registeredRPCs.splice(i, 1); // Delete it from array.
        this.emit("unregisterRPC", name);
    }

    #onRPCList(pattern) {
        pattern = (pattern || "").trim();
        this.emit("listRPCs", pattern || "*");
    }

    #onRPCResult(param) {
        this.emit("result", param);
    }

    /**
     * Echo value back to client. Can be useful for testing purposes.
     *
     * @param {string} param
     *      String format "<keyName> <value>", delimited with single space.
     */
    #onEcho(param) {
        param = (param || "").trim();
        let [ keyName, value ] = param.split(SINGLE_SPACE, 2);
        keyName = keyName.trim();
        if (keyName) {
            if (keyName.indexOf("=") < 0) { // TODO: Make good validation for key's name.
                this.send(keyName, value || "");
            }
        }
    }

    /**
     * Set server's behavioral options for this client.
     *
     * @param {string} param
     *      String format "<optionName> <value>", delimeted with single space.
     */
    #onOptionSet(param) {
        param = (param || "").trim();
        let [ optionName, value ] = param.split(SINGLE_SPACE, 2);
        optionName = optionName.trim();
        let changed = false;
        let err = false;
        let enabled;
        switch (optionName) {
            case "retrieveNonExisting": // Respond with empty value if non-existing key is requested.
                value = value.trim();
                enabled = (value === "1" || value === "true");
                err = (value !== "0" && value !== "false");
                if (!err) {
                    changed = (this.opts[optionName] !== enabled);
                    this.opts[optionName] = enabled;
                }
                break;
            case "lineEnding": // Change line ending.
                if (LINE_ENDINGS[value]) {
                    changed = (this.opts[optionName] !== value);
                    this.opts[optionName] = value;
                    this.#eol = LINE_ENDINGS[value];
                } else {
                    err = true;
                }
                break;
            case "regexMode": // TODO: When enabled, notification mask is passed as it is to RegExp constructor.
                value = value.trim();
                enabled = (value === "1" || value === "true");
                err = (value !== "0" && value !== "false");
                if (!err) {
                    changed = (this.opts[optionName] !== enabled);
                    this.opts[optionName] = enabled;
                }
                break;
            case "encoding": // TODO
                if (SUPPORTED_ENCODINGS[value]) {
                    changed = (this.opts[optionName] !== value);
                    this.opts[optionName] = value;
                } else {
                    err = true;
                }
                break;
            case "rpcTimeout": // Sets timeout on server to wait before return 502 to caller.
                this.emit("adjustRPCTimeout", Number(value), (value) => {
                    if (typeof value === "number") {
                        changed = (this.opts[optionName] !== value);
                        this.opts[optionName] = value;
                    } else {
                        err = true;
                    }
                });
                break;
        }
        if (err) {
            this.send("#set", "ERROR");
        } else {
            if (changed) {
                this.emit("optionSet", optionName);
            }
            this.send("#set", `${optionName} ${this.opts[optionName]}`); // Always provide feedback to client.
        }
    }

    #getCommandByNameOrAlias(commandName) {
        let resolvedName = COMMAND_ALIASES[commandName] || commandName;
        return this.#commands[resolvedName] || null;
    }

    /**
     * Responds with information of host. The payload is application-defined.
     *
     * This event is passed to upper-level layer (application level).
     *
     * @param param
     * @param data
     * @param respond
     */
    #onInfo(param, data, respond) {
        param = getStringOrEmpty(param).trim();
        if (param === "?" || (data.q && !data.value)) { // "#info=?" "#info?"
            this.emit("infoRequest", respond);
        }
    }

    sendObject(keyName, value) {
        this.send(keyName, JSON.stringify(value));
    }

    #onSupportedFeatureRequest(param, data, respond) {
        this.emit("featureRequest", respond);
    }
}
