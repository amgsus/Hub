/*
 * Author: A.G.
 *   Date: 2021/09/19
 */

export function popCallback(args) {
    let callback = null;
    if (args.length > 0) {
        if (typeof args[args.length - 1] === "function") {
            callback = args[args.length - 1];
        }
    }
    return {
        args: callback ? args.slice(0, -1) : args,
        callback
    };
}

export function isDefined(x) {
    return x || typeof x !== "undefined";
}

export function toNumber(input, callback) {
    let n = Number(input);
    if (typeof callback === "function") {
        return callback(n);
    }
    return n;
}

export function createPromiseBasedOn(func) {
    return new Promise((resolve, reject) => {
        func((err, ...args) => {
            if (err) return reject(err);
            resolve(...args);
        })
    });
}

export function getStringOrEmpty(x) {
    return x || "";
}

export function validateClientName(s) {
    return true; // TODO
}

export function arrayDeleteItem(arr, item) {
    let index = arr.indexOf(item);
    if (index >= 0) {
        arr.splice(index, 1);
    }
    return index >= 0;
}

export function arrayPushItemUnique(arr, item) {
    let index = arr.indexOf(item);
    if (index < 0) {
        arr.push(item);
    }
    return index < 0;
}
