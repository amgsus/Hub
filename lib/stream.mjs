/*
 * By:              A.G.
 * Created on:      2019.12.10
 * Last modified:   2020.07.19
 */

import Stream from "stream";

export const REGEX = new RegExp(/(?:\s*)(?<key>(?<mod>[#$%!~])?(?<id>[^@=]*?))(?:(?<q>\?)?=?|@(?<ts>[-+]?\d+)=)(?:(?<==)(?<value>.*))?(?:\r\n)/, "g");
export const EMPTY_DATA = Object.freeze({ key: "", mod: null, id:"", q: false, ts: null, value: "" });

export class ClientStreamParser extends Stream.Transform {

    /**
     * @param connection {Stream}
     */
    constructor(connection) {
        super({
            objectMode: true
        });
        this.data = "";
        if (connection) {
            this.connection = connection;
            connection.pipe(this);
        }
    }

    _transform(chunk, encoding, cb) {
        this.data += (chunk instanceof Buffer ? chunk.toString() : chunk);
        let matches = this.data.matchAll(REGEX);
        let lastIndex = 0;
        for ( let m of matches ) {
            let packet = Object.assign({}, EMPTY_DATA, removeUndefines(m.groups));
            this.push(packet);
            lastIndex = m.index + m.input.length;
        }
        this.data = this.data.slice(lastIndex);
        cb();
    }

    _flush(cb) {
        this.data = "";
        cb();
    }
}

function removeUndefines(obj) {
    let cleanOne = Object.entries(obj).filter((e) => (typeof e[1] !== "undefined"));
    return Object.fromEntries(cleanOne);
}
