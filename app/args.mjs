/*
 * Author: A.G.
 *   Date: 2021/06/26
 */

import { readFileSync } from "fs";
import Commander from "commander";

export const PACKAGE_VERSION = ((() => {
    let version = "n/a";
    try {
        let textFile = readFileSync("package.json").toString("utf8");
        version = JSON.parse(textFile).version;
    } catch (e) {
        console.error(e);
    }
    return version;
})());

const args = (() => {
    Commander.version(PACKAGE_VERSION);
    Commander
        .option("-c, --config <file>",
            "load configuration from file (JSON)", "config/default.json")
        .option("-p, --port <n>",
            "specify network port server listens on", "7778")
        .option("-l, --local",
            "bind server to localhost", false)
        .option("-d, --preload <file>",
            "preload dictionary with key-values from file (.txt; .json; .properties)")
        .option("--debug",
            "enable debug output")
        .option("--verbose",
            "enable detailed output")
        .option("--no-console",
            "suppress any output to console")
    ;
    Commander.parse(process.argv);
    return Commander.opts();
})();

export default args;
