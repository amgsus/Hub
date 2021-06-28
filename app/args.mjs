/*
 * Author: A.G.
 *   Date: 2021.06.26
 */

import { readFileSync } from "fs";
import Commander from "commander";

export const PACKAGE_VERSION = ((() => {
    let text = readFileSync(`package.json`).toString(`utf8`);
    return JSON.parse(text).version;
})());

const args = (() => {
    Commander.version(PACKAGE_VERSION);
    Commander
        .option("-c, --config <file>", "load configuration from file (JSON)", "./app/config/default.json")
        .option("-p, --port <n>", "specify network port server listens on", "7778")
        .option("-l, --local", "force bind server to local host", false)
        .option("-m, --mirror <ip>[:<port>]", "mirror remote instance")
        .option("-d, --preload <file>", "preload dictionary with key-values from file")
        .option("-h, --http [<ip>[:<port>]]", "enable REST API server on specified IP-address and port")
        .option("--debug", "enable debug output")
        .option("--verbose", "enable detailed output")
        .option("--no-console", "suppress any output to console")
    ;
    Commander.parse(process.argv);
    return Commander.opts();
})();

export default args;
