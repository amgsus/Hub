/*
 * Author: A.G.
 *   Date: 2021/09/22
 */

import { EventEmitter }  from "events";
import getTestExpression from "./match.mjs";

export class RPCDispatcher extends EventEmitter {

    #nextRPCallID = 0;
    #rpcProviders = {};
    #pendingRPCs = {};
    #rpcTimeout = 5000;

    constructor() {
        super();
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

    #getUniqueRPCallID() {
        let id = this.#nextRPCallID;
        this.#nextRPCallID++;
        return id;
    }
}
