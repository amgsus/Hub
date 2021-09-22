/*
 * Author: A.G.
 *   Date: 2021/09/22
 */

import { EventEmitter } from "events";

export class Entry {
    path = "";
    value = "";
    ts = null;
    subscribers = [];

    constructor(path, value = "", ts = null) {
        this.path = path;
        this.value = value;
        this.ts = ts;
    }

    static isEntry(obj) { return obj instanceof Entry; }
}

export class HubDictionary extends EventEmitter {

    #variablesMap = {}; // hash-table [path -> entry]
    #dictionary = []; // Array-Mirror for variablesMap values (for easier iterating over variables)

    constructor() {
        super();
    }

    get entries() { return this.#dictionary; }

    get length() { return this.#dictionary.length; }

    get(keyName) {
        return this.#variablesMap[keyName];
    }

    exists(keyName) {
        return !!this.#variablesMap[keyName];
    }

    createEntry(keyName, value = "") {
        let entry = new Entry(keyName, value, null);
        this.#variablesMap[keyName] = entry;
        this.#dictionary.push(entry);
        return entry;
    }

    getOrCreateEntry(keyName) {
        if (!this.exists(keyName)) {
            return this.createEntry(keyName);
        }
        return this.#variablesMap[keyName];
    }

    deleteValue(keyName) {
        keyName = (keyName || "").trim();
        if (keyName) {
            let i = this.#dictionary.findIndex((obj) => (obj.path === keyName));
            if (i >= 0) {
                this.#dictionary.splice(i, 1);
                delete this.#variablesMap[keyName];
                return true;
            }
        }
        return false;
    }

    updateValue(name, value, notifySubscribers = true) {
        let entry = this.getOrCreateEntry(name);
        entry.value = value;
        return entry;
    }

    addSubscriber(regexp, subscriber) {
        for (let i = 0, len = this.#dictionary.length; i < len; i += 1) {
            let entry = this.#dictionary[i];
            if (regexp.test(entry.path)) {
                entry.subscribers.push(subscriber);
            }
        }
    }

    removeSubscriber(subscriber) {
        let index;
        for (let i = 0, len = this.#dictionary.length; i < len; i += 1) { // FIXME: Dictionary.
            let subscribers = this.#dictionary[i].subscribers;
            if ((index = subscribers.indexOf(subscriber)) !== -1) {
                subscribers.splice(index, 1);
            }
        }
    }
}
