/*
 * Author: A.G.
 *   Date: 2021/09/22
 */

import { EventEmitter }  from "events";

export const RPC_CODE_NOT_REGISTERED    = "404";
export const RPC_CODE_GATEWAY_TIMEOUT   = "502";

export class HubRPCDispatcher extends EventEmitter {

    #nextRPCallID = 1; // 0 - invalid.
    #mapProcedureToProvider = {}; // Map(procName=>provider)
    #pendingRPCs = {};
    #rpcTimeout = 10000; // FIXME: Hardcoded.

    debug; // Delegate.

    constructor() {
        super();
    }

    #listUpdated = false;
    #cachedProcedureNames = [];

    listRegistered() { return []; } // Use cached list here?

    dispatchCall(rpc, callback) {
        let hoster = this.#mapProcedureToProvider[rpc.procedureName]; // ClientHandler
        if (hoster) {
            rpc.masqueradedTag = this.#getUniqueRPCallID();
            callback(null, rpc, hoster);
            let timeoutTime = rpc.waitTimeout || this.#rpcTimeout;
            let timeout = setTimeout(this.#onCallTimeout.bind(this), timeoutTime, rpc, callback);
            let obj = this.#pendingRPCs[rpc.masqueradedTag] = { timeout, rpc, caller: rpc.caller, hoster };
            if (this.debug) {
                this.debug(`Call: procedure=${obj.rpc.procedureName} caller=${obj.rpc.caller.id} hoster=${obj.hoster.id} server=${obj.rpc.server.address}`);
            }
        } else {
            callback(RPC_CODE_NOT_REGISTERED);
        }
    }

    dispatchResult(rpc, callback) {
        if (this.#pendingRPCs[rpc.masqueradedTag]) {
            clearTimeout(this.#pendingRPCs[rpc.masqueradedTag].timeout);
            this.#pendingRPCs[rpc.masqueradedTag].tag = this.#pendingRPCs[rpc.masqueradedTag].rpc.tag;
            this.#pendingRPCs[rpc.masqueradedTag].result = rpc.result;
            this.#pendingRPCs[rpc.masqueradedTag].callResult = rpc.callResult;
            let obj = this.#pendingRPCs[rpc.masqueradedTag];
            delete this.#pendingRPCs[rpc.masqueradedTag]; // FIXME: Will this work?
            callback(null, obj, obj.caller); // FIXME: Client should not be there?
            if (this.debug) {
                this.debug(`Dispatch result: procedure=${obj.rpc.procedureName} caller=${obj.rpc.caller.id} hoster=${obj.hoster.id} server=${obj.rpc.server.address}`);
            }
        }
    }

    #onCallTimeout(rpc, callback) {
        if (this.#pendingRPCs[rpc.masqueradedTag]) {
            if (this.#pendingRPCs[rpc.masqueradedTag].rpc === rpc) {
                rpc.callResult = RPC_CODE_GATEWAY_TIMEOUT;
                this.#pendingRPCs[rpc.masqueradedTag].caller.sendRPCResult(rpc);
                let obj = this.#pendingRPCs[rpc.masqueradedTag];
                delete this.#pendingRPCs[rpc.masqueradedTag];
                if (this.debug) {
                    this.debug(`Gateway timeout: procedure=${obj.rpc.procedureName} caller=${obj.rpc.caller.id} hoster=${obj.hoster.id} server=${obj.rpc.server.address}`);
                }
            }
        }
    }

    dropPendingCalls(filter = null) {
        let pendingRPCsMasqueradedTags = Object.keys(this.#pendingRPCs);
        for ( let mt of pendingRPCsMasqueradedTags ) {
            let obj = this.#pendingRPCs[mt];
            if (filter) {
                if (obj.rpc.server !== filter) {
                    continue;
                }
            }
            clearTimeout(obj.timeout);
            delete this.#pendingRPCs[mt];
            if (this.debug) {
                this.debug(`Dropped pending call: procedure=${obj.rpc.procedureName} caller=${obj.rpc.caller.id} hoster=${obj.hoster.id} server=${obj.rpc.server.address}`);
            }
        }
    }

    #unregisterClientsRPCs(client, reason = "") {
        if (reason) {
            reason = `. Reason: ${reason}`;
        }
        let all = Object.keys(this.#mapProcedureToProvider);
        let ownedList = all.filter((procName) => (this.#mapProcedureToProvider[procName] === client));
        ownedList.forEach((procName) => {
            delete this.#mapProcedureToProvider[procName];
            log.debug(`Unregistered RPC: ${procName}${reason}`);
        });
        // TODO: Delete all linked timers.
    }

    #getUniqueRPCallID() { // FIXME: Counter's limit?
        let id = this.#nextRPCallID;
        this.#nextRPCallID++;
        return id;
    }

    exists(procName) {
        return !!this.#mapProcedureToProvider[procName];
    }

    registerProcedure(procName, provider) {
        if (this.exists(procName)) {
            return false;
        }
        this.#mapProcedureToProvider[procName] = provider;
        return true;
    }

    unregisterProcedure(procName) {
        delete this.#mapProcedureToProvider[procName];
    }

    getProvider(procName) {
        return this.#mapProcedureToProvider[procName];
    }

    unregisterProcedureOfProvider(provider) {
        let all = Object.keys(this.#mapProcedureToProvider);
        let ownedList = all.filter((procName) => (this.#mapProcedureToProvider[procName] === provider));
        ownedList.forEach((procName) => {
            delete this.#mapProcedureToProvider[procName];
        });
    }
}
