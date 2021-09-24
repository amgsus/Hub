/*
 * Author: A.G.
 *   Date: 2021/09/22
 */

import { EventEmitter } from "events";

export class Entry {
    key = "";
    value = "";
    ts = null;
    subscribers = [];

    constructor(key, value = "", ts = null) {
        this.key = key;
        this.value = value;
        this.ts = ts;
    }

    static isEntry(obj) { return obj instanceof Entry; }

    toString() {
        return `${this.key}=${this.value}`;
    }

    get path() { return this.key; }

    set path(value) { this.key = value; }

    get name() { return this.key; }

    set name(value) { this.key = value; }
}

export class HubDictionary extends EventEmitter {

    #variablesMap = {}; // hash-table [path -> entry]
    #dictionary = []; // Array-Mirror for variablesMap values (for easier iterating over variables)

    trace = null;

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

    createValue(keyName, value = "") {
        let entry = new Entry(keyName, value, null);
        this.#variablesMap[keyName] = entry;
        this.#dictionary.push(entry);
        this.emit("create", entry);
        return entry;
    }

    getOrCreateEntry(keyName) {
        if (!this.exists(keyName)) {
            return this.createValue(keyName);
        }
        return this.#variablesMap[keyName];
    }

    deleteValue(keyName) {
        keyName = (keyName || "").trim();
        if (keyName) {
            let i = this.#dictionary.findIndex((obj) => (obj.path === keyName));
            if (i >= 0) {
                let entry = this.#dictionary[i];
                this.#dictionary.splice(i, 1);
                delete this.#variablesMap[keyName];
                this.emit("delete", entry);
                return true;
            }
        }
        return false;
    }

    updateValue(name, value, ts = null) {
        let entry = this.getOrCreateEntry(name);
        entry.value = value;
        this.emit("update", entry);
        return entry;
    }

    addSubscriber(subscriber, subscriptionRegex) {
        for ( let ent of this.#dictionary ) {
            if (subscriptionRegex.test(ent.name)) {
                if (ent.subscribers.indexOf(subscriber) < 0) {
                    ent.subscribers.push(subscriber);
                    this.emit("addSubscriber", {
                        subscriber,
                        entry: ent
                    });
                }
            }
        }
    }

    removeSubscriber(subscriber) {
        for ( let ent of this.#dictionary ) {
            let index;
            if (( index = ent.subscribers.indexOf(subscriber) ) >= 0) {
                ent.subscribers.splice(index, 1);
                this.emit("removeSubscriber", {
                    subscriber,
                    entry: ent
                });
            }
        }
    }
}
