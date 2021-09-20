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

    id;
    clientName = "";
    remoteAddress;
    notifyExpression;
    timestampFormat;
    #registeredRPCs = [];
    #rpcWhitelist   = {};
    #parser         = null;
    #maxBufferSize  = 4096;
    #txQueue        = []; // can be 'none', 'abs', and 'rel'// caching remote address, because 'connection' destroys this info after closing
    #commands;
    #socket;

    constructor(id, socket, notify, tsFormat) {
        super();
        this.id               = id;
        this.remoteAddress    = socket.remoteAddress + ":" + socket.remotePort;
        this.notifyExpression = NotifyExpression(notify);
        this.timestampFormat  = tsFormat || "none";
        this.#socket          = socket;
        this.#parser          = new ClientStreamParser(this.#socket);
        this.#parser.on("data", this.#handle.bind(this));
        this.#socket.setNoDelay(false); // enable Nagle's algorithm to combine small packets before sending
        this.#socket.on("close", this.#__onDisconnect.bind(this));
        this.#socket.on("error", this.emit.bind(this, "error"));

        this.#commands = Object.seal({
            list:       new Command(this.#onList.bind(this)),
            fetch:      new Command(this.#onFetch.bind(this), "fetch"),
            dump:       new Command(this.#onDump.bind(this), "dump"),
            delete:     new Command(this.#onDeleteKey.bind(this), "delete"),
            rpc:        new Command(this.#onRPCCall.bind(this), "rpc"),
            result:     new Command(this.#onRPCResult.bind(this), "rpc"),
            mask:       new Command(this.#onNotificationMaskSet.bind(this)),
            regex:      new Command(this.#onNotificationRegexSet.bind(this), "regex"),
            timestamp:  new Command(this.#onTimestampFormatSet.bind(this)),
            identify:   new Command(this.#onIdentify.bind(this), "identify"),
            regrpc:     new Command(this.#onRPCRegister.bind(this), "rpc"),
            unregrpc:   new Command(this.#onRPCUnregister.bind(this), "rpc"),
            listrpc:    new Command(this.#onRPCList.bind(this), "rpc"),
            online:     new Command(this.#onListOnline.bind(this), "online"),
            atomic:     null // TODO: Accepts JSON object where field names are keys, and value can be either string, or JSON object {value,ts}.
        });
    }

    get socket() { return this.#socket; }

    get alive() { return this.socket !== null; }

    get idString() { return `Client ${this.remoteAddress} (ID ${this.id})`; }

    disconnect() {
        if (this.socket) {
            this.socket.destroy();
        }
    }

    #__onDisconnect() {
        this.#socket = null;
        this.#parser.removeAllListeners();
        this.emit("disconnect");
    }

    #__doWrite() {
        if (!this.alive) {
            this.#txQueue = [];
            return;
        }
        if (this.#txQueue.length === 0) {
            return;
        }
        this.#socket.write(this.#txQueue.join(""), this.#__doWrite.bind(this)); // TODO: Was __scheduleWrite.
        this.#txQueue = [];
    }

    #__scheduleWrite() { setImmediate(this.#__doWrite.bind(this)); }

    #isFeatureEnabled(featureName) {
        return true; // TODO: Presented in config file.
    }

    /**
     * Writes text to the buffer. Should not be called directly.
     * @param text {string}
     */
    write(text) {
        if (this.#txQueue.length === 0) {
            this.#__scheduleWrite();
        }
        this.#txQueue.push(text);
        if (this.#txQueue.length > this.#maxBufferSize) {
            this.#txQueue.shift();
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

    notify(topic) { // TODO: Any usages???
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
        let command = this.#getCommandByNameOrAlias(data.key);
        if (command) {
            if (command.feature) {
                if (this.#isFeatureEnabled(command.feature)) {
                    command.exec(data.value, data);
                }
            }
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

    #onNotificationRegexSet(pattern) {
        pattern = (pattern || "").trim();
        this.emit("regex", new RegExp(pattern));
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

    #onIdentify(param) {
        let name = (param || "").trim();
        if (name !== this.clientName) {
            this.clientName = name;
            this.emit("identify", this.clientName);
        }
    }

    #onDeleteKey(param) {
        let topicName = (param || "").trim();
        if (topicName) {
            this.emit("delete", topicName);
        }
    }

    #onList(pattern) {
        this.emit("list", (pattern || "").trim());
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
            let { groups } = ((() => (RPC_REGEX.exec(param) || { groups: {} }))()); // In-place.
            if (groups.tag) { // Filter invalid.
                this.emit("rpc", {
                    tag: groups.tag,
                    procName: groups.procName,
                    args: groups.argString // Do nothing with it (as it is).
                });
            }
        }
    }

    #onRPCRegister(name) {
        this.emit("registerRPC", name);
        this.#registeredRPCs.push(name);
    }

    #onRPCUnregister(name) {
        let i = this.#registeredRPCs.indexOf(name);
        if (i < 0) return;
        this.#registeredRPCs.splice(i, 1); // Delete it from array.
        this.emit("unregisterRPC", name);
    }

    #onRPCList(pattern) {
        pattern = (pattern || "").trim();
        this.emit("listRPCs", pattern || "*");
    }

    #onRPCResult(raw) {
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

    #getCommandByNameOrAlias(commandName) {
        let resolvedName = COMMAND_ALIASES[commandName] || commandName;
        return this.#commands[resolvedName] || null;
    }

    // /**
    //  * Context help handler.
    //  * @param command {string} - Command name or empty string.
    //  */
    // __help(command) {
    //     let man = "";
    //     switch (command) {
    //         case "regrpc":
    //             man = "<procName>: registers remote procedure for this connection";
    //             break;
    //         case "unregrpc":
    //             man = "<procName>: unregisters remote procedure previously registered on this connection";
    //             break;
    //         case "listrpc":
    //             man = "[<mask>]: list all remote procedures that are currently registered on Hub";
    //             break;
    //         case "rpc":
    //             man = "<tag> <procName> [<arg0> ... <argN>]: calls a remote procedure";
    //             break;
    //         case "result":
    //             man = "<tag> <errorCode> [<data>]: returns a result for a procedure call";
    //             break;
    //         case "delete":
    //             man = "<name>: deletes any value from Hub, non-restricted";
    //             break;
    //         case "direct":
    //             man = "<id> <topic> <value>: writes value directly (without caching) to identified client";
    //             break;
    //         case "format":
    //             man = "[plaintext|json]: selects the format of a response for commands";
    //             break;
    //         case "atomic":
    //             man = "<json>: atomic processing of values (input is JSON object)"
    //             break;
    //         // TODO: Add manual.
    //         default:
    //             man = Object.keys(this.#commands).sort().join(' ');
    //             break;
    //     }
    //     this.write(`#help=${command} ${man}${EOL}`)
    // }
}
