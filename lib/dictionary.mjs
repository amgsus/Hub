/*
 * Author: A.G.
 *   Date: 2021/09/19
 */

export class Entry {
    path = "";
    value = "";
    ts = null;
    subscribers = [];

    constructor(path, value, ts) {
        this.path = path;
        this.value = value;
        this.ts = ts;
    }
}

export class Dictionary {
    #dataMap; // Maps key to object.

    create() {}
    update() {}
    exists() {}
}
