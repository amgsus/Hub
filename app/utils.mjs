/*
 * Author: A.G.
 *   Date: 2021/06/25
 */

import { readFile, createReadStream }                 from 'fs';
import args                                           from './args.mjs';
import { extname as getFileExtension }                from 'path';
import { createInterface as createReadLineInterface } from 'readline';
import { REGEX as KeyValueRegex }                     from './../lib/stream.mjs';

/**
 * Invokes a function "cb" (call is wrapped in try..catch block) if presented.
 * If the callback is not a function or undefined, the call does nothing.
 *
 * @param cb {*}
 * @param args {*}
 * @returns {*}
 */
export function tryInvokeCallback(cb, ...args) {
    if (typeof cb === "function") {
        try {
            return cb(...args);
        } catch (e) {
            console.error(e); // Only for debug.
        }
    }
}

/**
 * Reads file contents and parses them as JSON. In case of invalid JSON, the
 * raised exception is passed as the callback parameter.
 *
 * @param {string} filename
 */
export function readJSONFile(filename) {
    return new Promise((res, rej) => {
        readFile(filename, ((err, data) => {
            if (err) {
                rej(err);
            } else {
                try {
                    let obj = JSON.parse(data.toString(`utf8`));
                    res(obj);
                } catch (err2) {
                    rej(err2);
                }
            }
        }));
    });
}

const rex = new RegExp(/(?:\s*)(?<key>(?<mod>[#$%!~])?(?<id>[^@=]*?))(?:(?<q>\?)?=?|@(?<ts>[-+]?\d+)=)(?:(?<==)(?<value>.*))?(?:\r\n)/, "");

export function importValuesFromFile(eachLine, filename) {
    let ext = getFileExtension(filename).toLowerCase();

    if ([ '.txt', '.json', '.properties' ].indexOf(ext) < 0) {
        throw new Error(`Unsupported file extension: ${getFileExtension(filename)}`);
    }

    function validate(s) {
        let parsed = rex.exec(s);
        if (parsed && parsed.groups.id) {
            if (!parsed.groups.mod && !parsed.groups.q) {
                return {
                    name: parsed.groups.id,
                    value: parsed.groups.value || ''
                };
            } else {
                return `Special not allowed: "${parsed.input.trim()}"`;
            }
        }
        return null;
    }

    return new Promise((res, rej) => {
        let entries = [];
        let ignoredCount = 0;

        if (ext === '.txt' || ext === '.properties') {
            eachLine(filename, (line, last, cb) => {
                let result = true;
                try {
                    let obj = validate(`${line}\r\n`);
                    if (obj) {
                        if (typeof obj === 'string') {
                            ignoredCount++;
                        } else {
                            entries.push(obj);
                        }
                    }
                } catch (eline) {
                    result = false;
                    rej(eline);
                }
                cb(result);
            }, (err) => {
                if (err) {
                    rej(err);
                } else {
                    res({ entries, ignoredCount });
                }
            });
        } else {
            readJSONFile(filename).then((data) => {
                let keys = Object.keys(data);
                for ( let k of keys ) {
                    if (k) {
                        let value = typeof data[k] === 'object' ? JSON.stringify(data[k]) : `${data[k]}`; // Serialize nested object, or force convert to string.
                        let obj = validate(`${k}=${value}\r\n`);
                        if (obj) {
                            if (typeof obj === 'string') {
                                ignoredCount++;
                            } else {
                                entries.push(obj);
                            }
                        }
                    }
                }
                return { entries, ignoredCount };
            }).catch(rej).then(res);
        }
    });
}

export function isModuleNotFound(error) {
    return error.code === "ERR_MODULE_NOT_FOUND";
}
