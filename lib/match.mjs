/*
 * Author: A.G.
 *   Date: 2019/11/25
 */

import { EventEmitter } from "events";

/**
 * @emits cache
 * @emits cleanup
 */
export class HubMatcher extends EventEmitter {
    static testNotificationMask(client, testValue) {
        if (client.listensAll) {
            return true;
        } else {
            return client.notificationRegExp ? client.notificationRegExp.test(testValue) : false;
        }
    }

    static filterClientsWithMatchedNotificationMask(clients, value) {
        return clients.filter((client) => {
            return HubMatcher.testNotificationMask(client, value);
        });
    }

    #cache = {};

    constructor() {
        super();
        this.#initPredefinedRegExps();
    }

    #initPredefinedRegExps() {
        this.#cache[""] = new RegExp("$^");
        this.#cache["*"] = new RegExp("^.+$");
    }

    cleanup() {
        this.#cache = {};
        this.#initPredefinedRegExps();
        this.emit("cleanup");
    }

    get cache() { return this.#cache; }

    getOrCreateCachedNotificationRegExp(wildcard) {
        let regex = this.#cache[wildcard];
        if (!regex) {
            let expr = wildcard
                .replace(/[^\w\s\*]/g, '\\$&') // prefix every non-(alpha|digit|'*'|' ') with '\'
                .replace(/\*/g, '.*') // replace '*' with '.*' pattern (any non-space symbol any number of times)
                .replace(/\?/g, '.?') // Single character match.
                .replace(/\S+/g, '^$&$') // add beginline-'^' and endline-'$' conditions to expessions
                .replace(/\s+/g, '|'); // replace spaces with '|' (OR)
            regex = new RegExp(expr);
            this.#cache[wildcard] = regex; // storing regex to cache
            setImmediate(() => {
                this.emit("cache", wildcard);
            });
        }
        return regex;
    }

    static #singleton = new HubMatcher();

    static getSingleton() { return this.#singleton; }
}
