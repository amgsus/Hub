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
