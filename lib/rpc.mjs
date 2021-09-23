/*
 * Author: A.G.
 *   Date: 2021/09/22
 */

import { EventEmitter }  from "events";
import getTestExpression from "./match.mjs";

export class RPCCall {
    // ...
}

export class RemoteProcedure {
    // ...
}

export class HubRPCDispatcher extends EventEmitter {

    #nextRPCallID = 0;
    #rpcProviders = {};
    #pendingRPCs  = {};
    #rpcTimeout   = 5000;

    constructor() {
        super();
    }

    #listUpdated = false;
    #cachedProcedureNames = [];

    listRegistered() { return []; } // Use cached list here?

    dispatchCall(rpc, callback) {
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

    dispatchResult(rpc, callback) {
        if (this.#pendingRPCs[rpc.masqueradedTag]) {
            clearTimeout(this.#pendingRPCs[rpc.masqueradedTag].timeoutHandle);
            this.#pendingRPCs[rpc.masqueradedTag].tag = this.#pendingRPCs[rpc.masqueradedTag].rpc.tag;
            this.#pendingRPCs[rpc.masqueradedTag].result = rpc.result;
            this.#pendingRPCs[rpc.masqueradedTag].callResult = rpc.callResult;
            let tmp = this.#pendingRPCs[rpc.masqueradedTag];
            delete this.#pendingRPCs[rpc.masqueradedTag]; // FIXME: Will this work?
            callback(null, tmp, tmp.client);
        }
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

    #handleProcedureCallTimeout(rpc) {
        if (this.#pendingRPCs[rpc.masqueradedTag] === rpc) {
            rpc.callResult = "502";
            rpc.client.sendRPCResult(rpc);
            delete this.#pendingRPCs[rpc.masqueradedTag];
        }
    }

    #getUniqueRPCallID() {
        let id = this.#nextRPCallID;
        this.#nextRPCallID++;
        return id;
    }

    exists(procName) {
        return !!this.#rpcProviders[procName];
    }

    registerProcedure(procName, provider) {
        if (this.exists(procName)) {
            return false;
        }
        this.#rpcProviders[procName] = provider;
        return true;
    }

    unregisterProcedure(procName) {
        delete this.#rpcProviders[procName];
    }

    getProvider(procName) {
        return this.#rpcProviders[procName];
    }
}
