/*
 * Author: A.G.
 *   Date: 2021.06.29
 */

import { readFileSync }                     from "fs";
import args, { PACKAGE_VERSION as version } from "./args.mjs";

const MERGED_CONFIGURATION = ((() => { // This block is not called, when version is requested from command line.
    let plainText = readFileSync(args.config).toString(`utf8`);
    let config = JSON.parse(plainText);
    return Object.assign({}, config, args, { version }); // Command line overrides configuration from file.
})());

export default MERGED_CONFIGURATION;
