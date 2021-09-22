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

export class RPCDispatcher extends EventEmitter {

    #nextRPCallID = 0;
    #rpcProviders = {};
    #pendingRPCs  = {};
    #rpcTimeout   = 5000;

    constructor() {
        super();
    }

    dispatchCall() {

    }

    dispatchResult(rpc) {
        if (this.#pendingRPCs[rpc.masqueradedTag]) {
            clearTimeout(this.#pendingRPCs[rpc.masqueradedTag].timeoutHandle);
            this.#pendingRPCs[rpc.masqueradedTag].tag = this.#pendingRPCs[rpc.masqueradedTag].rpc.tag;
            this.#pendingRPCs[rpc.masqueradedTag].result = rpc.result;
            this.#pendingRPCs[rpc.masqueradedTag].callResult = rpc.callResult;
            this.#pendingRPCs[rpc.masqueradedTag].client.sendRPCResult(this.#pendingRPCs[rpc.masqueradedTag]);
            delete this.#pendingRPCs[rpc.masqueradedTag];
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
}
