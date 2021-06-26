/*
 * Author: A.G.
 *   Date: 2021.06.26
 */

import Commander from "commander";

const args = (() => {
    Commander
        .option("-c, --config <file>", "load configuration from file (JSON)", "./app/config/default.json")
        .option("-p, --port <n>", "specify network port server listens on", "7778")
        .option("-l, --local", "force bind server to local host", false)
        .option("-m, --mirror <ip>[:<port>]", "mirror remote instance")
        .option("-d, --preload <file>", "preload dictionary with key-values from file")
        .option("-h, --http [<ip>[:<port>]]", "enable REST API server on specified IP-address and port", "0.0.0.0:7780")
        .option("--debug", "enable debug output", false)
        .option("--verbose", "enable detailed output", false)
        .option("--no-console", "suppress any output to console", false)
    ;
    Commander.parse(process.argv);
    return Commander.opts();
})();

export default args;
