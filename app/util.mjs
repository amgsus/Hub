/*
 * Hub
 *
 * By:          A.G.
 * Created:     2021.06.25
 * Modified:    2021.06.25
 */

import { readFile, createReadStream }                 from 'fs';
import args                                           from './args.mjs';
import { extname as getFileExtension }                from 'path';
import { createInterface as createReadLineInterface } from 'readline';
import { eachLine }                                   from 'line-reader';
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

export function loadDic(filename) {
    let ext = getFileExtension(filename).toLowerCase();

    if ([ '.txt', '.json' ].indexOf(ext) < 0) {
        throw new Error(`Unsupported file extension: ${getFileExtension(filename)}`);
    }

    return new Promise((res, rej) => {
        let entries = [];

        if (ext === '.txt') {
            eachLine(filename, (line, last, cb) => {
                console.log(line);
                try {
                    let parsed = rex.exec(`${line}\r\n`);
                    console.log(parsed);
                    if (parsed && parsed.groups.id) {
                        if (!parsed.groups.mod && !parsed.groups.q) {
                            entries.push({
                                name: parsed.groups.id,
                                value: parsed.groups.value || ''
                            });
                        }
                    }
                } catch (eline) {
                    console.error(eline);
                    rej(eline);
                    cb(false);
                    return;
                }
                //if (last) res(entries);
                cb(true);
            }, (err) => {
                if (err) {
                    rej(err);
                } else {
                    res(entries);
                }
            });
        } else {
            readJSONFile(filename).then((data) => {
                let keys = Object.keys(data);
                for ( let k of keys ) {
                    if (k) {
                        let value = typeof data[k] === 'object' ? JSON.stringify(data[k]) : `${data[k]}`;
                        entries.push({
                            name: k,
                            value: value
                        });
                    }
                }
                return entries;
            }).catch(rej).then(res);
        }
    });
}
