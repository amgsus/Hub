/*
 * By:              A.G.
 * Created on:      2020.07.19
 * Last modified:   2020.07.19
 */

import Commander from "commander";

const args = (() => {
    Commander
        .option("-c, --config <fileName>", "sets a configuration file to use")
        .option("-p, --port <n>", "sets server listening port")
        .option("-l, --local", "forces IP binding to 127.0.0.1 (localhost)", false)
        .option("--debug", "enables printing of debug/trace information (aka developer mode)", false)
    ;
    Commander.parse(process.argv);
    return Commander.opts();
})();

export default args;
