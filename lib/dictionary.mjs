/*
 * Author: A.G.
 *   Date: 2021/09/22
 */

import { EventEmitter }   from "events";

export class StoredValue {
    #key;
    value;
    ts;
    subscribers = [];

    constructor(key, value = null, ts = null) {
        this.key = key;
        this.value = value;
        this.ts = ts;
    }

    static isInstance(obj) { return obj instanceof StoredValue; }

    toString() {
        return `${this.key}=${this.value}`;
    }

    get key() { return this.#key; }

    set key(value) { this.#key = value; }

    get name() { return this.key; }

    set name(value) { this.key = value; }

    get keyName() { return this.key; }

    set keyName(value) { this.key = value; }

    get id() { return this.key; }

    set id(value) { this.key = value; }
}

export class HubDictionary extends EventEmitter {

    #map = {}; // HashMap: KeyName -> StoredValue.
    #dictionary = []; // Keep in-sync with map.

    get allEntries() { return this.#dictionary; }

    get length() { return this.#dictionary.length; }

    get(keyName) {
        return this.#map[keyName];
    }

    exists(keyName) {
        return !!this.#map[keyName];
    }

    createValue(keyName, value = "") {
        let entry = new StoredValue(keyName, value, null);
        this.#map[keyName] = entry;
        this.#dictionary.push(entry);
        this.emit("create", entry);
        return entry;
    }

    getOrCreateEntry(keyName, callback) {
        if (typeof callback === "function") {
            let exists = this.exists(keyName);
            callback(this.getOrCreateEntry(keyName), exists); // callback(entry,existing)
        } else {
            if (!this.exists(keyName)) {
                return this.createValue(keyName);
            }
            return this.get(keyName);
        }
    }

    deleteValue(keyName) {
        keyName = (keyName || "").trim();
        if (keyName) {
            let i = this.#dictionary.findIndex((obj) => (obj.name === keyName));
            if (i >= 0) {
                let entry = this.#dictionary[i];
                this.#dictionary.splice(i, 1);
                delete this.#map[keyName];
                this.emit("delete", entry);
                return true;
            }
        }
        return false;
    }

    updateValue(keyName, value, ts = null, sender = null) {
        let entry = this.getOrCreateEntry(keyName);
        entry.value = value;
        this.emit("update", entry, sender);
        return entry;
    }

    addSubscriber(subscriber, subscriptionRegex) {
        if (subscriptionRegex) {
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

    filter(regExp, excludeUnassignedValues = false) {
        return this.allEntries.filter((ent) => regExp.test(ent.name) && (!excludeUnassignedValues || ent.value !== null));
    }
}
