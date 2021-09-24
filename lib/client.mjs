/*
 * Author: A.G.
 *   Date: 2019/11/25
 */

import { EventEmitter }                         from "events";
import NotifyExpression                         from "./match.mjs";
import { ClientStreamParser }                   from "./stream.mjs";
import { getStringOrEmpty, validateClientName } from "./utils.mjs";

import {
    ERROR_MSG,
    SINGLE_SPACE
} from "./consts.mjs";

// ----------------------------------------------------------------------------

const CLIENT_NAME_REGEXP = new RegExp(/^[a-z_][a-z0-9_]*$/i); // User-defined client name.

const LINE_ENDINGS = Object.seal({
    crlf: "\r\n", cr: "\r", lf: "\n"
});

const SUPPORTED_ENCODINGS = Object.seal({
    ascii: "ascii",
    utf8: "utf8"
});

const COMMAND_ALIASES = Object.seal({
    call: "rpc",
    id: "identify",
    mask: "notify",
    ts: "timestamp"
});

class Command {
    constructor(handler, feature = "") {
        this.handler = handler;
        this.feature = feature;
    }
    exec(...params) { return this.handler(...params) };
}

export class ClientHandler extends EventEmitter { // TODO: Add @emits

    id = -1;
    clientName = "";
    remoteAddress;
    notifyExpression;
    timestampFormat;
    opts = {
        retrieveNonExisting: false,
        lineEnding: "lf",
        regexMode: false,
        encoding: "utf8"
    };

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

    constructor(server, id, socket, notify, tsFormat, opts) {
        super();

        this.id               = id;
        this.remoteAddress    = socket.remoteAddress + ":" + socket.remotePort;
        this.notifyExpression = NotifyExpression(notify);
        this.timestampFormat  = tsFormat || "none";
        this.opts = opts;

        this.#socket          = socket;
        this.#parser          = new ClientStreamParser(this.#socket);
        this.#parser.on("data", this.#handle.bind(this));
        this.#socket.setNoDelay(false); // enable Nagle's algorithm to combine small packets before sending
        this.#socket.on("error", this.emit.bind(this, "error"));
        this.#server = server;
        this.#socket.on("close", this.#onDisconnect.bind(this));

        this.#commands = Object.seal({
            list:       new Command(this.#onList.bind(this)),
            fetch:      new Command(this.#onFetch.bind(this), "fetch"),
            dump:       new Command(this.#onDump.bind(this), "dump"),
            delete:     new Command(this.#onDeleteKey.bind(this), "delete"),
            rpc:        new Command(this.#onRPCCall.bind(this), "rpc"),
            result:     new Command(this.#onRPCResult.bind(this), "rpc"),
            mask:       new Command(this.#onNotificationMaskSet.bind(this)),
            timestamp:  new Command(this.#onTimestampFormatSet.bind(this)),
            identify:   new Command(this.#onIdentify.bind(this), "identify"),
            regrpc:     new Command(this.#onRPCRegister.bind(this), "rpc"),
            unregrpc:   new Command(this.#onRPCUnregister.bind(this), "rpc"),
            listrpc:    new Command(this.#onRPCList.bind(this), "rpc"),
            online:     new Command(this.#onListOnline.bind(this), "online"),
            echo:       new Command(this.#onEcho.bind(this), "echo"),
            set:        new Command(this.#onOptionSet.bind(this), "options"),
            login:      undefined
        });
    }

    get socket() { return this.#socket; }

    get alive() { return this.socket !== null; }

    get idString() { return `Client ${this.remoteAddress} (ID ${this.id})`; }

    get shortIDString() {
        return this.clientName || `#${this.id}`;
    }

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
        this.send("#rpc", `${rpc.masqueradedTag} ${rpc.procName} ${rpc.args}`);
        this.#rpcWhitelist[rpc.masqueradedTag] = true;
        // FIXME: Add timeout?
    }

    sendRPCResult(rpc) {
        this.send("#result", `${rpc.tag} ${rpc.callResult} ${rpc.result}`);
    }

    notify(topic) { // TODO: Any usages???
        let s = "";
        let tsField = `ts${this.timestampFormat}`;
        if (typeof topic[tsField] !== 'undefined') {
            s = `${topic.id}@${topic[tsField]}=${topic.value}${this.#eol}`;
        } else {
            s = `${topic.id}=${topic.value}${this.#eol}`;
        }
        this.write(s);
    }

    /**
     * @param name {string}
     * @param value {*}
     */
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
            command.exec(data.value, data);
        }
    }

    #onNotificationMaskSet(mask) {
        mask = mask.replace(/^\s+|\s+$/g, ""); // trim spaces from mask before checkings
        let expr       = NotifyExpression(mask); // get value from cache or generate new if necessary
        let hasChanges = (this.notifyExpression !== expr);
        if (!hasChanges) {
            return;
        }
        this.notifyExpression = expr;
        this.emit("notifyChange");
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

    #onFetch(pattern) {
        this.emit("fetch", (pattern || "").trim());
    }

    #onDump(pattern) {
        this.emit("dump", (pattern || "").trim());
    }

    #onListOnline(param) {
        this.emit("listOnline", (param || "").trim());
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
            case "regexMode": // When enabled, notification mask is passed as it is to RegExp constructor.
                value = value.trim();
                enabled = (value === "1" || value === "true");
                err = (value !== "0" && value !== "false");
                if (!err) {
                    changed = (this.opts[optionName] !== enabled);
                    this.opts[optionName] = enabled;
                }
                break;
            case "encoding":
                if (SUPPORTED_ENCODINGS[value]) {
                    changed = (this.opts[optionName] !== value);
                    this.opts[optionName] = value;
                } else {
                    err = true;
                }
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
}
